import { z } from 'zod';
import { raw } from 'express';
import { logger } from '@librechat/data-schemas';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  LOCAL_FILES_EVENT,
  LOCAL_FILES_HEADER,
  LOCAL_FILES_VERSION,
  localFilesConfigSchema,
  localFilesRootSchema,
  localFilesResultSchema,
  localFilesFormat,
  localFilesDocument,
  localFilesInputSchema,
} from 'librechat-data-provider';
import type {
  Agents,
  LocalFilesRoot,
  LocalFilesSession,
  LocalFilesConfig,
  LocalFilesCommand,
  LocalFilesResult,
  LocalFilesInput,
} from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { Keyv } from 'keyv';
import type { LocalFilesReader } from './reader';
import type { LocalFilesWriter } from './writer';
import type { FlowLease } from '~/flow/manager';
import type { ServerRequest } from '~/types';
import { FlowStateManager, FLOW_MONITOR_SETTLED } from '~/flow/manager';
import { getSafeErrorMetadata } from '~/utils/errors';

export interface LocalFilesPrincipal {
  id: string;
  tenantId?: string;
}
interface Session {
  id: string;
  principal: LocalFilesPrincipal;
  conversationId: string;
  root: LocalFilesRoot;
  tokenHash: string;
}
interface Pending {
  sessionId: string;
  createdAt: number;
  expiresAt: number;
  read?: Extract<LocalFilesInput, { operation: 'read' }>;
  maximum: number;
}
const principalSchema = z.object({ id: z.string().min(1), tenantId: z.string().optional() });
const registration = z
  .object({
    version: z.literal(LOCAL_FILES_VERSION),
    conversationId: z.uuid(),
    root: localFilesRootSchema,
  })
  .strict();
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const key = (id: string): string => `local-files:session:${id}`;
const pendingKey = (id: string): string => `local-files:request:${id}`;
export const localFilesFailure = (
  code: Extract<LocalFilesResult, { ok: false }>['error']['code'],
): LocalFilesResult => ({ ok: false, error: { code } });

export function localFilesAvailable(config: AppConfig | undefined): boolean {
  return (
    config?.config?.localFiles?.enabled === true &&
    (config.config.localFiles.requireReview === false ||
      config.endpoints?.agents?.toolApproval?.enabled === true)
  );
}

export function localFilesCapabilities(config: AppConfig | undefined): {
  localFiles?: LocalFilesConfig & { version: typeof LOCAL_FILES_VERSION; available: boolean };
} {
  if (config?.config?.localFiles?.enabled !== true) return {};
  return {
    localFiles: {
      ...localFilesConfigSchema.parse(config.config.localFiles),
      version: LOCAL_FILES_VERSION,
      available: localFilesAvailable(config),
    },
  };
}

/** The store and request transport are supplied by the host; this service never opens host files. */
export function createLocalFilesService({
  store,
  read,
  write,
}: {
  store: Keyv;
  read?: LocalFilesReader;
  write?: LocalFilesWriter;
}): LocalFilesService {
  // The protocol bounds a request to five minutes. Effective deployments may set a shorter deadline.
  const flows = new FlowStateManager<LocalFilesResult>(store, { ttl: 300000 });
  const waiters = new Map<string, (result: LocalFilesResult) => void>();
  const owns = (
    session: Session,
    principal: LocalFilesPrincipal,
    conversationId?: string,
  ): boolean =>
    session.principal.id === principal.id &&
    session.principal.tenantId === principal.tenantId &&
    (conversationId == null || session.conversationId === conversationId);

  async function get(
    id: string,
    principal: LocalFilesPrincipal,
    conversationId?: string,
  ): Promise<Session | undefined> {
    if (!z.uuid().safeParse(id).success) return;
    const session = await store.get<Session>(key(id));
    return session && owns(session, principal, conversationId) ? session : undefined;
  }
  async function authorized(req: Request): Promise<Session | undefined> {
    const principal = principalSchema.safeParse(req.user);
    if (!principal.success || typeof req.params.id !== 'string') return;
    const session = await get(req.params.id, principal.data);
    const token = req.get(LOCAL_FILES_HEADER);
    if (!session || !token || token.length > 256) return;
    return timingSafeEqual(Buffer.from(hash(token), 'hex'), Buffer.from(session.tokenHash, 'hex'))
      ? session
      : undefined;
  }

  async function invoke({
    principal,
    sessionId,
    command,
    config,
    send,
    signal,
  }: {
    principal: LocalFilesPrincipal;
    sessionId: string;
    command: Omit<LocalFilesCommand, 'id' | 'expiresAt' | 'version' | 'rootId' | 'sessionId'>;
    config: LocalFilesConfig;
    send: (command: LocalFilesCommand) => void | Promise<void>;
    signal: AbortSignal;
  }): Promise<LocalFilesResult> {
    const session = await get(sessionId, principal, command.conversationId);
    if (!session) return localFilesFailure('UNAVAILABLE');
    if (
      command.input.operation !== 'list' &&
      command.input.operation !== 'read' &&
      session.root.access !== 'readwrite'
    ) {
      return localFilesFailure('PERMISSION_DENIED');
    }
    const id = randomUUID();
    const expiresAt = Date.now() + config.requestTimeoutMs;
    await flows.initFlow(id, 'local_files', { sessionId, state: id });
    const flow = await flows.getFlowState(id, 'local_files');
    if (!flow) throw new Error('Local file request was not persisted');
    await store.set(
      pendingKey(id),
      {
        sessionId,
        createdAt: flow.createdAt,
        expiresAt,
        maximum: config.maxOutputBytes,
        ...(command.input.operation === 'read' ? { read: command.input } : {}),
      } satisfies Pending,
      config.requestTimeoutMs,
    );
    const timeout = AbortSignal.timeout(config.requestTimeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const monitor = new AbortController();
    const local = new Promise<LocalFilesResult>((resolve) => waiters.set(id, resolve));
    const event: LocalFilesCommand = {
      ...command,
      id,
      sessionId,
      rootId: session.root.id,
      version: LOCAL_FILES_VERSION,
      expiresAt,
    };
    const cancel = () => {
      void Promise.resolve()
        .then(() => send({ ...event, cancelled: true }))
        .catch((error: unknown) =>
          logger.error('[Local files] Cancellation delivery failed', getSafeErrorMetadata(error)),
        );
    };
    combined.addEventListener('abort', cancel, { once: true });
    try {
      combined.throwIfAborted();
      const publication = Promise.resolve()
        .then(() => send(event))
        .then(() => local);
      return await Promise.race([
        local,
        publication,
        flows.createFlow(id, 'local_files', {}, AbortSignal.any([combined, monitor.signal]), false),
      ]);
    } catch (error) {
      if (combined.aborted) return localFilesFailure(signal.aborted ? 'CANCELLED' : 'TIMEOUT');
      throw error;
    } finally {
      combined.removeEventListener('abort', cancel);
      waiters.delete(id);
      monitor.abort(FLOW_MONITOR_SETTLED);
      await store.delete(pendingKey(id));
      await flows.deleteFlow(id, 'local_files');
    }
  }

  function router() {
    async function handle(
      req: Request & { config?: AppConfig },
      res: Response,
      action: string,
    ): Promise<void> {
      let lease: FlowLease | null = null;
      const principal = principalSchema.safeParse(req.user);
      if (!principal.success) {
        res.status(401).json({ code: 'UNAUTHORIZED' });
        return;
      }
      try {
        const config = req.config;
        if (!localFilesAvailable(config)) {
          res.status(403).json({ code: 'UNAVAILABLE' });
          return;
        }
        const settings = localFilesConfigSchema.parse(config?.config?.localFiles);
        if (action === 'create') {
          const parsed = registration.safeParse(req.body);
          if (!parsed.success) {
            res.status(400).json({ code: 'INVALID_REQUEST' });
            return;
          }
          const id = randomUUID();
          const token = randomUUID() + randomUUID();
          const session: Session = {
            id,
            principal: principal.data,
            conversationId: parsed.data.conversationId,
            root: parsed.data.root,
            tokenHash: hash(token),
          };
          await store.set(key(id), session, settings.sessionTtlMs);
          res.status(201).json({
            id,
            token,
            root: session.root,
            config: settings,
            version: LOCAL_FILES_VERSION,
          } satisfies LocalFilesSession);
          return;
        }
        const current = await authorized(req);
        if (!current) {
          res.status(404).json({ code: 'UNAVAILABLE' });
          return;
        }
        if (action === 'render') {
          if (!write) {
            res.status(503).json({ code: 'UNAVAILABLE' });
            return;
          }
          if (current.root.access !== 'readwrite') {
            res.status(403).json({ code: 'PERMISSION_DENIED' });
            return;
          }
          const parsed = localFilesInputSchema.safeParse(req.body);
          if (!parsed.success || parsed.data.operation !== 'write') {
            res.status(400).json({ code: 'INVALID_REQUEST' });
            return;
          }
          if (!localFilesDocument(parsed.data.path) || parsed.data.encoding === 'base64') {
            res.status(422).json({ code: 'UNSUPPORTED_FORMAT' });
            return;
          }
          const controller = new AbortController();
          const cancelled = () => controller.abort();
          res.once('close', cancelled);
          let result: LocalFilesResult;
          try {
            result = await write({
              input: parsed.data,
              config: settings,
              signal: AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(settings.extractionTimeoutMs),
              ]),
            });
          } finally {
            res.removeListener('close', cancelled);
          }
          if (!(await authorized(req))) {
            res.status(404).json({ code: 'UNAVAILABLE' });
            return;
          }
          if (!result.ok) {
            const code = result.error.code;
            let status = 422;
            if (code === 'TOO_LARGE') status = 413;
            else if (code === 'PROCESSOR_BUSY') status = 503;
            else if (code === 'TIMEOUT') status = 504;
            res.status(status).json({ code });
            return;
          }
          res.json(result);
          return;
        }
        lease = await flows.acquireLease(`local-files-session:${current.id}`, {
          leaseMs: settings.sessionTtlMs,
          waitMs: settings.requestTimeoutMs,
        });
        if (!lease) {
          res.status(503).json({ code: 'UNAVAILABLE' });
          return;
        }
        const session = await authorized(req);
        if (!session) {
          res.status(404).json({ code: 'UNAVAILABLE' });
          return;
        }
        if (action === 'heartbeat') {
          await store.set(key(session.id), session, settings.sessionTtlMs);
          res.sendStatus(204);
          return;
        }
        if (action === 'remove') {
          await store.delete(key(session.id));
          res.sendStatus(204);
          return;
        }
        const requestId = req.params.requestId;
        if (typeof requestId !== 'string' || !z.uuid().safeParse(requestId).success) {
          res.status(400).json({ code: 'INVALID_REQUEST' });
          return;
        }
        const pending = await store.get<Pending>(pendingKey(requestId));
        if (!pending || pending.sessionId !== session.id || pending.expiresAt <= Date.now()) {
          res.status(409).json({ code: 'REVIEW_EXPIRED' });
          return;
        }
        let result: LocalFilesResult;
        if (req.headers?.['content-type']?.split(';')[0] === 'application/octet-stream') {
          if (!read || !pending.read || !localFilesFormat(pending.read.path)) {
            res.status(400).json({ code: 'INVALID_REQUEST' });
            return;
          }
          // Uploads and extraction must not hold off heartbeats or disconnection.
          await lease.release();
          lease = null;
          const error: unknown = await new Promise((resolve) => {
            raw({ type: 'application/octet-stream', limit: settings.maxFileBytes })(
              req,
              res,
              (failure?: unknown) => resolve(failure),
            );
          });
          if (error || !Buffer.isBuffer(req.body)) {
            res.status(413).json({ code: 'TOO_LARGE' });
            return;
          }
          result = await read({
            input: pending.read,
            data: req.body,
            config: {
              ...settings,
              maxOutputBytes: Math.min(settings.maxOutputBytes, pending.maximum),
            },
            signal: AbortSignal.timeout(Math.max(1, pending.expiresAt - Date.now())),
          });
          lease = await flows.acquireLease(`local-files-session:${session.id}`, {
            leaseMs: settings.sessionTtlMs,
            waitMs: settings.requestTimeoutMs,
          });
          if (!lease || !(await authorized(req))) {
            res.status(404).json({ code: 'UNAVAILABLE' });
            return;
          }
        } else {
          const parsed = localFilesResultSchema.safeParse(req.body);
          if (
            !parsed.success ||
            (parsed.data.ok &&
              (parsed.data.value.binary != null ||
                parsed.data.value.images != null ||
                Buffer.byteLength(parsed.data.value.content ?? '', 'utf8') >
                  settings.maxTextBytes ||
                (parsed.data.value.entries?.length ?? 0) > settings.pageSize))
          ) {
            res.status(400).json({ code: 'INVALID_REQUEST' });
            return;
          }
          result = parsed.data;
        }
        const completed = await flows.completeFlowIfCurrent(
          requestId,
          'local_files',
          pending.createdAt,
          requestId,
          result,
        );
        if (completed === 'updated') waiters.get(requestId)?.(result);
        res.sendStatus(204);
      } catch (error) {
        logger.error('[Local files] Request failed', getSafeErrorMetadata(error));
        res.status(503).json({ code: 'UNAVAILABLE' });
      } finally {
        await lease
          ?.release()
          .catch((error: unknown) =>
            logger.error('[Local files] Lease release failed', getSafeErrorMetadata(error)),
          );
      }
    }
    return {
      create: (req: Request, res: Response) => handle(req, res, 'create'),
      heartbeat: (req: Request, res: Response) => handle(req, res, 'heartbeat'),
      result: (req: Request, res: Response) => handle(req, res, 'result'),
      render: (req: Request, res: Response) => handle(req, res, 'render'),
      remove: (req: Request, res: Response) => handle(req, res, 'remove'),
    };
  }
  function bind({ req, runId, config, streamId, jobCreatedAt, transport }: BindingOptions) {
    const id = req.body.localFilesSessionId;
    if (
      !id ||
      !req.user?.id ||
      req._isScheduledFire === true ||
      !localFilesAvailable(config) ||
      !streamId ||
      jobCreatedAt == null
    )
      return;
    const settings = localFilesConfigSchema.parse(config.config?.localFiles);
    const principal = { id: req.user.id, tenantId: req.user.tenantId };
    return {
      sessionId: id,
      config: settings,
      decisions: req.body.decisions ?? [],
      root: async (conversationId: string) => (await get(id, principal, conversationId))?.root,
      invoke: (
        input: Parameters<typeof invoke>[0]['command'],
        signal: AbortSignal,
        maximum?: number,
      ) =>
        invoke({
          principal,
          sessionId: id,
          command: { ...input, runId },
          config:
            maximum == null
              ? settings
              : {
                  ...settings,
                  maxOutputBytes: Math.max(
                    1,
                    Math.min(settings.maxOutputBytes, Math.floor(maximum)),
                  ),
                },
          signal,
          send: (command) =>
            transport.emitChunk(
              streamId,
              { event: LOCAL_FILES_EVENT, data: command },
              { expectedCreatedAt: jobCreatedAt, durable: true },
            ),
        }),
    };
  }
  return { router, bind, get, invoke };
}
type Command = Omit<LocalFilesCommand, 'id' | 'expiresAt' | 'version' | 'rootId' | 'sessionId'>;
interface Invocation {
  principal: LocalFilesPrincipal;
  sessionId: string;
  command: Command;
  config: LocalFilesConfig;
  send: (command: LocalFilesCommand) => void | Promise<void>;
  signal: AbortSignal;
}
export interface LocalFilesBinding {
  sessionId: string;
  config: LocalFilesConfig;
  decisions: Agents.ToolApprovalResolution[];
  root: (conversationId: string) => Promise<LocalFilesRoot | undefined>;
  invoke: (command: Command, signal: AbortSignal, maximum?: number) => Promise<LocalFilesResult>;
}
interface BindingOptions {
  req: ServerRequest & { _isScheduledFire?: boolean };
  runId: string;
  config: AppConfig;
  streamId?: string;
  jobCreatedAt?: number;
  transport: {
    emitChunk: (
      streamId: string,
      event: { event: typeof LOCAL_FILES_EVENT; data: LocalFilesCommand },
      options: { expectedCreatedAt: number; durable: boolean },
    ) => Promise<void>;
  };
}
interface LocalFilesService {
  router: () => Record<
    'create' | 'heartbeat' | 'result' | 'render' | 'remove',
    (req: Request, res: Response) => Promise<void>
  >;
  bind: (options: BindingOptions) => LocalFilesBinding | undefined;
  get: (
    id: string,
    principal: LocalFilesPrincipal,
    conversationId?: string,
  ) => Promise<Session | undefined>;
  invoke: (options: Invocation) => Promise<LocalFilesResult>;
}

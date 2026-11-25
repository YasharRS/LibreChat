import { z } from 'zod';
import { atom, createStore, useAtomValue } from 'jotai';
import {
  dataService,
  MutationKeys,
  QueryKeys,
  localFilesCommandSchema,
} from 'librechat-data-provider';
import type {
  LocalFilesRoot,
  LocalFilesSession,
  TPayload,
  LocalFilesCommand,
  LocalFilesResult,
} from 'librechat-data-provider';
import type { QueryClient } from '@tanstack/react-query';
import type { Filesystem } from './engine';
import { forgetFolders } from './storage';

export interface Connection {
  owner: string;
  conversationId: string;
  root: LocalFilesRoot;
  engine: Filesystem;
  client: QueryClient;
  stop?: (conversationId: string, generationCreatedAt: number) => Promise<unknown>;
  generationCreatedAt?: number;
  session?: LocalFilesSession;
  connecting?: Promise<LocalFilesSession>;
  firstRequestId?: string;
  timer?: ReturnType<typeof setInterval>;
}
export const connections = atom<ReadonlyMap<string, Connection>>(new Map());
const store = createStore();
const clients = new Set<QueryClient>();
export const useConnections = () => useAtomValue(connections, { store });
let owner: string | undefined;
export function localFilesOwner(
  user: { id?: string; tenantId?: string } | undefined,
): string | undefined {
  return user?.id ? JSON.stringify([user.tenantId ?? '', user.id]) : undefined;
}
export function setLocalFilesOwner(next: string | undefined): void {
  if (owner != null && owner !== next) clearLocalFiles();
  owner = next;
}
const items = () => store.get(connections);
export function setConnection(id: string, entry: Connection | undefined): void {
  const next = new Map(items());
  if (entry) {
    next.set(id, entry);
    clients.add(entry.client);
  } else next.delete(id);
  store.set(connections, next);
}
function mutate<T, V>(
  entry: Connection,
  key: MutationKeys,
  mutationFn: (value: V) => Promise<T>,
  value: V,
): Promise<T> {
  const cache = entry.client.getMutationCache();
  const mutation = cache.build<T, Error, V, void>(entry.client, {
    mutationKey: [key],
    mutationFn,
    variables: value,
    retry: false,
  });
  return mutation.execute().finally(() => cache.remove(mutation));
}
export function disconnect(entry: Connection): void {
  entry.engine.disconnect();
  if (entry.timer) clearInterval(entry.timer);
  for (const [id, current] of items()) if (current === entry) setConnection(id, undefined);
  entry.client.removeQueries({ queryKey: [QueryKeys.localFiles, entry.owner, entry.root.id] });
  const session = entry.session;
  entry.session = undefined;
  if (session) {
    if (entry.generationCreatedAt != null)
      void entry.stop?.(entry.conversationId, entry.generationCreatedAt).catch(() => undefined);
    void mutate(
      entry,
      MutationKeys.localFilesSession,
      dataService.disconnectLocalFiles,
      session,
    ).catch(() => undefined);
  }
}
export function clearLocalFiles(): void {
  const owners = new Set<string>();
  if (owner) owners.add(owner);
  owner = undefined;
  for (const entry of new Set(items().values())) {
    owners.add(entry.owner);
    disconnect(entry);
    entry.client.removeQueries({ queryKey: [QueryKeys.localFiles, entry.owner] });
  }
  for (const owner of owners) void forgetFolders(owner).catch(() => undefined);
  for (const client of clients)
    for (const owner of owners) client.removeQueries({ queryKey: [QueryKeys.localFiles, owner] });
  clients.clear();
  store.set(connections, new Map());
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel('librechat-local-files');
    for (const owner of owners) channel.postMessage({ type: 'logout', owner });
    channel.close();
  }
}
export function listenLocalFilesLogout(): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const channel = new BroadcastChannel('librechat-local-files');
  channel.onmessage = (event: MessageEvent<unknown>) => {
    const message = event.data;
    if (
      !message ||
      typeof message !== 'object' ||
      !('type' in message) ||
      message.type !== 'logout' ||
      !('owner' in message) ||
      typeof message.owner !== 'string'
    )
      return;
    for (const entry of new Set(items().values()))
      if (entry.owner === message.owner) disconnect(entry);
    for (const client of clients)
      client.removeQueries({ queryKey: [QueryKeys.localFiles, message.owner] });
    store.set(connections, new Map(items()));
    void forgetFolders(message.owner).catch(() => undefined);
  };
  return () => channel.close();
}
async function session(entry: Connection): Promise<LocalFilesSession> {
  if (entry.session) return entry.session;
  if (entry.connecting) return entry.connecting;
  entry.connecting = mutate(
    entry,
    MutationKeys.localFilesSession,
    () => dataService.createLocalFilesSession(entry.conversationId, entry.root),
    undefined,
  );
  try {
    const created = await entry.connecting;
    if (![...items().values()].includes(entry)) {
      await dataService.disconnectLocalFiles(created);
      throw new Error('Local file connection was closed');
    }
    entry.session = created;
    entry.timer = setInterval(
      () => {
        if (!entry.session) return;
        void mutate(
          entry,
          MutationKeys.localFilesSession,
          dataService.heartbeatLocalFiles,
          entry.session,
        ).catch(() => disconnect(entry));
      },
      Math.floor(created.config.sessionTtlMs / 3),
    );
    return created;
  } finally {
    entry.connecting = undefined;
  }
}
/** Called by the app transport, after the composer has created its actual payload. */
export async function withLocalFiles(payload: TPayload): Promise<TPayload> {
  const id = payload.conversationId ?? 'new';
  const entry =
    items().get(id) ??
    (payload.clientRequestId
      ? [...items().values()].find(
          (candidate) => candidate.firstRequestId === payload.clientRequestId,
        )
      : undefined);
  if (!entry || entry.owner !== owner) return payload;
  if (entry.conversationId === 'new') {
    entry.firstRequestId = payload.clientRequestId;
    entry.conversationId = crypto.randomUUID();
    setConnection(entry.conversationId, entry);
  }
  const bound = await session(entry);
  return { ...payload, conversationId: entry.conversationId, localFilesSessionId: bound.id };
}
const generation = z.object({ generationCreatedAt: z.number().int().positive() });
/** Capture the job returned by the start request so a late disconnect cannot stop its successor. */
export async function startWithLocalFiles<T>(
  payload: TPayload,
  send: (payload: TPayload) => Promise<T>,
): Promise<T> {
  const bound = await withLocalFiles(payload);
  const entry = bound.localFilesSessionId
    ? [...items().values()].find((candidate) => candidate.session?.id === bound.localFilesSessionId)
    : undefined;
  const result = await send(bound);
  const parsed = generation.safeParse(result);
  if (entry && parsed.success) {
    entry.generationCreatedAt = parsed.data.generationCreatedAt;
    if (![...items().values()].includes(entry))
      await entry.stop?.(entry.conversationId, entry.generationCreatedAt).catch(() => undefined);
  }
  return result;
}
export function adoptLocalFiles(conversationId: string): void {
  const fresh = items().get('new');
  if (fresh?.conversationId === conversationId) setConnection('new', undefined);
}
export async function receiveLocalFiles(value: LocalFilesCommand): Promise<void> {
  const parsed = localFilesCommandSchema.safeParse(value);
  if (!parsed.success) return;
  const command = parsed.data;
  const entry = [...items().values()].find(
    (candidate) => candidate.session?.id === command.sessionId,
  );
  if (command.cancelled) {
    entry?.engine.cancel(command.id, command.expiresAt);
    return;
  }
  if (
    !entry?.session ||
    entry.owner !== owner ||
    entry.root.id !== command.rootId ||
    entry.conversationId !== command.conversationId ||
    command.expiresAt <= Date.now()
  )
    return;
  const session = entry.session;
  const result: LocalFilesResult = await entry.engine.execute(command, (input, signal) =>
    entry.client.fetchQuery({
      queryKey: [
        QueryKeys.localFiles,
        entry.owner,
        entry.root.id,
        session.id,
        'render',
        command.id,
      ],
      queryFn: () => dataService.renderLocalFile(session, input, signal),
      retry: false,
      cacheTime: 0,
    }),
  );
  if (![...items().values()].includes(entry)) return;
  await mutate(
    entry,
    MutationKeys.localFilesResult,
    () => dataService.completeLocalFiles(entry.session!, command.id, result),
    undefined,
  );
  if (result.ok)
    await entry.client.invalidateQueries({
      queryKey: [QueryKeys.localFiles, entry.owner, entry.root.id],
    });
}

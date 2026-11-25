import { Keyv } from 'keyv';
import path from 'node:path';
import express from 'express';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import { LOCAL_FILES_HEADER, localFilesConfigSchema } from 'librechat-data-provider';
import type { LocalFilesCommand, LocalFilesSession } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { ServerRequest } from '~/types';
import { createLocalFilesService, localFilesCapabilities } from './service';
import { createLocalFilesReader } from './reader';
import { samplePdf } from './samples.helper';

const settings = localFilesConfigSchema.parse({ enabled: true, requestTimeoutMs: 10000 });
const config = {
  config: { localFiles: settings },
  endpoints: { agents: { toolApproval: { enabled: true, mode: 'bypass' } } },
} as AppConfig;
const principal = { id: 'owner', tenantId: 'tenant' };
const conversationId = randomUUID();
const root = { id: randomUUID(), name: 'workspace', access: 'readwrite' as const };
function response() {
  const state: { status: number; body?: unknown } = { status: 200 };
  const res = {
    status: (code: number) => {
      state.status = code;
      return res;
    },
    json: (body: unknown) => {
      state.body = body;
      return res;
    },
    sendStatus: (code: number) => {
      state.status = code;
      return res;
    },
  };
  return { state, res: res as Response };
}
function request(
  session?: LocalFilesSession,
  body: object = {},
  user = principal,
  requestId?: string,
) {
  return Object.assign(Object.create(express.request), {
    config,
    user,
    body,
    params: { id: session?.id, requestId },
    get: (header: string) => (header === LOCAL_FILES_HEADER ? session?.token : undefined),
  }) as Request;
}
async function setup(read?: ReturnType<typeof createLocalFilesReader>) {
  const store = new Keyv();
  const service = createLocalFilesService({ store, read });
  const handlers = service.router();
  const created = response();
  await handlers.create(request(undefined, { version: 2, conversationId, root }), created.res);
  expect(created.state.status).toBe(201);
  return { store, service, handlers, session: created.state.body as LocalFilesSession };
}
it('authenticates raw uploads, extracts only a pending read, and keeps source bytes out of flow state', async () => {
  const read = createLocalFilesReader(
    path.join(__dirname, '../../dist/filesystem/reader-worker.cjs'),
  );
  const { service, handlers, session } = await setup(read);
  const app = express();
  app.use((req, _res, next) => {
    Object.assign(req, { user: principal, config });
    next();
  });
  app.post('/sessions/:id/results/:requestId', handlers.result);
  let requestId = '';
  const data = samplePdf(['Private PDF text']);
  const result = await service.invoke({
    principal,
    sessionId: session.id,
    config: settings,
    signal: new AbortController().signal,
    command: {
      runId: 'run',
      toolCallId: 'pdf',
      conversationId,
      input: { operation: 'read', path: 'report.pdf' },
    },
    send: async (command) => {
      requestId = command.id;
      const url = `/sessions/${session.id}/results/${command.id}`;
      await supertest(app)
        .post(url)
        .set(LOCAL_FILES_HEADER, 'wrong-token')
        .type('application/octet-stream')
        .send(data)
        .expect(404);
      await supertest(app)
        .post(url)
        .set(LOCAL_FILES_HEADER, session.token)
        .type('application/octet-stream')
        .send(data)
        .expect(204);
    },
  });
  expect(result).toEqual({
    ok: true,
    value: { path: 'report.pdf', content: '[Page 1]\nPrivate PDF text' },
  });
  expect(JSON.stringify(result)).not.toContain('%PDF');
  await supertest(app)
    .post(`/sessions/${session.id}/results/${requestId}`)
    .set(LOCAL_FILES_HEADER, session.token)
    .type('application/octet-stream')
    .send(data)
    .expect(409);
}, 30000);
it('does not advertise or activate the feature by default or without approval support', () => {
  expect(localFilesCapabilities(undefined)).toEqual({});
  expect(localFilesCapabilities({ ...config, endpoints: {} }).localFiles?.available).toBe(false);
});
it('binds an expiring session to its owner, tenant, and conversation', async () => {
  const { service, session } = await setup();
  expect((await service.get(session.id, principal, conversationId))?.root).toEqual(root);
  expect(
    await service.get(session.id, { ...principal, id: 'other' }, conversationId),
  ).toBeUndefined();
  expect(
    await service.get(session.id, { ...principal, tenantId: 'other' }, conversationId),
  ).toBeUndefined();
  expect(await service.get(session.id, principal, randomUUID())).toBeUndefined();
});
it('never accepts a guessed session or a token from a different session', async () => {
  const { handlers, session } = await setup();
  for (const candidate of [
    { ...session, token: randomUUID() },
    { ...session, id: randomUUID() },
  ]) {
    const res = response();
    await handlers.heartbeat(request(candidate), res.res);
    expect(res.state).toEqual({ status: 404, body: { code: 'UNAVAILABLE' } });
  }
});
it('removes authority immediately when disconnected', async () => {
  const { handlers, session, service } = await setup();
  await handlers.remove(request(session), response().res);
  expect(await service.get(session.id, principal, conversationId)).toBeUndefined();
});
it('keeps storage failures out of a success response and out of client diagnostics', async () => {
  const { handlers, session, store } = await setup();
  jest.spyOn(store, 'get').mockRejectedValueOnce(new Error('password=secret provider payload'));
  const res = response();
  await handlers.heartbeat(request(session), res.res);
  expect(res.state).toEqual({ status: 503, body: { code: 'UNAVAILABLE' } });
});
it('does not dispatch another principal’s request to a browser', async () => {
  const { service, session } = await setup();
  const send = jest.fn();
  expect(
    await service.invoke({
      principal: { ...principal, id: 'other' },
      sessionId: session.id,
      command: {
        runId: 'run',
        toolCallId: 'call',
        conversationId,
        input: { operation: 'read', path: 'note.txt' },
      },
      config: settings,
      send,
      signal: new AbortController().signal,
    }),
  ).toEqual({ ok: false, error: { code: 'UNAVAILABLE' } });
  expect(send).not.toHaveBeenCalled();
});
it('accepts a result through a peer service without exposing session credentials in the command', async () => {
  const { service, session, store } = await setup();
  const peer = createLocalFilesService({ store }).router();
  let delivered: LocalFilesCommand | undefined;
  let resultStatus: number | undefined;
  const result = await service.invoke({
    principal,
    sessionId: session.id,
    command: {
      runId: 'run',
      toolCallId: 'call',
      conversationId,
      input: { operation: 'read', path: 'note.txt' },
    },
    config: settings,
    signal: new AbortController().signal,
    send: (command) => {
      delivered = command;
      const res = response();
      void peer
        .result(
          request(
            session,
            { ok: true, value: { path: 'note.txt', content: 'contents' } },
            principal,
            command.id,
          ),
          res.res,
        )
        .then(() => {
          resultStatus = res.state.status;
        });
    },
  });
  expect(result).toEqual({ ok: true, value: { path: 'note.txt', content: 'contents' } });
  expect(resultStatus).toBe(204);
  expect(JSON.stringify(delivered)).not.toContain(session.token);
});
it('publishes through the resumable job transport with the exact generation, without writing to the start HTTP response', async () => {
  const { service, session, handlers } = await setup();
  const emitChunk = jest.fn(async (_streamId: string, event: { data: LocalFilesCommand }) => {
    await handlers.result(
      request(
        session,
        { ok: true, value: { path: 'note.txt', content: 'contents' } },
        principal,
        event.data.id,
      ),
      response().res,
    );
  });
  const binding = service.bind({
    req: request(session, { localFilesSessionId: session.id, conversationId }) as ServerRequest,
    runId: 'run',
    config,
    streamId: conversationId,
    jobCreatedAt: 123,
    transport: { emitChunk },
  });
  expect(
    await binding?.invoke(
      {
        conversationId,
        runId: 'run',
        toolCallId: 'call',
        input: { operation: 'read', path: 'note.txt' },
      },
      new AbortController().signal,
    ),
  ).toEqual({ ok: true, value: { path: 'note.txt', content: 'contents' } });
  expect(emitChunk).toHaveBeenCalledWith(
    conversationId,
    expect.objectContaining({ event: 'on_local_file_request' }),
    { expectedCreatedAt: 123, durable: true },
  );
  expect(JSON.stringify(emitChunk.mock.calls)).not.toContain(session.token);
});
it('cancels within the request deadline even when publication never acknowledges', async () => {
  const { service, session } = await setup();
  const controller = new AbortController();
  const send = jest.fn((command: LocalFilesCommand) => {
    if (command.cancelled) return;
    controller.abort();
    return new Promise<void>(() => undefined);
  });
  expect(
    await service.invoke({
      principal,
      sessionId: session.id,
      config: settings,
      signal: controller.signal,
      send,
      command: {
        conversationId,
        runId: 'run',
        toolCallId: 'call',
        input: { operation: 'read', path: 'note.txt' },
      },
    }),
  ).toEqual({ ok: false, error: { code: 'CANCELLED' } });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ cancelled: true }));
});

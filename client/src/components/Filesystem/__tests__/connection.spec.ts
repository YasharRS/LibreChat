import axios from 'axios';
import { webcrypto } from 'node:crypto';
import { QueryClient } from '@tanstack/react-query';
import { localFilesConfigSchema } from 'librechat-data-provider';
import type { LocalFilesSession, TPayload } from 'librechat-data-provider';
import type { Connection } from '../connection';
import {
  clearLocalFiles,
  disconnect,
  localFilesOwner,
  setConnection,
  setLocalFilesOwner,
  withLocalFiles,
  startWithLocalFiles,
} from '../connection';
import { DiskFolder } from 'test/filesystem';
import { Filesystem } from '../engine';

const original = axios.defaults.adapter;
let client: QueryClient;
let entry: Connection;
let created: LocalFilesSession;
let requests: string[];
beforeAll(() =>
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto }),
);
beforeEach(() => {
  client = new QueryClient({
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
  });
  const config = localFilesConfigSchema.parse({ enabled: true });
  const root = { id: crypto.randomUUID(), name: 'workspace', access: 'read' as const };
  const owner = localFilesOwner({ id: 'user', tenantId: 'tenant' })!;
  entry = {
    owner,
    conversationId: 'new',
    root,
    client,
    stop: jest.fn(async () => undefined),
    engine: new Filesystem(new DiskFolder(), config, {
      get: async () => undefined,
      put: async () => undefined,
    }),
  };
  created = { id: crypto.randomUUID(), token: 'memory-only-token', config, root, version: 3 };
  requests = [];
  axios.defaults.adapter = async (config) => {
    requests.push(`${config.method} ${config.url}`);
    return {
      data: config.method === 'delete' ? undefined : created,
      status: config.method === 'delete' ? 204 : 201,
      statusText: '',
      headers: {},
      config,
    };
  };
  setLocalFilesOwner(owner);
  setConnection('new', entry);
});
afterEach(async () => {
  clearLocalFiles();
  await Promise.resolve();
  axios.defaults.adapter = original;
  client.clear();
});
it('binds one in-memory session to the actual new conversation, even during a duplicate start', async () => {
  const payload = { conversationId: 'new', clientRequestId: 'request' } as TPayload;
  const [first, second] = await Promise.all([withLocalFiles(payload), withLocalFiles(payload)]);
  expect(first.conversationId).toBe(entry.conversationId);
  expect(second.conversationId).toBe(first.conversationId);
  expect(first.localFilesSessionId).toBe(created.id);
  expect(first).not.toHaveProperty('token');
  expect(requests.filter((value) => value.startsWith('post'))).toHaveLength(1);
  expect(client.getMutationCache().getAll()).toHaveLength(0);
});
it('drops an old account’s authority immediately and isolates the same user ID in different tenants', async () => {
  expect(localFilesOwner({ id: 'user', tenantId: 'other' })).not.toBe(entry.owner);
  setLocalFilesOwner(localFilesOwner({ id: 'other', tenantId: 'tenant' }));
  const payload = { conversationId: 'new' } as TPayload;
  expect(await withLocalFiles(payload)).toBe(payload);
  expect(requests).toHaveLength(0);
  expect(entry.engine.canWrite).toBe(false);
});
it('stops the active chat and revokes the server session when disconnected', async () => {
  await startWithLocalFiles({ conversationId: 'new' } as TPayload, async () => ({
    generationCreatedAt: 123,
  }));
  disconnect(entry);
  expect(entry.session).toBeUndefined();
  expect(entry.stop).toHaveBeenCalledWith(entry.conversationId, 123);
  expect(await withLocalFiles({ conversationId: 'new' } as TPayload)).not.toHaveProperty(
    'localFilesSessionId',
  );
});
it('stops only the returned job when disconnected before its start response arrives', async () => {
  await startWithLocalFiles({ conversationId: 'new' } as TPayload, async () => {
    disconnect(entry);
    return { generationCreatedAt: 456 };
  });
  expect(entry.stop).toHaveBeenCalledTimes(1);
  expect(entry.stop).toHaveBeenCalledWith(entry.conversationId, 456);
});

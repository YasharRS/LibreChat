import axios, { AxiosError } from 'axios';
import type { LocalFilesSession } from './filesystem';
import { completeLocalFiles, LocalFilesTransportError } from './filesystem-service';
import { localFilesConfigSchema } from './filesystem';

const adapter = axios.defaults.adapter;
const session: LocalFilesSession = {
  id: 'session',
  token: 'private-session-token',
  version: 1,
  root: { id: 'root', name: 'workspace', access: 'read' },
  config: localFilesConfigSchema.parse({}),
};
afterEach(() => {
  axios.defaults.adapter = adapter;
});
it('discards transport diagnostics, request credentials and file text before React Query sees a failure', async () => {
  axios.defaults.adapter = async (config) => {
    throw new AxiosError(
      'password=diagnostic-secret',
      'ERR_BAD_RESPONSE',
      config,
      {},
      {
        status: 503,
        statusText: 'unavailable',
        config,
        headers: {},
        data: { code: 'UNAVAILABLE', detail: 'private-response-secret' },
      },
    );
  };
  const error = await completeLocalFiles(session, 'request', {
    ok: true,
    value: { path: 'note.txt', content: 'private-file-text' },
  }).catch((error: Error) => error);
  expect(error).toBeInstanceOf(LocalFilesTransportError);
  expect(error).toMatchObject({ code: 'UNAVAILABLE', message: 'UNAVAILABLE' });
  expect(JSON.stringify(error)).not.toMatch(/private|password|config|response|headers/);
  expect(Object.getOwnPropertyNames(error)).not.toContain('cause');
});
it('maps unapproved upstream messages to a safe stable code', async () => {
  axios.defaults.adapter = async (config) => {
    throw new AxiosError('arbitrary secret', undefined, config);
  };
  await expect(
    completeLocalFiles(session, 'request', { ok: false, error: { code: 'CANCELLED' } }),
  ).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'UNAVAILABLE' });
});

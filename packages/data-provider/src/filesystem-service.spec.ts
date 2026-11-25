import axios, { AxiosError } from 'axios';
import type { LocalFilesSession } from './filesystem';
import { completeLocalFiles, LocalFilesTransportError } from './filesystem-service';
import { localFilesConfigSchema } from './filesystem';

const adapter = axios.defaults.adapter;
const session: LocalFilesSession = {
  id: 'session',
  token: 'private-session-token',
  version: 2,
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
it('sends binary results as raw bytes, retaining the session credential only in its header', async () => {
  axios.defaults.adapter = async (config) => {
    expect(config.headers['Content-Type']).toBe('application/octet-stream');
    expect(config.headers['X-Local-Files-Token']).toBe(session.token);
    expect(Buffer.from(config.data)).toEqual(Buffer.from([0, 1, 128, 255]));
    return { data: undefined, status: 204, statusText: 'No Content', headers: {}, config };
  };
  await completeLocalFiles(session, 'request', {
    ok: true,
    value: { path: 'report.pdf', binary: { mime: 'application/pdf', data: 'AAGA/w==' } },
  });
});

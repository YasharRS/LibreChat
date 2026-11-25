import { z } from 'zod';
import axios, { isAxiosError } from 'axios';
import type { AxiosResponse } from 'axios';
import type { LocalFilesRoot, LocalFilesSession, LocalFilesResult } from './filesystem';
import { LOCAL_FILES_HEADER, LOCAL_FILES_VERSION, LOCAL_FILES_ERRORS } from './filesystem';
import { apiBaseUrl } from './api-endpoints';

const url = (id?: string): string =>
  `${apiBaseUrl()}/api/local-files/sessions${id ? `/${encodeURIComponent(id)}` : ''}`;
const options = (token: string) => ({ headers: { [LOCAL_FILES_HEADER]: token } });
export class LocalFilesTransportError extends Error {
  constructor(public readonly code: (typeof LOCAL_FILES_ERRORS)[number]) {
    super(code);
  }
}
const errorSchema = z.object({ code: z.enum(LOCAL_FILES_ERRORS) });
/** React Query and console capture must never retain an Axios request containing file text or credentials. */
async function send<T>(invoke: () => Promise<AxiosResponse<T>>): Promise<T> {
  try {
    return (await invoke()).data;
  } catch (error) {
    const parsed = errorSchema.safeParse(isAxiosError(error) ? error.response?.data : undefined);
    throw new LocalFilesTransportError(parsed.success ? parsed.data.code : 'UNAVAILABLE');
  }
}
export async function createLocalFilesSession(
  conversationId: string,
  root: LocalFilesRoot,
): Promise<LocalFilesSession> {
  return send(() =>
    axios.post<LocalFilesSession>(url(), {
      version: LOCAL_FILES_VERSION,
      conversationId,
      root,
    }),
  );
}
export async function heartbeatLocalFiles(session: LocalFilesSession): Promise<void> {
  await send(() => axios.post(`${url(session.id)}/heartbeat`, {}, options(session.token)));
}
export async function completeLocalFiles(
  session: LocalFilesSession,
  id: string,
  result: LocalFilesResult,
): Promise<void> {
  await send(() =>
    axios.post(
      `${url(session.id)}/results/${encodeURIComponent(id)}`,
      result,
      options(session.token),
    ),
  );
}
export async function disconnectLocalFiles(session: LocalFilesSession): Promise<void> {
  await send(() => axios.delete(url(session.id), options(session.token)));
}

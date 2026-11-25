import type { LocalFilesConfig, LocalFilesInput, LocalFilesResult } from 'librechat-data-provider';
import { createLocalFilesProcess } from './process';

export interface LocalFilesRead {
  input: Extract<LocalFilesInput, { operation: 'read' }>;
  data: Buffer;
  config: LocalFilesConfig;
  signal: AbortSignal;
}
export type LocalFilesReader = (request: LocalFilesRead) => Promise<LocalFilesResult>;

export function createLocalFilesReader(path: string): LocalFilesReader {
  const run = createLocalFilesProcess<Omit<LocalFilesRead, 'signal'>>(
    path,
    (value, { config }) =>
      value.binary == null &&
      Buffer.byteLength(value.content ?? '', 'utf8') <= config.maxTextBytes &&
      (value.images?.length ?? 0) <= config.maxImages &&
      Buffer.byteLength(JSON.stringify(value), 'utf8') + 1024 * (value.images?.length ?? 0) <=
        config.maxOutputBytes &&
      !value.images?.some(
        (image) =>
          !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) ||
          Buffer.byteLength(image.data, 'base64') > config.maxImageBytes,
      ),
  );
  return (request) => {
    if (request.data.length > request.config.maxFileBytes)
      return Promise.resolve({ ok: false, error: { code: 'TOO_LARGE' } });
    return run(request).then((result) =>
      !result.ok && result.error.code === 'FAILED'
        ? { ok: false, error: { code: 'UNREADABLE_FILE' } }
        : result,
    );
  };
}

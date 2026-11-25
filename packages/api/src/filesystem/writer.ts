import { localFilesDocument, localFilesWriteSize } from 'librechat-data-provider';
import type { LocalFilesConfig, LocalFilesWrite, LocalFilesResult } from 'librechat-data-provider';
import { createLocalFilesProcess } from './process';

export interface LocalFilesRender {
  input: LocalFilesWrite;
  config: LocalFilesConfig;
  signal: AbortSignal;
}
export type LocalFilesWriter = (request: LocalFilesRender) => Promise<LocalFilesResult>;

export function createLocalFilesWriter(path: string): LocalFilesWriter {
  const run = createLocalFilesProcess<Omit<LocalFilesRender, 'signal'>>(
    path,
    (value, { input, config }) => {
      if (
        !value.binary ||
        value.binary.mime !== localFilesDocument(input.path)?.[1] ||
        value.content != null ||
        value.images != null ||
        value.entries != null
      )
        return false;
      const size = localFilesWriteSize({
        ...input,
        content: value.binary.data,
        encoding: 'base64',
      });
      return size != null && size <= config.maxFileBytes;
    },
  );
  return (request) => {
    if (request.input.encoding === 'base64' || !localFilesDocument(request.input.path))
      return Promise.resolve({ ok: false, error: { code: 'UNSUPPORTED_FORMAT' } });
    if (Buffer.byteLength(request.input.content, 'utf8') > request.config.maxTextBytes)
      return Promise.resolve({ ok: false, error: { code: 'TOO_LARGE' } });
    return run(request);
  };
}

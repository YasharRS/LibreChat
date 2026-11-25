import { spawn } from 'node:child_process';
import { localFilesResultSchema } from 'librechat-data-provider';
import type { LocalFilesConfig, LocalFilesInput, LocalFilesResult } from 'librechat-data-provider';
import type { ChildProcess } from 'node:child_process';

export interface LocalFilesRead {
  input: Extract<LocalFilesInput, { operation: 'read' }>;
  data: Buffer;
  config: LocalFilesConfig;
  signal: AbortSignal;
}
export type LocalFilesReader = (request: LocalFilesRead) => Promise<LocalFilesResult>;

/** Each untrusted document gets a disposable heap and a killable deadline, with no disk files. */
export function createLocalFilesReader(path: string): LocalFilesReader {
  let active = 0;
  return async ({ input, data, config, signal }) => {
    const failure = (
      code: Extract<LocalFilesResult, { ok: false }>['error']['code'],
    ): LocalFilesResult => ({ ok: false, error: { code } });
    if (signal.aborted) return failure('CANCELLED');
    if (data.length > config.maxFileBytes) return failure('TOO_LARGE');
    if (active >= config.maxReaders) return failure('PROCESSOR_BUSY');
    active++;
    try {
      let child: ChildProcess;
      try {
        child = spawn(
          process.execPath,
          [
            // A fixed containment ceiling, independent of the parent API's heap flags.
            '--max-old-space-size=256',
            '--max-semi-space-size=8',
            '--stack-size=1024',
            path,
          ],
          {
            env: { ...process.env, NODE_OPTIONS: '' },
            serialization: 'advanced',
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          },
        );
      } catch {
        return failure('UNREADABLE_FILE');
      }
      return await new Promise<LocalFilesResult>((resolve) => {
        let settled = false;
        const closed = new Promise<void>((done) => child.once('close', () => done()));
        const finish = async (result: LocalFilesResult): Promise<void> => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener('abort', cancelled);
          child.kill('SIGKILL');
          await closed;
          resolve(result);
        };
        const cancelled = () => {
          void finish(failure('CANCELLED'));
        };
        const timer = setTimeout(() => {
          void finish(failure('TIMEOUT'));
        }, config.extractionTimeoutMs);
        child.once('error', () => {
          void finish(failure('UNREADABLE_FILE'));
        });
        child.once('close', () => {
          void finish(failure('UNREADABLE_FILE'));
        });
        child.once('message', (message: unknown) => {
          const parsed = localFilesResultSchema.safeParse(message);
          if (
            !parsed.success ||
            (parsed.data.ok &&
              (parsed.data.value.binary != null ||
                parsed.data.value.path !== input.path ||
                Buffer.byteLength(parsed.data.value.content ?? '', 'utf8') > config.maxTextBytes ||
                (parsed.data.value.images?.length ?? 0) > config.maxImages ||
                Buffer.byteLength(JSON.stringify(parsed.data.value), 'utf8') +
                  1024 * (parsed.data.value.images?.length ?? 0) >
                  config.maxOutputBytes ||
                parsed.data.value.images?.some(
                  (image) =>
                    !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data) ||
                    Buffer.byteLength(image.data, 'base64') > config.maxImageBytes,
                )))
          ) {
            void finish(failure('UNREADABLE_FILE'));
            return;
          }
          void finish(parsed.data);
        });
        signal.addEventListener('abort', cancelled, { once: true });
        if (signal.aborted) cancelled();
        else
          child.send({ input, data, config }, (error) => {
            if (error) void finish(failure('UNREADABLE_FILE'));
          });
      });
    } finally {
      active--;
    }
  };
}

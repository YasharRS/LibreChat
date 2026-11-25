import { spawn } from 'node:child_process';
import { localFilesResultSchema } from 'librechat-data-provider';
import type { LocalFilesConfig, LocalFilesResult } from 'librechat-data-provider';
import type { ChildProcess } from 'node:child_process';

type Value = Extract<LocalFilesResult, { ok: true }>['value'];
interface Job {
  input: { path: string };
  config: LocalFilesConfig;
}

/** Bound document work to a disposable heap and a killable deadline, without disk files. */
export function createLocalFilesProcess<T extends Job>(
  path: string,
  validate: (value: Value, request: T) => boolean,
): (request: T & { signal: AbortSignal }) => Promise<LocalFilesResult> {
  let active = 0;
  return async (request) => {
    const { signal, config } = request;
    const failure = (
      code: Extract<LocalFilesResult, { ok: false }>['error']['code'],
    ): LocalFilesResult => ({ ok: false, error: { code } });
    if (signal.aborted) return failure('CANCELLED');
    if (active >= config.maxReaders) return failure('PROCESSOR_BUSY');
    active++;
    try {
      let child: ChildProcess;
      try {
        child = spawn(
          process.execPath,
          ['--max-old-space-size=256', '--max-semi-space-size=8', '--stack-size=1024', path],
          {
            env: { ...process.env, NODE_OPTIONS: '' },
            serialization: 'advanced',
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          },
        );
      } catch {
        return failure('FAILED');
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
          void finish(failure('FAILED'));
        });
        child.once('close', () => {
          void finish(failure('FAILED'));
        });
        child.once('message', (message: unknown) => {
          const parsed = localFilesResultSchema.safeParse(message);
          if (
            !parsed.success ||
            (parsed.data.ok &&
              (parsed.data.value.path !== request.input.path ||
                !validate(parsed.data.value, request)))
          ) {
            void finish(failure('FAILED'));
            return;
          }
          void finish(parsed.data);
        });
        signal.addEventListener('abort', cancelled, { once: true });
        if (signal.aborted) cancelled();
        else {
          const { signal: _signal, ...job } = request;
          child.send(job, (error) => {
            if (error) void finish(failure('FAILED'));
          });
        }
      });
    } finally {
      active--;
    }
  };
}

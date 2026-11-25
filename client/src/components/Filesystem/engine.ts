import {
  LocalFilesTransportError,
  localFilesInputSchema,
  serializeLocalFiles,
} from 'librechat-data-provider';
import type {
  LocalFilesCommand,
  LocalFilesConfig,
  LocalFilesInput,
  LocalFilesResult,
  LocalFilesReview,
} from 'librechat-data-provider';

export interface Writable {
  write(data: string | Blob): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
export interface FileHandle {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<Writable>;
  isSameEntry(other: FileHandle): Promise<boolean>;
}
/** Structural boundary for the browser API, which is not fully declared by lib.dom. */
export interface Folder {
  kind: 'directory';
  name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<Folder>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string): Promise<void>;
  values(): AsyncIterableIterator<Folder | FileHandle>;
  queryPermission(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  isSameEntry(other: Folder): Promise<boolean>;
}
export interface JournalEntry {
  state: 'started' | 'done';
  result?: LocalFilesResult;
}
export interface Journal {
  get(id: string): Promise<JournalEntry | undefined>;
  put(id: string, entry: JournalEntry): Promise<void>;
}
export interface Preview {
  input: LocalFilesInput;
  review: LocalFilesReview;
  before: string;
  after: string;
}
type Code = Extract<LocalFilesResult, { ok: false }>['error']['code'];
export class FilesystemError extends Error {
  constructor(public readonly code: Code) {
    super(code);
  }
}
export function filesystemError(error: unknown): Code {
  if (error instanceof LocalFilesTransportError) return error.code;
  if (error instanceof FilesystemError) return error.code;
  if (error instanceof DOMException) {
    if (error.name === 'NotFoundError') return 'NOT_FOUND';
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError')
      return 'PERMISSION_DENIED';
    if (error.name === 'AbortError') return 'CANCELLED';
    if (error.name === 'TypeMismatchError' || error.name === 'InvalidModificationError')
      return 'CONFLICT';
  }
  return 'FAILED';
}
const fail = (code: Code): never => {
  throw new FilesystemError(code);
};
export async function digest(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
async function fingerprint(file: File, max: number): Promise<string> {
  if (file.size > max) return fail('TOO_LARGE');
  return digest(await file.arrayBuffer());
}
async function text(file: File, max: number): Promise<string> {
  if (file.size > max) return fail('TOO_LARGE');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      await file.arrayBuffer(),
    );
  } catch {
    return fail('UNSUPPORTED_TEXT');
  }
}
export function replacements(
  content: string,
  edits: Extract<LocalFilesInput, { operation: 'edit' }>['edits'],
): string {
  const ending = content.includes('\r\n') ? '\r\n' : '\n';
  let output = content;
  for (const edit of edits) {
    const old = edit.oldText.replace(/\r?\n/g, ending);
    const index = output.indexOf(old);
    if (index < 0 || output.indexOf(old, index + old.length) >= 0) return fail('CONFLICT');
    output =
      output.slice(0, index) +
      edit.newText.replace(/\r?\n/g, ending) +
      output.slice(index + old.length);
  }
  return output;
}

export class Filesystem {
  private readonly grants = new Map<string, { preview: Preview; callId: string }>();
  private readonly active = new Map<string, Promise<LocalFilesResult>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly cancelled = new Map<string, number>();
  private readonly controller = new AbortController();
  private writable = false;

  constructor(
    readonly folder: Folder,
    readonly config: LocalFilesConfig,
    private readonly journal: Journal,
  ) {}

  disconnect(): void {
    this.controller.abort();
    this.grants.clear();
    this.cancelled.clear();
  }

  async enable(): Promise<boolean> {
    // Invoke directly from a click: requesting a browser permission needs user activation.
    this.writable = (await this.folder.requestPermission({ mode: 'readwrite' })) === 'granted';
    return this.writable;
  }

  get canWrite(): boolean {
    return this.writable && !this.controller.signal.aborted;
  }

  inspect(
    input: Extract<LocalFilesInput, { operation: 'list' | 'read' }>,
  ): Promise<LocalFilesResult> {
    return this.execute({
      version: 1,
      id: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      rootId: crypto.randomUUID(),
      conversationId: '',
      runId: 'preview',
      toolCallId: 'preview',
      input,
      expiresAt: Date.now() + this.config.requestTimeoutMs,
    });
  }

  cancel(id: string, expiresAt = Date.now() + this.config.requestTimeoutMs): void {
    this.cancelled.set(id, expiresAt);
    this.controllers.get(id)?.abort();
  }

  private check(expiresAt = Infinity, signal?: AbortSignal): void {
    if (this.controller.signal.aborted) fail('CANCELLED');
    if (signal?.aborted) fail('CANCELLED');
    if (Date.now() >= expiresAt) fail('TIMEOUT');
  }

  private async parent(path: string): Promise<{ folder: Folder; name: string }> {
    const parts = path.split('/');
    const name = parts.pop();
    if (!name) return fail('INVALID_REQUEST');
    let folder = this.folder;
    for (const part of parts) folder = await folder.getDirectoryHandle(part);
    return { folder, name };
  }

  private async open(path: string): Promise<FileHandle> {
    const { folder, name } = await this.parent(path);
    return folder.getFileHandle(name);
  }

  private async exists(path: string): Promise<boolean> {
    const { folder, name } = await this.parent(path);
    try {
      await folder.getFileHandle(name);
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TypeMismatchError') return true;
      if (error instanceof DOMException && error.name === 'NotFoundError') return false;
      throw error;
    }
  }

  private async hash(path: string, max: number): Promise<string | null> {
    try {
      return await fingerprint(await (await this.open(path)).getFile(), max);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;
      throw error;
    }
  }

  async preview(input: LocalFilesInput, sessionId: string): Promise<Preview> {
    const parsed = localFilesInputSchema.safeParse(input);
    if (!parsed.success) return fail('INVALID_REQUEST');
    input = parsed.data;
    this.check();
    if (input.operation === 'read' || input.operation === 'list') return fail('INVALID_REQUEST');
    const before: LocalFilesReview['before'] = [];
    let old = '';
    let after = '';
    if (input.operation === 'mkdir') {
      if (await this.exists(input.path)) return fail('CONFLICT');
      before.push({ path: input.path, hash: null });
    } else if (input.operation === 'move') {
      if (await this.exists(input.destination)) return fail('CONFLICT');
      const hash = await this.hash(input.path, this.config.maxMoveBytes);
      if (hash == null) return fail('NOT_FOUND');
      before.push({ path: input.path, hash }, { path: input.destination, hash: null });
    } else {
      const hash = await this.hash(input.path, this.config.maxTextBytes);
      if (input.operation === 'edit' && hash == null) return fail('NOT_FOUND');
      if (hash != null)
        old = await text(await (await this.open(input.path)).getFile(), this.config.maxTextBytes);
      after = input.operation === 'write' ? input.content : replacements(old, input.edits);
      if (old.startsWith('\uFEFF') && !after.startsWith('\uFEFF')) after = '\uFEFF' + after;
      if (new TextEncoder().encode(after).byteLength > this.config.maxTextBytes)
        return fail('TOO_LARGE');
      before.push({ path: input.path, hash });
    }
    const review: LocalFilesReview = {
      id: crypto.randomUUID(),
      sessionId,
      before,
      digest: await digest(new TextEncoder().encode(serializeLocalFiles(input)).buffer),
    };
    return { input, review, before: old, after };
  }

  approve(preview: Preview, callId: string): LocalFilesReview {
    this.check();
    if (!this.canWrite) return fail('PERMISSION_DENIED');
    this.grants.set(preview.review.id, { preview, callId });
    return preview.review;
  }

  revoke(id: string): void {
    this.grants.delete(id);
  }

  execute(command: LocalFilesCommand): Promise<LocalFilesResult> {
    for (const [id, expiresAt] of this.cancelled)
      if (expiresAt <= Date.now()) this.cancelled.delete(id);
    if (this.cancelled.has(command.id))
      return Promise.resolve({ ok: false, error: { code: 'CANCELLED' } });
    const existing = this.active.get(command.id);
    if (existing) return existing;
    const controller = new AbortController();
    this.controllers.set(command.id, controller);
    const operation = this.perform(command, controller.signal).catch(
      (error: unknown): LocalFilesResult => ({
        ok: false,
        error: { code: filesystemError(error) },
      }),
    );
    this.active.set(command.id, operation);
    void operation.finally(() => {
      this.active.delete(command.id);
      this.controllers.delete(command.id);
    });
    return operation;
  }

  private async perform(
    command: LocalFilesCommand,
    signal: AbortSignal,
  ): Promise<LocalFilesResult> {
    this.check(command.expiresAt, signal);
    const parsed = localFilesInputSchema.safeParse(command.input);
    if (!parsed.success) return fail('INVALID_REQUEST');
    const input = parsed.data;
    if ((await this.folder.queryPermission({ mode: 'read' })) !== 'granted')
      return fail('PERMISSION_DENIED');
    if (input.operation === 'read') {
      const content = await text(
        await (await this.open(input.path)).getFile(),
        this.config.maxTextBytes,
      );
      this.check(command.expiresAt, signal);
      return {
        ok: true,
        value: {
          path: input.path,
          content,
        },
      };
    }
    if (input.operation === 'list') {
      let folder = this.folder;
      if (input.path)
        for (const part of input.path.split('/')) folder = await folder.getDirectoryHandle(part);
      const entries: { name: string; kind: 'file' | 'directory' }[] = [];
      let index = 0;
      let nextCursor: number | undefined;
      for await (const entry of folder.values()) {
        this.check(command.expiresAt, signal);
        if (index++ < input.cursor) continue;
        if (entries.length >= this.config.pageSize) {
          nextCursor = index - 1;
          break;
        }
        entries.push({ name: entry.name, kind: entry.kind });
      }
      return {
        ok: true,
        value: { path: input.path, entries, ...(nextCursor == null ? {} : { nextCursor }) },
      };
    }
    const previous = await this.journal.get(command.id);
    if (previous?.state === 'done' && previous.result) return previous.result;
    if (previous) return fail('EXECUTION_UNCERTAIN');
    const review = command.review;
    const grant = review && this.grants.get(review.id);
    if (
      !grant ||
      !review ||
      grant.callId !== command.toolCallId ||
      review.sessionId !== command.sessionId ||
      grant.preview.review.digest !== review.digest ||
      grant.preview.review.sessionId !== review.sessionId ||
      grant.preview.review.before.length !== review.before.length ||
      !review.before.every(
        (entry, index) =>
          entry.path === grant.preview.review.before[index]?.path &&
          entry.hash === grant.preview.review.before[index]?.hash,
      ) ||
      review.digest !== (await digest(new TextEncoder().encode(serializeLocalFiles(input)).buffer))
    )
      return fail('REVIEW_REQUIRED');
    this.grants.delete(review.id);
    if (!this.canWrite || (await this.folder.queryPermission({ mode: 'readwrite' })) !== 'granted')
      return fail('PERMISSION_DENIED');
    const commit = async (): Promise<LocalFilesResult> => {
      for (const expected of review.before) {
        let current: string | null;
        if (expected.hash == null) current = (await this.exists(expected.path)) ? 'exists' : null;
        else
          current = await this.hash(
            expected.path,
            input.operation === 'move' ? this.config.maxMoveBytes : this.config.maxTextBytes,
          );
        if (current !== expected.hash) return fail('CONFLICT');
      }
      this.check(command.expiresAt, signal);
      await this.journal.put(command.id, { state: 'started' });
      const result = await this.commit(
        input,
        grant.preview.after,
        command.expiresAt,
        signal,
        review.before,
      );
      await this.journal.put(command.id, { state: 'done', result });
      return result;
    };
    if (!navigator.locks) return fail('UNAVAILABLE');
    return navigator.locks.request(
      `librechat-local-files:${command.rootId}`,
      { signal: AbortSignal.any([this.controller.signal, signal]) },
      commit,
    );
  }

  private async commit(
    input: LocalFilesInput,
    content: string,
    expiresAt: number,
    signal: AbortSignal,
    before: LocalFilesReview['before'],
  ): Promise<LocalFilesResult> {
    const source = await this.parent(input.path);
    if (input.operation === 'mkdir') {
      this.check(expiresAt, signal);
      await source.folder.getDirectoryHandle(source.name, { create: true });
      return { ok: true, value: { path: input.path } };
    }
    if (input.operation === 'move') {
      const handle = await source.folder.getFileHandle(source.name);
      const original = await handle.getFile();
      const hash = await fingerprint(original, this.config.maxMoveBytes);
      if (hash !== before.find((entry) => entry.path === input.path)?.hash) return fail('CONFLICT');
      const target = await this.parent(input.destination);
      this.check(expiresAt, signal);
      if (await this.exists(input.destination)) return fail('CONFLICT');
      const destination = await target.folder.getFileHandle(target.name, { create: true });
      if ((await destination.getFile()).size !== 0) return fail('CONFLICT');
      const writable = await destination.createWritable();
      try {
        await writable.write(original);
        this.check(expiresAt, signal);
        if (
          (await destination.getFile()).size !== 0 ||
          !(await destination.isSameEntry(await target.folder.getFileHandle(target.name)))
        )
          return fail('CONFLICT');
        await writable.close();
      } catch (error) {
        await writable.abort().catch(() => undefined);
        throw error;
      }
      try {
        this.check(expiresAt, signal);
        if (
          (await fingerprint(await destination.getFile(), this.config.maxMoveBytes)) !== hash ||
          (await fingerprint(await handle.getFile(), this.config.maxMoveBytes)) !== hash ||
          !(await handle.isSameEntry(await source.folder.getFileHandle(source.name)))
        )
          return fail('COPY_RETAINED');
        await source.folder.removeEntry(source.name);
      } catch {
        return { ok: false, error: { code: 'COPY_RETAINED' } };
      }
      return { ok: true, value: { path: input.destination } };
    }
    if (input.operation !== 'write' && input.operation !== 'edit') return fail('INVALID_REQUEST');
    this.check(expiresAt, signal);
    const handle = await source.folder.getFileHandle(source.name, {
      create: input.operation === 'write',
    });
    const expected = before.find((entry) => entry.path === input.path)?.hash;
    if (expected == null && (await handle.getFile()).size !== 0) return fail('CONFLICT');
    const writable = await handle.createWritable();
    try {
      await writable.write(content);
      this.check(expiresAt, signal);
      if (expected == null && (await handle.getFile()).size !== 0) return fail('CONFLICT');
      if (
        expected != null &&
        (await fingerprint(await handle.getFile(), this.config.maxTextBytes)) !== expected
      )
        return fail('CONFLICT');
      if (!(await handle.isSameEntry(await source.folder.getFileHandle(source.name))))
        return fail('CONFLICT');
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => undefined);
      throw error;
    }
    return { ok: true, value: { path: input.path } };
  }
}

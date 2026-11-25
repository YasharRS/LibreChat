import { webcrypto } from 'node:crypto';
import { File as NativeFile } from 'node:buffer';
import { localFilesConfigSchema, localFilesCommandSchema } from 'librechat-data-provider';
import type { LocalFilesCommand, LocalFilesInput, LocalFilesResult } from 'librechat-data-provider';
import type { JournalEntry } from '../engine';
import { Filesystem, FilesystemError, replacements } from '../engine';
import { DiskFile, DiskFolder } from 'test/filesystem';

const sessionId = '00000000-0000-4000-8000-000000000001';
const rootId = '00000000-0000-4000-8000-000000000002';
function command(input: LocalFilesInput): LocalFilesCommand {
  return {
    version: 1,
    id: crypto.randomUUID(),
    sessionId,
    rootId,
    conversationId: 'chat',
    runId: 'run',
    toolCallId: 'call',
    input,
    expiresAt: Date.now() + 60000,
  };
}
let folder: DiskFolder;
let records: Map<string, JournalEntry>;
let engine: Filesystem;
beforeAll(() => {
  Object.defineProperty(globalThis, 'File', { configurable: true, value: NativeFile });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (_name: string, _options: object, run: () => Promise<LocalFilesResult>) =>
        run(),
    },
  });
});
beforeEach(() => {
  folder = new DiskFolder();
  folder.files.set('note.txt', new DiskFile('note.txt', 'original'));
  records = new Map();
  engine = new Filesystem(folder, localFilesConfigSchema.parse({}), {
    get: async (id) => records.get(id),
    put: async (id, value) => {
      records.set(id, value);
    },
  });
});
async function reviewed(input: LocalFilesInput): Promise<LocalFilesCommand> {
  await engine.enable();
  const proposal = await engine.preview(input, sessionId);
  return localFilesCommandSchema.parse({
    ...command(input),
    review: engine.approve(proposal, 'call'),
  });
}

it('reads without a write grant and leaves the disk unchanged', async () => {
  expect(await engine.inspect({ operation: 'read', path: 'note.txt' })).toEqual({
    ok: true,
    value: { path: 'note.txt', content: 'original' },
  });
  expect(folder.files.get('note.txt')?.writes).toBe(0);
});
it('never changes a file without a locally approved receipt', async () => {
  await engine.enable();
  expect(
    await engine.execute(command({ operation: 'write', path: 'note.txt', content: 'changed' })),
  ).toEqual({ ok: false, error: { code: 'REVIEW_REQUIRED' } });
  expect(folder.files.get('note.txt')?.content).toBe('original');
});
it('commits the reviewed change exactly once when a stream replays it', async () => {
  const request = await reviewed({ operation: 'write', path: 'note.txt', content: 'changed' });
  expect((await engine.execute(request)).ok).toBe(true);
  expect((await engine.execute(request)).ok).toBe(true);
  expect(folder.files.get('note.txt')?.writes).toBe(1);
});
it('ignores a cancelled command even when cancellation arrived before a replay', async () => {
  const request = await reviewed({ operation: 'write', path: 'note.txt', content: 'changed' });
  engine.cancel(request.id, request.expiresAt);
  expect(await engine.execute(request)).toEqual({ ok: false, error: { code: 'CANCELLED' } });
  expect(folder.files.get('note.txt')?.writes).toBe(0);
});
it('aborts a staged write if another writer changes the file before close', async () => {
  const request = await reviewed({ operation: 'write', path: 'note.txt', content: 'changed' });
  const file = folder.files.get('note.txt')!;
  const create = file.createWritable.bind(file);
  jest.spyOn(file, 'createWritable').mockImplementation(async () => {
    const stream = await create();
    return {
      ...stream,
      write: async (value) => {
        await stream.write(value);
        file.content = 'external change';
      },
    };
  });
  expect(await engine.execute(request)).toEqual({ ok: false, error: { code: 'CONFLICT' } });
  expect(file.content).toBe('external change');
  expect(file.writes).toBe(0);
});
it('cannot apply a receipt to another invocation', async () => {
  const request = await reviewed({ operation: 'write', path: 'note.txt', content: 'changed' });
  expect(await engine.execute({ ...request, toolCallId: 'other' })).toEqual({
    ok: false,
    error: { code: 'REVIEW_REQUIRED' },
  });
});
it('rejects a modified proposal', async () => {
  const request = await reviewed({ operation: 'write', path: 'note.txt', content: 'changed' });
  expect(
    await engine.execute({
      ...request,
      input: { operation: 'write', path: 'note.txt', content: 'unreviewed' },
    }),
  ).toEqual({ ok: false, error: { code: 'REVIEW_REQUIRED' } });
});
it('rejects a stale file without overwriting a concurrent edit', async () => {
  const request = await reviewed({ operation: 'write', path: 'note.txt', content: 'changed' });
  folder.files.get('note.txt')!.content = 'external edit';
  expect(await engine.execute(request)).toEqual({ ok: false, error: { code: 'CONFLICT' } });
  expect(folder.files.get('note.txt')?.content).toBe('external edit');
});
it.each(['write', 'move'] as const)(
  'does not overwrite a file created during a %s',
  async (operation) => {
    const request = await reviewed(
      operation === 'write'
        ? { operation, path: 'new.txt', content: 'proposed' }
        : { operation, path: 'note.txt', destination: 'new.txt' },
    );
    const get = folder.getFileHandle.bind(folder);
    jest.spyOn(folder, 'getFileHandle').mockImplementation(async (name, options) => {
      if (name === 'new.txt' && options?.create)
        folder.files.set(name, new DiskFile(name, 'created externally'));
      return get(name, options);
    });
    expect(await engine.execute(request)).toEqual({ ok: false, error: { code: 'CONFLICT' } });
    expect(folder.files.get('new.txt')?.content).toBe('created externally');
    expect(folder.files.get('note.txt')?.content).toBe('original');
  },
);
it('keeps unknown executions from being retried after interruption', async () => {
  const request = command({ operation: 'write', path: 'note.txt', content: 'changed' });
  records.set(request.id, { state: 'started' });
  expect(await engine.execute(request)).toEqual({
    ok: false,
    error: { code: 'EXECUTION_UNCERTAIN' },
  });
});
it('retains UTF-8 BOM and CRLF on an edit', async () => {
  folder.files.get('note.txt')!.content = '\uFEFFfirst\r\nsecond\r\n';
  const request = await reviewed({
    operation: 'edit',
    path: 'note.txt',
    edits: [{ oldText: 'first\nsecond', newText: 'updated\nsecond' }],
  });
  expect((await engine.execute(request)).ok).toBe(true);
  expect(folder.files.get('note.txt')?.content).toBe('\uFEFFupdated\r\nsecond\r\n');
});
it('refuses ambiguous text replacements', () => {
  expect(() => replacements('same same', [{ oldText: 'same', newText: 'new' }])).toThrow(
    FilesystemError,
  );
});
it('moves a file only after verifying the new contents', async () => {
  const request = await reviewed({ operation: 'move', path: 'note.txt', destination: 'moved.txt' });
  expect((await engine.execute(request)).ok).toBe(true);
  expect(folder.files.has('note.txt')).toBe(false);
  expect(
    await folder.files
      .get('moved.txt')
      ?.getFile()
      .then((file) => file.text()),
  ).toBe('original');
});
it('keeps the source when removal fails', async () => {
  const request = await reviewed({ operation: 'move', path: 'note.txt', destination: 'moved.txt' });
  folder.denyRemoval = true;
  expect(await engine.execute(request)).toEqual({ ok: false, error: { code: 'COPY_RETAINED' } });
  expect(folder.files.has('note.txt')).toBe(true);
  expect(folder.files.has('moved.txt')).toBe(true);
});
it('does not replace an existing move destination', async () => {
  folder.files.set('moved.txt', new DiskFile('moved.txt', 'keep'));
  await expect(
    engine.preview({ operation: 'move', path: 'note.txt', destination: 'moved.txt' }, sessionId),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
});
it('cancels before committing when the folder disconnects', async () => {
  const request = await reviewed({ operation: 'write', path: 'note.txt', content: 'changed' });
  engine.disconnect();
  expect(await engine.execute(request)).toEqual({ ok: false, error: { code: 'CANCELLED' } });
  expect(folder.files.get('note.txt')?.content).toBe('original');
});
it('refuses revoked permissions and expired operations', async () => {
  const request = await reviewed({ operation: 'write', path: 'note.txt', content: 'changed' });
  folder.allowed = 'denied';
  expect(await engine.execute(request)).toEqual({
    ok: false,
    error: { code: 'PERMISSION_DENIED' },
  });
  expect(await engine.execute({ ...request, expiresAt: 0 })).toEqual({
    ok: false,
    error: { code: 'TIMEOUT' },
  });
});

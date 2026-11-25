import { build } from 'vite';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import type * as Fixture from '../setup/local-files';
import type { Folder, JournalEntry } from '../../client/src/components/Filesystem/engine';
import type { LocalFilesCommand } from '../../packages/data-provider/src/filesystem';

declare global {
  interface Window {
    LocalFilesFixture: typeof Fixture;
  }
}
let bundle: string;
test.beforeAll(async () => {
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: resolve(__dirname, '../setup/local-files.ts'),
        name: 'LocalFilesFixture',
        formats: ['iife'],
      },
    },
  });
  const result = Array.isArray(output) ? output[0] : output;
  if (!('output' in result)) throw new Error('Expected a browser fixture bundle');
  const chunk = result.output.find((item) => item.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Expected fixture JavaScript');
  bundle = chunk.code;
});
test('uses real browser handles and refuses unreviewed, stale, and replayed writes', async ({
  page,
}) => {
  await page.route('https://local-files.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Local file API test</title>',
    }),
  );
  await page.goto('https://local-files.test/');
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(async () => {
    const { Filesystem, localFilesConfigSchema } = window.LocalFilesFixture;
    const directory = await navigator.storage.getDirectory();
    const root = await directory.getDirectoryHandle(crypto.randomUUID(), { create: true });
    const file = await root.getFileHandle('note.txt', { create: true });
    const initial = await file.createWritable();
    await initial.write('original');
    await initial.close();
    // OPFS provides real file handles without a native picker; permissions there are intrinsic.
    const folder: Folder = Object.assign(root, {
      queryPermission: async (): Promise<PermissionState> => 'granted',
      requestPermission: async (): Promise<PermissionState> => 'granted',
    });
    const records = new Map<string, JournalEntry>();
    const engine = new Filesystem(folder, localFilesConfigSchema.parse({}), {
      get: async (id) => records.get(id),
      put: async (id, value) => {
        records.set(id, value);
      },
    });
    await engine.enable();
    const sessionId = crypto.randomUUID();
    const input = { operation: 'write', path: 'note.txt', content: 'approved' } as const;
    const command: LocalFilesCommand = {
      version: 1,
      id: crypto.randomUUID(),
      sessionId,
      rootId: crypto.randomUUID(),
      conversationId: 'chat',
      runId: 'run',
      toolCallId: 'call',
      input,
      expiresAt: Date.now() + 60000,
    };
    const denied = await engine.execute(command);
    const original = await (await file.getFile()).text();
    const preview = await engine.preview(input, sessionId);
    const approved = {
      ...command,
      id: crypto.randomUUID(),
      review: engine.approve(preview, 'call'),
    };
    const first = await engine.execute(approved);
    const second = await engine.execute(approved);
    const contents = await (await file.getFile()).text();
    const stalePreview = await engine.preview({ ...input, content: 'stale' }, sessionId);
    const stale = {
      ...command,
      id: crypto.randomUUID(),
      input: { ...input, content: 'stale' },
      review: engine.approve(stalePreview, 'call'),
    };
    const external = await file.createWritable();
    await external.write('external');
    await external.close();
    const conflicted = await engine.execute(stale);
    const retained = await (await file.getFile()).text();
    return { denied, original, first, second, contents, conflicted, retained };
  });
  expect(result.denied).toEqual({ ok: false, error: { code: 'REVIEW_REQUIRED' } });
  expect(result.original).toBe('original');
  expect(result.first.ok).toBe(true);
  expect(result.second).toEqual(result.first);
  expect(result.contents).toBe('approved');
  expect(result.conflicted).toEqual({ ok: false, error: { code: 'CONFLICT' } });
  expect(result.retained).toBe('external');
});

test('keeps folder identities stable across tabs, isolates accounts and removes handles on logout', async ({
  page,
}) => {
  await page.route('https://local-files.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Local folder registry</title>',
    }),
  );
  await page.goto('https://local-files.test/');
  await page.addScriptTag({ content: bundle });
  const result = await page.evaluate(async () => {
    const { registerFolder, recallFolder, forgetFolders } = window.LocalFilesFixture;
    const directory = await navigator.storage.getDirectory();
    const first = await directory.getDirectoryHandle(crypto.randomUUID(), { create: true });
    const second = await directory.getDirectoryHandle(crypto.randomUUID(), { create: true });
    const folder = (root: FileSystemDirectoryHandle): Folder =>
      Object.assign(root, {
        queryPermission: async (): Promise<PermissionState> => 'granted',
        requestPermission: async (): Promise<PermissionState> => 'granted',
      });
    const one = await registerFolder('owner', folder(first));
    await registerFolder('owner', folder(second));
    const again = await registerFolder('owner', folder(first));
    const [parallel] = await Promise.all([
      registerFolder('owner', folder(first)),
      registerFolder('owner', folder(first)),
    ]);
    const other = await registerFolder('other-owner', folder(first));
    const remembered = await recallFolder('owner');
    await forgetFolders('owner');
    return {
      one,
      again,
      parallel,
      other,
      remembered: remembered?.root,
      removed: await recallFolder('owner'),
      retained: (await recallFolder('other-owner'))?.root,
    };
  });
  expect(result.again.id).toBe(result.one.id);
  expect(result.parallel.id).toBe(result.one.id);
  expect(result.again.access).toBe('read');
  expect(result.other.id).not.toBe(result.one.id);
  expect(result.remembered?.id).toBe(result.one.id);
  expect(result.removed).toBeUndefined();
  expect(result.retained?.id).toBe(result.other.id);
  const peer = await page.context().newPage();
  await peer.route('https://local-files.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Peer folder registry</title>',
    }),
  );
  await peer.goto('https://local-files.test/');
  await peer.addScriptTag({ content: bundle });
  const shared = await peer.evaluate(async () => {
    const { registerFolder, recallFolder } = window.LocalFilesFixture;
    const saved = await recallFolder('other-owner');
    if (!saved) throw new Error('Expected the peer account folder');
    return registerFolder('other-owner', saved.folder);
  });
  expect(shared.id).toBe(result.other.id);
  await peer.close();
});

import path from 'node:path';
import { test, expect } from '@playwright/test';
import { localFilesConfigSchema } from 'librechat-data-provider';
import { createLocalFilesReader } from '../../packages/api/src/filesystem/reader';
import { messagesView } from '../specs/mock/helpers';

for (const extension of ['pdf', 'docx', 'xlsx', 'pptx', 'binary']) {
  test(`creates ${extension} through the real chat without a per-file approval`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'showDirectoryPicker', {
        configurable: true,
        value: async () =>
          Object.assign(
            await (
              await navigator.storage.getDirectory()
            ).getDirectoryHandle('direct-test', { create: true }),
            { queryPermission: async () => 'granted', requestPermission: async () => 'granted' },
          ),
      });
    });
    await page.goto('/c/new');
    await page.getByRole('button', { name: 'Local folder', exact: true }).click();
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
    await expect(page.getByText('Read only', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Enable changes', exact: true }).click();
    await expect(page.getByText('Changes enabled without per-file review')).toBeVisible();
    const composer = page.locator('#prompt-textarea');
    await composer.fill(`LOCAL_CREATE_${extension.toUpperCase()}`);
    await composer.press('Enter');
    await expect(messagesView(page)).toContainText('Local file operation complete.');
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0);
    const filename = `created.${extension === 'binary' ? 'dat' : extension}`;
    const bytes = Buffer.from(
      await page.evaluate(async (name) => {
        const folder = await (
          await navigator.storage.getDirectory()
        ).getDirectoryHandle('direct-test');
        const file = await (await folder.getFileHandle(name)).getFile();
        return Array.from(new Uint8Array(await file.arrayBuffer()));
      }, filename),
    );
    if (extension === 'binary') {
      expect(bytes).toEqual(Buffer.from([0, 1, 128, 255]));
      return;
    }
    const read = createLocalFilesReader(
      path.resolve(__dirname, '../../packages/api/dist/filesystem/reader-worker.cjs'),
    );
    expect(
      await read({
        input: { operation: 'read', path: filename },
        data: bytes,
        config: localFilesConfigSchema.parse({}),
        signal: new AbortController().signal,
      }),
    ).toMatchObject({
      ok: true,
      value: { content: expect.stringContaining('Document generation verified') },
    });
  });
}

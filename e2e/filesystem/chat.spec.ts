import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { randomFillSync } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';
import { messagesView } from '../specs/mock/helpers';
import { collapseComposerApproval } from '../specs/mock/approvals.helpers';
import { samplePdf } from '../../packages/api/src/filesystem/samples.helper';

test('connects a read-only folder, then requires one-time review before the real chat writes', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async () => {
        const root = await navigator.storage.getDirectory();
        const folder = await root.getDirectoryHandle('local-chat-test', { create: true });
        const file = await folder.getFileHandle('note.txt', { create: true });
        const writable = await file.createWritable();
        await writable.write('local original');
        await writable.close();
        return Object.assign(folder, {
          queryPermission: async () => 'granted',
          requestPermission: async () => 'granted',
        });
      },
    });
  });
  await page.goto('/c/new');
  // The shared authentication fixture opens the sidebar.
  const folderTab = page.getByRole('button', { name: 'Local folder', exact: true });
  await expect(folderTab).toBeVisible();
  await folderTab.click();
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
  await expect(page.getByText('Read only', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'note.txt', exact: true }).click();
  await expect(page.getByText('local original', { exact: true })).toBeVisible();
  const composer = page.locator('#prompt-textarea');
  const delivered = page.waitForRequest(
    (request) =>
      request.method() === 'POST' &&
      /\/api\/local-files\/sessions\/[^/]+\/results\//.test(new URL(request.url()).pathname),
    { timeout: 15000 },
  );
  await composer.fill('LOCAL_READ');
  await composer.press('Enter');
  expect((await delivered).postDataJSON()).toEqual({
    ok: true,
    value: { path: 'note.txt', content: 'local original' },
  });
  await expect(messagesView(page)).toContainText('Local file operation complete.');
  await page.getByRole('button', { name: 'Enable changes with review', exact: true }).click();
  await composer.fill('LOCAL_WRITE');
  await composer.press('Enter');
  await collapseComposerApproval(page);
  await expect(page.getByText('Proposed contents', { exact: true })).toBeVisible();
  await expect(page.getByText('reviewed by the owner', { exact: true }).first()).toBeVisible();
  expect(
    await page.evaluate(async () =>
      (
        await (
          await (await navigator.storage.getDirectory()).getDirectoryHandle('local-chat-test')
        ).getFileHandle('note.txt')
      )
        .getFile()
        .then((file) => file.text()),
    ),
  ).toBe('local original');
  const approve = page.getByRole('button', { name: 'Approve', exact: true });
  await approve.click();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (
          await (
            await (await navigator.storage.getDirectory()).getDirectoryHandle('local-chat-test')
          ).getFileHandle('note.txt')
        )
          .getFile()
          .then((file) => file.text()),
      ),
    )
    .toBe('reviewed by the owner');
});

for (const format of [
  { name: 'report.pdf', prompt: 'LOCAL_PDF' },
  { name: 'letter.docx', prompt: 'LOCAL_WORD' },
  { name: 'photo.png', prompt: 'LOCAL_IMAGE' },
]) {
  test(`reads ${format.name} through native handles, authenticated extraction and model tool content`, async ({
    page,
  }) => {
    let bytes: Buffer;
    if (format.prompt === 'LOCAL_PDF') bytes = samplePdf(['PDF extraction verified']);
    else if (format.prompt === 'LOCAL_WORD')
      bytes = await readFile(
        path.resolve(__dirname, '../../packages/api/src/files/documents/sample.docx'),
      );
    else
      bytes = await sharp(randomFillSync(Buffer.alloc(1400 * 1000 * 3)), {
        raw: { width: 1400, height: 1000, channels: 3 },
      })
        .png()
        .toBuffer();
    await page.addInitScript(
      ({ name, data }) => {
        Object.defineProperty(window, 'showDirectoryPicker', {
          configurable: true,
          value: async () => {
            const folder = await (
              await navigator.storage.getDirectory()
            ).getDirectoryHandle('format-test', { create: true });
            const file = await folder.getFileHandle(name, { create: true });
            const writer = await file.createWritable();
            await writer.write(Uint8Array.from(atob(data), (character) => character.charCodeAt(0)));
            await writer.close();
            return Object.assign(folder, {
              queryPermission: async () => 'granted',
              requestPermission: async () => 'granted',
            });
          },
        });
      },
      { name: format.name, data: bytes.toString('base64') },
    );
    await page.goto('/c/new');
    const folderTab = page.getByRole('button', { name: 'Local folder', exact: true });
    await expect(folderTab).toBeVisible();
    await folderTab.click();
    await page.getByRole('button', { name: 'Choose folder', exact: true }).click();
    await expect(page.getByText('Read only', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: format.name, exact: true }).click();
    await expect(page.getByText(/This preview stays local/)).toBeVisible();
    if (format.prompt === 'LOCAL_IMAGE') {
      const preview = page.getByRole('img', { name: 'Local file preview' });
      await expect(preview).toBeVisible();
      await expect
        .poll(() => preview.evaluate((element: HTMLImageElement) => element.naturalWidth))
        .toBe(1400);
    }
    const result = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        /\/api\/local-files\/sessions\/[^/]+\/results\//.test(new URL(response.url()).pathname),
    );
    await page.locator('#prompt-textarea').fill(format.prompt);
    await page.locator('#prompt-textarea').press('Enter');
    expect((await result).status()).toBe(204);
    await expect(messagesView(page)).toContainText('Local file operation complete.');
    await expect(messagesView(page)).not.toContainText('Extraction verification failed.');
  });
}

import { test, expect } from '@playwright/test';
import { messagesView } from '../specs/mock/helpers';
import { collapseComposerApproval } from '../specs/mock/approvals.helpers';

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

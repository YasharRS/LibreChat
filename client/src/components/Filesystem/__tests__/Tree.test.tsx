import React from 'react';
import { webcrypto } from 'node:crypto';
import { localFilesConfigSchema } from 'librechat-data-provider';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Connection } from '../connection';
import { DiskFile, DiskFolder } from 'test/filesystem';
import { Filesystem } from '../engine';
import Tree from '../Tree';

beforeAll(() =>
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto }),
);
let client: QueryClient;
afterEach(() => client.clear());
function mount(folder: DiskFolder) {
  client = new QueryClient({
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
  });
  const entry: Connection = {
    owner: 'user',
    conversationId: 'chat',
    client,
    root: { id: crypto.randomUUID(), name: folder.name, access: 'read' },
    engine: new Filesystem(folder, localFilesConfigSchema.parse({ pageSize: 1 }), {
      get: async () => undefined,
      put: async () => undefined,
    }),
  };
  const open = jest.fn();
  render(
    <QueryClientProvider client={client}>
      <Tree entry={entry} onOpen={open} />
    </QueryClientProvider>,
  );
  return open;
}
it('browses nested folders and pages without uploading the folder', async () => {
  const folder = new DiskFolder();
  const child = new DiskFolder('nested');
  child.files.set('note.txt', new DiskFile('note.txt'));
  folder.folders.set(child.name, child);
  folder.files.set('next.txt', new DiskFile('next.txt'));
  const open = mount(folder);
  const expand = await screen.findByRole('button', { name: 'nested' });
  expect(expand).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(expand);
  fireEvent.click(await screen.findByRole('button', { name: 'note.txt' }));
  expect(open).toHaveBeenCalledWith('nested/note.txt');
  fireEvent.click(screen.getByRole('button', { name: /Load more/i }));
  expect(await screen.findByRole('button', { name: 'next.txt' })).toBeInTheDocument();
});
it('shows an empty folder', async () => {
  mount(new DiskFolder());
  expect(await screen.findByText(/folder is empty/i)).toBeInTheDocument();
});
it('explains a revoked permission without disclosing native diagnostics', async () => {
  const folder = new DiskFolder();
  folder.allowed = 'denied';
  mount(folder);
  expect(await screen.findByRole('alert')).toHaveTextContent(/permission/i);
});

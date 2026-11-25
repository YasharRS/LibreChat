import React from 'react';
import { RecoilRoot } from 'recoil';
import { webcrypto } from 'node:crypto';
import { File as NativeFile } from 'node:buffer';
import { localFilesConfigSchema } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Agents } from 'librechat-data-provider';
import type { Connection } from '../connection';
import ApprovalProvider, {
  useApprovalContext,
} from '~/components/Chat/Messages/Content/ApprovalContext';
import { clearLocalFiles, localFilesOwner, setConnection, setLocalFilesOwner } from '../connection';
import { DiskFile, DiskFolder } from 'test/filesystem';
import { ChatContext } from '~/Providers/ChatContext';
import { Filesystem } from '../engine';
import Review from '../Review';

// The resume HTTP boundary is external to a local review; keep the real approval store.
jest.mock('~/data-provider', () => ({
  useSubmitToolApprovalMutation: () => ({ mutate: jest.fn() }),
  useSubmitAskAnswerMutation: () => ({ mutate: jest.fn() }),
}));
jest.mock('~/Providers/ChatContext', () => ({
  ChatContext: jest.requireActual('react').createContext(null),
}));

const approval: NonNullable<Agents.ToolCall['approval']> = {
  actionId: 'action',
  allowed_decisions: ['approve', 'reject', 'edit'],
  allow_always: true,
};
let entry: Connection;
let folder: DiskFolder;
let client: QueryClient;
beforeAll(() => {
  Object.defineProperty(globalThis, 'File', { configurable: true, value: NativeFile });
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
});
beforeEach(async () => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
  });
  folder = new DiskFolder();
  folder.files.set('note.txt', new DiskFile('note.txt', 'original'));
  const config = localFilesConfigSchema.parse({ enabled: true });
  const engine = new Filesystem(folder, config, {
    get: async () => undefined,
    put: async () => undefined,
  });
  await engine.enable();
  const owner = localFilesOwner({ id: 'user' })!;
  const root = { id: crypto.randomUUID(), name: 'workspace', access: 'readwrite' as const };
  entry = {
    owner,
    root,
    conversationId: 'chat',
    engine,
    client,
    session: { id: crypto.randomUUID(), token: 'memory-only-token', config, root, version: 2 },
  };
  setLocalFilesOwner(owner);
  setConnection('chat', entry);
});
afterEach(() => {
  entry.session = undefined;
  clearLocalFiles();
  client.clear();
});
function Probe() {
  const state = useApprovalContext();
  return (
    <output data-testid="decision">{JSON.stringify(state.getDecision('action', 'call'))}</output>
  );
}
function mount(args: string | Record<string, unknown> = { path: 'note.txt', content: 'proposed' }) {
  return render(
    <QueryClientProvider client={client}>
      <RecoilRoot>
        <ApprovalProvider>
          <ChatContext.Provider
            value={
              { conversation: { conversationId: 'chat' } } as React.ContextType<typeof ChatContext>
            }
          >
            <Review name="local_write" approval={approval} toolCallId="call" args={args} />
            <Probe />
          </ChatContext.Provider>
        </ApprovalProvider>
      </RecoilRoot>
    </QueryClientProvider>,
  );
}
it('shows the exact before and after, and grants only a single reviewed operation', async () => {
  mount();
  expect(await screen.findByText('original')).toBeInTheDocument();
  expect(screen.getByText('proposed')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Always allow/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(screen.getByTestId('decision')).toHaveTextContent('"scope":"once"'));
  expect(screen.getByTestId('decision')).toHaveTextContent(entry.session!.id);
  expect(folder.files.get('note.txt')?.writes).toBe(0);
  fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
  expect(screen.getByTestId('decision')).not.toHaveTextContent('localFiles');
});
it('cannot approve a pending operation in a disconnected tab', async () => {
  mount();
  await screen.findByText('original');
  act(() => setConnection('chat', undefined));
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled();
});
it('renders an actionable failure without exposing malformed arguments or native errors', async () => {
  mount('{secret invalid JSON');
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(screen.queryByText(/secret invalid JSON/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
});

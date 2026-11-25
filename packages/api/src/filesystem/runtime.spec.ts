import { createHash, randomUUID } from 'node:crypto';
import { localFilesConfigSchema, serializeLocalFiles } from 'librechat-data-provider';
import type { Agents, LocalFilesInput, LocalFilesReview } from 'librechat-data-provider';
import type { LocalFilesBinding } from './service';
import {
  createLocalFilesTools,
  markLocalFileApprovalRequests,
  localFilesApprovalHook,
} from './runtime';

it('never offers remembered or edited decisions for local writes', () => {
  const payload: Agents.ToolApprovalInterruptPayload = {
    type: 'tool_approval',
    action_requests: [
      {
        name: 'local_write',
        tool_call_id: 'call',
        arguments: { path: 'note.txt', content: 'new' },
      },
    ],
    review_configs: [
      {
        action_name: 'local_write',
        tool_call_id: 'call',
        allowed_decisions: ['approve', 'reject', 'edit'],
        allow_always: true,
      },
    ],
  };
  expect(markLocalFileApprovalRequests(payload).review_configs[0]).toMatchObject({
    allow_always: false,
    allowed_decisions: ['approve', 'reject'],
  });
});
it('installs a mandatory ask decision instead of trusting a bypass preference', async () => {
  const input = {
    hook_event_name: 'PreToolUse' as const,
    runId: 'run',
    toolUseId: 'call',
    toolName: 'local_write',
    toolInput: { path: 'note.txt', content: 'new' },
  };
  const result = await localFilesApprovalHook(input, new AbortController().signal);
  expect(result).toMatchObject({ decision: 'ask', allowedDecisions: ['approve', 'reject'] });
});

function binding(decisions: Agents.ToolApprovalResolution[] = []): LocalFilesBinding {
  return {
    sessionId: randomUUID(),
    config: localFilesConfigSchema.parse({ enabled: true }),
    decisions,
    root: async () => undefined,
    invoke: jest.fn(async () => ({ ok: true as const, value: { path: 'note.txt' } })),
  };
}
it('uses the real tool invocation ID and each operation’s required input contract', async () => {
  const session = binding();
  const tools = createLocalFilesTools(session, 'chat', new AbortController().signal, false);
  expect(tools.map((entry) => entry.name)).toEqual(['local_list', 'local_read']);
  const read = tools.find((entry) => entry.name === 'local_read')!;
  await read.invoke({
    type: 'tool_call',
    id: 'call',
    name: 'local_read',
    args: { path: 'note.txt' },
  });
  expect(session.invoke).toHaveBeenCalledWith(
    expect.objectContaining({
      toolCallId: 'call',
      conversationId: 'chat',
      input: { operation: 'read', path: 'note.txt' },
    }),
    expect.any(AbortSignal),
  );
  await expect(read.invoke({})).rejects.toThrow();
});
it('dispatches a mutation only with a once-only receipt for the same session and arguments', async () => {
  const session = binding();
  const write = createLocalFilesTools(session, 'chat', new AbortController().signal, true).find(
    (entry) => entry.name === 'local_write',
  )!;
  const input: LocalFilesInput = { operation: 'write', path: 'note.txt', content: 'new' };
  const call = {
    type: 'tool_call' as const,
    id: 'call',
    name: 'local_write',
    args: { path: input.path, content: 'new' },
  };
  await write.invoke(call);
  expect(session.invoke).not.toHaveBeenCalled();
  const review: LocalFilesReview = {
    id: randomUUID(),
    sessionId: session.sessionId,
    digest: createHash('sha256').update(serializeLocalFiles(input)).digest('hex'),
    before: [{ path: 'note.txt', hash: null }],
  };
  session.decisions.push({
    tool_call_id: 'call',
    decision: 'approve',
    scope: 'session',
    localFiles: review,
  });
  await write.invoke(call);
  expect(session.invoke).not.toHaveBeenCalled();
  session.decisions[0].scope = 'once';
  await write.invoke(call);
  expect(session.invoke).toHaveBeenCalledTimes(1);
  await write.invoke({ ...call, args: { ...call.args, content: 'changed after approval' } });
  expect(session.invoke).toHaveBeenCalledTimes(1);
});
it('translates an operational failure at the tool boundary without exposing diagnostics', async () => {
  const session = binding();
  session.invoke = async () => {
    throw new Error('password=secret cache payload');
  };
  const read = createLocalFilesTools(session, 'chat', new AbortController().signal, false).find(
    (entry) => entry.name === 'local_read',
  )!;
  const result = await read.invoke({
    type: 'tool_call',
    id: 'call',
    name: 'local_read',
    args: { path: 'note.txt' },
  });
  expect(JSON.stringify(result)).toContain('UNAVAILABLE');
  expect(JSON.stringify(result)).not.toMatch(/password|secret|cache payload/);
});

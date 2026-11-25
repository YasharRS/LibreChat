import { createHash, randomUUID } from 'node:crypto';
import { createToolPolicyHook } from '@librechat/agents';
import { AIMessage, HumanMessage } from '@librechat/agents/langchain/messages';
import { localFilesConfigSchema, serializeLocalFiles } from 'librechat-data-provider';
import { projectArtifactPayload, projectOpenAIChatToolMessageContent } from '@librechat/agents';
import type {
  Agents,
  LocalFilesInput,
  LocalFilesReview,
  TToolApprovalPolicy,
} from 'librechat-data-provider';
import type { LocalFilesBinding } from './service';
import {
  createLocalFilesTools,
  markLocalFileApprovalRequests,
  localFilesApprovalHook,
  localFilesDirectHook,
  localFilesToolPolicy,
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
it('allows direct local writes under the default policy without overriding explicit ask/deny rules', async () => {
  const config = localFilesConfigSchema.parse({ requireReview: false });
  const input = {
    hook_event_name: 'PreToolUse' as const,
    runId: 'run',
    toolUseId: 'call',
    toolName: 'local_write',
    toolInput: { path: 'report.pdf', content: 'Text' },
  };
  const policies: Array<[TToolApprovalPolicy, string]> = [
    [{ enabled: true }, 'allow'],
    [{ enabled: true, deny: ['local_*'] }, 'deny'],
    [{ enabled: true, ask: ['local_write'] }, 'ask'],
  ];
  for (const [policy, expected] of policies) {
    const hook = createToolPolicyHook(localFilesToolPolicy({ ...policy }, config)!);
    expect(await hook(input, new AbortController().signal)).toMatchObject({ decision: expected });
  }
  expect(await localFilesDirectHook(input, new AbortController().signal)).toEqual({
    decision: 'allow',
  });
});
it('dispatches direct writes without a review receipt and still validates binary encoding', async () => {
  const session = binding();
  session.config.requireReview = false;
  const write = createLocalFilesTools(session, 'chat', new AbortController().signal, true).find(
    (tool) => tool.name === 'local_write',
  )!;
  const call = {
    type: 'tool_call' as const,
    id: 'call',
    name: 'local_write',
    args: { path: 'report.pdf', content: 'AAGA/w==', encoding: 'base64' },
  };
  await write.invoke(call);
  expect(session.invoke).toHaveBeenCalledTimes(1);
  const result = await write.invoke({ ...call, args: { ...call.args, content: 'not base64!' } });
  expect(result.content).toContain('INVALID_REQUEST');
  expect(session.invoke).toHaveBeenCalledTimes(1);
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
    undefined,
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
it('delivers image blocks through a real SDK ToolMessage for multimodal inference', async () => {
  const session = binding();
  session.invoke = async () => ({
    ok: true,
    value: { path: 'photo.png', images: [{ mime: 'image/jpeg', data: 'aW1hZ2U=' }] },
  });
  const read = createLocalFilesTools(session, 'chat', new AbortController().signal, false).find(
    (entry) => entry.name === 'local_read',
  )!;
  const result = await read.invoke({
    type: 'tool_call',
    id: 'image-call',
    name: 'local_read',
    args: { path: 'photo.png' },
  });
  expect(result.content).toBe(
    JSON.stringify({ ok: true, value: { path: 'photo.png', images: [{}] } }),
  );
  const blocks = [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,aW1hZ2U=' } }];
  expect(result.artifact).toEqual({ content: blocks });
  const messages = projectOpenAIChatToolMessageContent(
    projectArtifactPayload([
      new AIMessage({
        content: '',
        tool_calls: [
          { type: 'tool_call', id: 'image-call', name: 'local_read', args: { path: 'photo.png' } },
        ],
      }),
      result,
    ]),
  );
  expect(messages[messages.length - 1]).toBeInstanceOf(HumanMessage);
  expect(messages[messages.length - 1].content).toEqual(expect.arrayContaining(blocks));
});

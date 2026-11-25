const { FakeChatModel } = require('@librechat/agents');

module.exports = (run, context) => {
  const write = JSON.stringify(context.messages ?? []).includes('LOCAL_WRITE');
  const name = write ? 'local_write' : 'local_read';
  const id = write ? 'local-write-call' : 'local-read-call';
  class Model extends FakeChatModel {
    async *_streamResponseChunks(restored, options, manager) {
      if (restored.some((message) => message.tool_call_id === id)) {
        yield* new FakeChatModel({
          responses: ['Local file operation complete.'],
        })._streamResponseChunks(restored, options, manager);
        return;
      }
      yield* super._streamResponseChunks(restored, options, manager);
    }
  }
  const model = new Model({
    responses: ['', 'Local file operation complete.'],
    toolCalls: [
      {
        type: 'tool_call',
        name,
        id,
        args: { path: 'note.txt', ...(write ? { content: 'reviewed by the owner' } : {}) },
      },
    ],
  });
  model.callbacks = context.modelCallbacks;
  run.Graph.overrideModel = model;
};

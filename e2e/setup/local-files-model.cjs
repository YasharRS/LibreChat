const { FakeChatModel } = require('@librechat/agents');

module.exports = (run, context) => {
  const prompt = JSON.stringify(context.messages ?? []);
  const write = prompt.includes('LOCAL_WRITE');
  const pdf = prompt.includes('LOCAL_PDF');
  const word = prompt.includes('LOCAL_WORD');
  const image = prompt.includes('LOCAL_IMAGE');
  const path = pdf ? 'report.pdf' : word ? 'letter.docx' : image ? 'photo.png' : 'note.txt';
  const name = write ? 'local_write' : 'local_read';
  const id = write ? 'local-write-call' : 'local-read-call';
  class Model extends FakeChatModel {
    async *_streamResponseChunks(restored, options, manager) {
      if (restored.some((message) => message.tool_call_id === id)) {
        const result = restored.find((message) => message.tool_call_id === id);
        const content = JSON.stringify(result.content);
        const verified = pdf
          ? content.includes('PDF extraction verified')
          : word
            ? content.includes('This is a sample DOCX file.')
            : image
              ? restored.some(
                  (message) =>
                    Array.isArray(message.content) &&
                    message.content.some(
                      (block) =>
                        block.type === 'image_url' &&
                        block.image_url.url.startsWith('data:image/jpeg;base64,'),
                    ),
                )
              : true;
        yield* new FakeChatModel({
          responses: [
            verified ? 'Local file operation complete.' : 'Extraction verification failed.',
          ],
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
        args: { path, ...(write ? { content: 'reviewed by the owner' } : {}) },
      },
    ],
  });
  model.callbacks = context.modelCallbacks;
  run.Graph.overrideModel = model;
};

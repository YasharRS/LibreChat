const { FakeChatModel } = require('@librechat/agents');

module.exports = (run, context) => {
  const prompt = JSON.stringify(context.messages ?? []);
  const generated = [
    { marker: 'LOCAL_CREATE_PDF', path: 'created.pdf', content: 'Document generation verified' },
    { marker: 'LOCAL_CREATE_DOCX', path: 'created.docx', content: 'Document generation verified' },
    {
      marker: 'LOCAL_CREATE_XLSX',
      path: 'created.xlsx',
      content: 'Name,Value\nDocument generation verified,42',
    },
    {
      marker: 'LOCAL_CREATE_PPTX',
      path: 'created.pptx',
      content: 'Title\nDocument generation verified',
    },
    { marker: 'LOCAL_CREATE_BINARY', path: 'created.dat', content: 'AAGA/w==', encoding: 'base64' },
  ].find((entry) => prompt.includes(entry.marker));
  const write = !!generated || prompt.includes('LOCAL_WRITE');
  const pdf = prompt.includes('LOCAL_PDF');
  const word = prompt.includes('LOCAL_WORD');
  const image = prompt.includes('LOCAL_IMAGE');
  let path = 'note.txt';
  if (pdf) path = 'report.pdf';
  else if (word) path = 'letter.docx';
  else if (image) path = 'photo.png';
  if (generated) path = generated.path;
  const name = write ? 'local_write' : 'local_read';
  const id = write ? 'local-write-call' : 'local-read-call';
  class Model extends FakeChatModel {
    async *_streamResponseChunks(restored, options, manager) {
      if (restored.some((message) => message.tool_call_id === id)) {
        const result = restored.find((message) => message.tool_call_id === id);
        const content = JSON.stringify(result.content);
        let verified = true;
        if (pdf) verified = content.includes('PDF extraction verified');
        else if (word) verified = content.includes('This is a sample DOCX file.');
        else if (image)
          verified = restored.some(
            (message) =>
              Array.isArray(message.content) &&
              message.content.some(
                (block) =>
                  block.type === 'image_url' &&
                  block.image_url.url.startsWith('data:image/jpeg;base64,'),
              ),
          );
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
        args: {
          path,
          ...(write ? { content: generated?.content ?? 'reviewed by the owner' } : {}),
          ...(generated?.encoding ? { encoding: generated.encoding } : {}),
        },
      },
    ],
  });
  model.callbacks = context.modelCallbacks;
  run.Graph.overrideModel = model;
};

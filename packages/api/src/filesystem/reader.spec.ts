import JSZip from 'jszip';
import sharp from 'sharp';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { localFilesConfigSchema } from 'librechat-data-provider';
import type { LocalFilesConfig, LocalFilesInput } from 'librechat-data-provider';
import { createLocalFilesReader } from './reader';
import { samplePdf } from './samples.helper';

const reader = createLocalFilesReader(
  path.join(__dirname, '../../dist/filesystem/reader-worker.cjs'),
);
function extract(
  name: string,
  data: Buffer,
  config: Partial<LocalFilesConfig> = {},
  pages: Pick<Extract<LocalFilesInput, { operation: 'read' }>, 'startPage' | 'endPage'> = {},
) {
  return reader({
    input: { operation: 'read', path: name, ...pages },
    data,
    config: localFilesConfigSchema.parse(config),
    signal: new AbortController().signal,
  });
}

it.each([
  ['docx', 'This is a sample DOCX file.'],
  ['xlsx', 'Data,on,first,sheet'],
  ['xls', 'Data,on,first,sheet'],
  ['ods', 'Data,on,first,sheet'],
  ['odt', 'This is a sample ODT file.'],
  ['pptx', ''],
])(
  'reads a real %s document without creating server files',
  async (extension, expected) => {
    const result = await extract(
      `sample.${extension}`,
      await readFile(path.join(__dirname, `../files/documents/sample.${extension}`)),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toContain(expected);
      expect(result.value.content?.length).toBeGreaterThan(5);
      expect(result.value.binary).toBeUndefined();
    }
  },
  30000,
);

it('extracts complete PDF text, supports ranges, and refuses excess pages without truncating', async () => {
  const data = samplePdf(['Alpha report', 'Beta report']);
  const result = await extract('report.pdf', data);
  expect(result).toEqual({
    ok: true,
    value: { path: 'report.pdf', content: '[Page 1]\nAlpha report\n\n[Page 2]\nBeta report' },
  });
  expect(await extract('report.pdf', data, { maxPages: 1 })).toEqual({
    ok: false,
    error: { code: 'TOO_LARGE' },
  });
  expect(
    await extract('report.pdf', data, { maxPages: 1 }, { startPage: 2, endPage: 2 }),
  ).toMatchObject({ ok: true, value: { content: '[Page 2]\nBeta report' } });
}, 30000);

it('renders textless PDF pages as bounded images for a vision model', async () => {
  const result = await extract('scan.pdf', samplePdf(['']));
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.images?.[0]).toMatchObject({ mime: 'image/jpeg', page: 1 });
    const metadata = await sharp(Buffer.from(result.value.images![0].data, 'base64')).metadata();
    expect(metadata.format).toBe('jpeg');
  }
}, 30000);

it('normalizes actual images and rejects active content renamed as an image', async () => {
  const data = await sharp({
    create: { width: 2400, height: 1200, channels: 3, background: 'red' },
  })
    .png()
    .toBuffer();
  const result = await extract('chart.png', data, { imageDimension: 800 });
  expect(result.ok).toBe(true);
  if (result.ok) {
    const metadata = await sharp(Buffer.from(result.value.images![0].data, 'base64')).metadata();
    expect(metadata).toMatchObject({ format: 'jpeg', width: 800, height: 400 });
  }
  expect(
    await extract(
      'unsafe.png',
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>private-secret</script></svg>',
      ),
    ),
  ).toEqual({ ok: false, error: { code: 'UNSUPPORTED_FORMAT' } });
}, 30000);

it('limits concurrent readers and releases the slot after cancellation', async () => {
  const controller = new AbortController();
  const request = {
    input: { operation: 'read' as const, path: 'report.pdf' },
    data: samplePdf(['Cancelled']),
    config: localFilesConfigSchema.parse({ maxReaders: 1 }),
    signal: controller.signal,
  };
  const pending = reader(request);
  expect(await reader(request)).toEqual({ ok: false, error: { code: 'PROCESSOR_BUSY' } });
  controller.abort();
  expect(await pending).toEqual({ ok: false, error: { code: 'CANCELLED' } });
  expect((await extract('report.pdf', samplePdf(['Next request']))).ok).toBe(true);
}, 30000);

it('bounds input, extracted text, image count and invalid files with safe codes', async () => {
  expect(await extract('bad.pdf', Buffer.from('password=private-secret'))).toEqual({
    ok: false,
    error: { code: 'UNREADABLE_FILE' },
  });
  expect(await extract('large.pdf', samplePdf(['Text']), { maxFileBytes: 10 })).toEqual({
    ok: false,
    error: { code: 'TOO_LARGE' },
  });
  expect(
    await extract('text.pdf', samplePdf(['Much longer than ten bytes']), { maxTextBytes: 10 }),
  ).toEqual({ ok: false, error: { code: 'TOO_LARGE' } });
  expect(await extract('scan.pdf', samplePdf(['', '']), { maxImages: 1 })).toEqual({
    ok: false,
    error: { code: 'TOO_LARGE' },
  });
  const large = new JSZip();
  large.file('content.xml', `<office:body><text:p>${'A'.repeat(17000)}</text:p></office:body>`);
  expect(
    await extract('output.odt', await large.generateAsync({ type: 'nodebuffer' }), {
      maxOutputBytes: 16384,
    }),
  ).toEqual({ ok: false, error: { code: 'TOO_LARGE' } });
}, 30000);

it('reads OpenDocument presentations and XML entities without executing external entities', async () => {
  const zip = new JSZip();
  zip.file(
    'content.xml',
    '<office:document><office:body><office:presentation><draw:page><text:p>Sales &amp; costs &#x627;</text:p></draw:page></office:presentation></office:body></office:document>',
  );
  const result = await extract('slides.odp', await zip.generateAsync({ type: 'nodebuffer' }));
  expect(result).toEqual({
    ok: true,
    value: { path: 'slides.odp', content: '[Slide 1]\nSales & costs ا' },
  });
  zip.file(
    'content.xml',
    '<!DOCTYPE secret SYSTEM "file:///private-secret"><office:body><text:p>&secret;</text:p></office:body>',
  );
  expect(await extract('unsafe.odt', await zip.generateAsync({ type: 'nodebuffer' }))).toEqual({
    ok: false,
    error: { code: 'UNREADABLE_FILE' },
  });
}, 30000);

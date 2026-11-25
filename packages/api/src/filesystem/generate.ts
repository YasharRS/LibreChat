import { z } from 'zod';
import JSZip from 'jszip';
import PDFDocument from 'pdfkit';
import PptxGenJS from 'pptxgenjs';
import { read, write, utils } from 'xlsx';
import { Document, Packer, Paragraph } from 'docx';
import { localFilesDocument } from 'librechat-data-provider';
import type { LocalFilesConfig, LocalFilesResult } from 'librechat-data-provider';
import type { BookType, WorkBook } from 'xlsx';
import type { LocalFilesRender } from './writer';

type Code = Extract<LocalFilesResult, { ok: false }>['error']['code'];
class GenerationError extends Error {
  constructor(readonly code: Code) {
    super(code);
  }
}
const fail = (code: Code): never => {
  throw new GenerationError(code);
};
const cell = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const workbook = z
  .object({
    sheets: z
      .array(
        z
          .object({
            name: z
              .string()
              .min(1)
              .max(31)
              .regex(/^[^\\/?*[\]:]+$/),
            rows: z.array(z.array(cell)),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
const presentation = z
  .object({
    slides: z.array(z.object({ title: z.string(), body: z.string().default('') }).strict()).min(1),
  })
  .strict();

function slides(content: string, maximum: number): z.infer<typeof presentation>['slides'] {
  const value = content.trimStart().startsWith('{')
    ? presentation.parse(JSON.parse(content)).slides
    : content.split(/\r?\n---\r?\n/).map((page) => {
        const [title = '', ...body] = page.split(/\r?\n/);
        return { title, body: body.join('\n') };
      });
  if (value.length > maximum) return fail('TOO_LARGE');
  return value;
}

async function pdf(content: string, config: LocalFilesConfig): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: 'A4', margin: 50, autoFirstPage: false });
    const chunks: Buffer[] = [];
    let size = 0;
    let pages = 0;
    document.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > config.maxFileBytes) {
        reject(new GenerationError('TOO_LARGE'));
        document.destroy();
      } else chunks.push(chunk);
    });
    document.on('error', reject);
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('pageAdded', () => {
      if (++pages > config.maxPages) {
        document.destroy();
        fail('TOO_LARGE');
      }
    });
    try {
      document.registerFont(
        'body',
        require.resolve('@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff'),
      );
      document.registerFont(
        'arabic',
        require.resolve(
          '@fontsource/noto-sans-arabic/files/noto-sans-arabic-arabic-400-normal.woff',
        ),
      );
      document.font('body').fontSize(11);
      for (const page of content.split('\f')) {
        document.addPage();
        for (const line of page.split(/\r?\n/)) {
          const parts = line.split(
            /([\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]+)/,
          );
          for (let index = 0; index < parts.length; index++)
            document
              .font(index % 2 === 0 ? 'body' : 'arabic')
              .text(parts[index], { continued: index < parts.length - 1 });
          if (!line) document.moveDown();
        }
      }
      document.end();
    } catch (error) {
      document.destroy();
      reject(error);
    }
  });
}

function sheet(content: string, extension: string, config: LocalFilesConfig): Buffer {
  let book: WorkBook;
  if (content.trimStart().startsWith('{')) {
    const input = workbook.parse(JSON.parse(content));
    if (input.sheets.length > config.maxPages) return fail('TOO_LARGE');
    book = utils.book_new();
    for (const entry of input.sheets)
      utils.book_append_sheet(book, utils.aoa_to_sheet(entry.rows), entry.name);
  } else book = read(content, { type: 'string', raw: true, cellFormula: false });
  let type: BookType = 'xlsx';
  if (extension === 'xls') type = 'biff8';
  else if (extension === 'ods') type = 'ods';
  return write(book, {
    type: 'buffer',
    bookType: type,
    compression: true,
  });
}

const xml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&apos;';
    }
  });
const paragraphs = (content: string): string =>
  content
    .split(/\r?\n/)
    .map((line) => `<text:p xml:space="preserve">${xml(line)}</text:p>`)
    .join('');

async function odf(content: string, mime: string, config: LocalFilesConfig): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('mimetype', mime, { compression: 'STORE' });
  const body = mime.endsWith('.text')
    ? `<office:text>${paragraphs(content)}</office:text>`
    : `<office:presentation>${slides(content, config.maxPages)
        .map(
          (slide, index) =>
            `<draw:page draw:name="Slide ${index + 1}" draw:master-page-name="Default"><draw:frame presentation:class="title" svg:x="1cm" svg:y="1cm" svg:width="26cm" svg:height="3cm"><draw:text-box>${paragraphs(slide.title)}</draw:text-box></draw:frame><draw:frame presentation:class="outline" svg:x="1cm" svg:y="4cm" svg:width="26cm" svg:height="15cm"><draw:text-box>${paragraphs(slide.body)}</draw:text-box></draw:frame></draw:page>`,
        )
        .join('')}</office:presentation>`;
  zip.file(
    'content.xml',
    `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.3"><office:body>${body}</office:body></office:document-content>`,
  );
  zip.file(
    'styles.xml',
    '<?xml version="1.0" encoding="UTF-8"?><office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" office:version="1.3"><office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="21cm" style:print-orientation="landscape"/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="Default" style:page-layout-name="pm1"/></office:master-styles></office:document-styles>',
  );
  zip.file(
    'META-INF/manifest.xml',
    `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/></manifest:manifest>`,
  );
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** Generate bytes from declarative content only; no macros, scripts, network resources or disk output. */
export async function generateLocalDocument({
  input,
  config,
}: Omit<LocalFilesRender, 'signal'>): Promise<LocalFilesResult> {
  try {
    if (Buffer.byteLength(input.content, 'utf8') > config.maxTextBytes) return fail('TOO_LARGE');
    const format = localFilesDocument(input.path);
    if (!format || input.encoding === 'base64') return fail('UNSUPPORTED_FORMAT');
    const extension = input.path.split('.').pop()?.toLowerCase() ?? '';
    let data: Buffer;
    if (format[0] === 'pdf') data = await pdf(input.content, config);
    else if (format[0] === 'word') {
      data = await Packer.toBuffer(
        new Document({
          sections: [{ children: input.content.split(/\r?\n/).map((line) => new Paragraph(line)) }],
        }),
      );
    } else if (format[0] === 'sheet') data = sheet(input.content, extension, config);
    else if (format[0] === 'slides') {
      const deck = new PptxGenJS();
      deck.layout = 'LAYOUT_WIDE';
      for (const entry of slides(input.content, config.maxPages)) {
        const slide = deck.addSlide();
        slide.addText(entry.title, { x: 0.7, y: 0.5, w: 11.9, h: 1, fontSize: 32, fit: 'shrink' });
        slide.addText(entry.body, { x: 0.7, y: 1.7, w: 11.9, h: 5.1, fontSize: 20, fit: 'shrink' });
      }
      const output = await deck.write({ outputType: 'nodebuffer', compression: true });
      if (!Buffer.isBuffer(output)) throw new Error('Presentation generation returned no bytes');
      data = output;
    } else data = await odf(input.content, format[1], config);
    if (data.length > config.maxFileBytes) return fail('TOO_LARGE');
    return {
      ok: true,
      value: { path: input.path, binary: { mime: format[1], data: data.toString('base64') } },
    };
  } catch (error) {
    if (error instanceof GenerationError) return { ok: false, error: { code: error.code } };
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return { ok: false, error: { code: 'INVALID_REQUEST' } };
    return { ok: false, error: { code: 'FAILED' } };
  }
}

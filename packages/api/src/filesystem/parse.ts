import sharp from 'sharp';
import yauzl from 'yauzl';
import { read, utils, SSF } from 'xlsx';
import { extractRawText } from 'mammoth';
import { localFilesFormat } from 'librechat-data-provider';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { LocalFilesConfig, LocalFilesResult } from 'librechat-data-provider';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { LocalFilesRead } from './reader';
import { workbookToText, SpreadsheetLimitError } from '~/files/documents/workbook';
import { assertSafeZipSize, ZipBombError } from '~/files/documents/zipSafety';

type Code = Extract<LocalFilesResult, { ok: false }>['error']['code'];
type Value = Extract<LocalFilesResult, { ok: true }>['value'];
class ParseError extends Error {
  constructor(readonly code: Code) {
    super(code);
  }
}
const fail = (code: Code): never => {
  throw new ParseError(code);
};

async function image(
  data: Buffer,
  config: LocalFilesConfig,
): Promise<NonNullable<Value['images']>[number]> {
  if (config.maxOutputBytes <= 4096) return fail('TOO_LARGE');
  const source = sharp(data, { limitInputPixels: false, pages: 1 });
  const metadata = await source.metadata();
  if (!['jpeg', 'png', 'webp', 'gif', 'tiff', 'avif', 'heif'].includes(metadata.format ?? ''))
    return fail('UNSUPPORTED_FORMAT');
  if ((metadata.width ?? 0) * (metadata.pageHeight ?? metadata.height ?? 0) > config.maxImagePixels)
    return fail('TOO_LARGE');
  const maximum = Math.min(config.maxImageBytes, Math.floor((config.maxOutputBytes - 4096) * 0.75));
  let normalized = await sharp(data, { limitInputPixels: config.maxImagePixels, pages: 1 })
    .rotate()
    .resize({
      width: config.imageDimension,
      height: config.imageDimension,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 80 })
    .toBuffer();
  if (normalized.length > maximum) {
    const dimension = Math.max(
      256,
      Math.floor(config.imageDimension * Math.sqrt(maximum / normalized.length) * 0.85),
    );
    normalized = await sharp(data, { limitInputPixels: config.maxImagePixels, pages: 1 })
      .rotate()
      .resize({ width: dimension, height: dimension, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 65 })
      .toBuffer();
  }
  if (normalized.length > maximum) return fail('TOO_LARGE');
  return { mime: 'image/jpeg', data: normalized.toString('base64') };
}

/** Read only selected ZIP members after the existing streamed decompression safety check. */
async function members(
  data: Buffer,
  include: (name: string) => boolean,
): Promise<Map<string, string>> {
  await assertSafeZipSize(data, { name: 'local document' });
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(data, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error('Invalid archive'));
        return;
      }
      const result = new Map<string, string>();
      let settled = false;
      const finish = (failure?: Error) => {
        if (settled) return;
        settled = true;
        zip.close();
        if (failure) reject(failure);
        else resolve(result);
      };
      zip.on('error', finish);
      zip.on('end', () => finish());
      zip.on('entry', (entry: yauzl.Entry) => {
        if (!include(entry.fileName)) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (failure, stream) => {
          if (failure || !stream) {
            finish(failure ?? new Error('Invalid archive member'));
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          stream.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 25 * 1024 * 1024) stream.destroy(new ZipBombError('Expanded member limit'));
            else chunks.push(chunk);
          });
          stream.on('error', finish);
          stream.on('end', () => {
            const xml = Buffer.concat(chunks).toString('utf8');
            if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
              finish(new ParseError('UNREADABLE_FILE'));
              return;
            }
            result.set(entry.fileName, xml);
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

/** Plain text only: no HTML rendering, external resources, macros or XML entity expansion. */
function xmlText(xml: string): string {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return fail('UNREADABLE_FILE');
  const entities: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
  return xml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<text:tab\b[^>]*\/>/g, '\t')
    .replace(/<text:s\b[^>]*\/>/g, ' ')
    .replace(/<(?:text:line-break|a:br)\b[^>]*\/>/g, '\n')
    .replace(/<\/(?:a:p|text:p|text:h)>/g, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (entity: string, name: string) => {
      if (!name.startsWith('#')) return entities[name] ?? entity;
      const number = name[1] === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff)
        ? String.fromCodePoint(number)
        : '';
    })
    .trim();
}

function range(input: LocalFilesRead['input'], total: number, maximum: number): [number, number] {
  const start = input.startPage ?? 1;
  const end = input.endPage ?? total;
  if (start > end || end > total) return fail('INVALID_REQUEST');
  if (end - start + 1 > maximum) return fail('TOO_LARGE');
  return [start, end];
}

async function slides(request: Omit<LocalFilesRead, 'signal'>): Promise<string> {
  const files = await members(
    request.data,
    (name) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name) ||
      name === 'ppt/presentation.xml' ||
      name === 'ppt/_rels/presentation.xml.rels',
  );
  const relations = files.get('ppt/_rels/presentation.xml.rels') ?? '';
  const order = [
    ...(files.get('ppt/presentation.xml') ?? '').matchAll(
      /<p:sldId\b[^>]*\br:id=["']([^"']+)["'][^>]*\/?\s*>/g,
    ),
  ];
  const paths = order.map((entry) => {
    const relation = [...relations.matchAll(/<Relationship\b[^>]*>/g)].find(
      (match) => match[0].match(/\bId=["']([^"']+)["']/)?.[1] === entry[1],
    )?.[0];
    if (!relation || /\bTargetMode=["']External["']/.test(relation)) return fail('UNREADABLE_FILE');
    const target = relation.match(/\bTarget=["']([^"']+)["']/)?.[1] ?? '';
    const path = target.startsWith('/ppt/') ? target.slice(1) : `ppt/${target}`;
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(path) || !files.has(path))
      return fail('UNREADABLE_FILE');
    return path;
  });
  if (!paths.length) return fail('UNREADABLE_FILE');
  const [start, end] = range(request.input, paths.length, request.config.maxPages);
  return paths
    .slice(start - 1, end)
    .map((path, index) => `[Slide ${start + index}]\n${xmlText(files.get(path) ?? '')}`)
    .join('\n\n');
}

async function pdf(
  request: Omit<LocalFilesRead, 'signal'>,
): Promise<Pick<Value, 'content' | 'images'>> {
  const task = getDocument({
    data: new Uint8Array(request.data),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: true,
    verbosity: 0,
    maxImageSize: request.config.maxImagePixels,
  });
  try {
    const document = await task.promise;
    const [start, end] = range(request.input, document.numPages, request.config.maxPages);
    const chunks: string[] = [];
    const images: NonNullable<Value['images']> = [];
    let bytes = 0;
    for (let number = start; number <= end; number++) {
      const page = await document.getPage(number);
      try {
        const text = await page.getTextContent();
        const content = text.items
          .filter((item): item is TextItem => 'str' in item)
          .map((item) => item.str + (item.hasEOL ? '\n' : ' '))
          .join('')
          .trim();
        const heading = `[Page ${number}]\n${content}`;
        bytes += Buffer.byteLength(heading, 'utf8') + 2;
        if (bytes > request.config.maxTextBytes) return fail('TOO_LARGE');
        chunks.push(heading);
        if (content) continue;
        if (images.length >= request.config.maxImages) return fail('TOO_LARGE');
        const base = page.getViewport({ scale: 1 });
        if (![base.width, base.height].every((size) => Number.isFinite(size) && size > 0))
          return fail('UNREADABLE_FILE');
        const viewport = page.getViewport({
          scale: Math.min(1, request.config.imageDimension / Math.max(base.width, base.height)),
        });
        // PDF.js types its Node canvas factory as Object; the public canvas API is shared with browsers.
        const factory = document.canvasFactory as {
          create(
            width: number,
            height: number,
          ): { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D };
          destroy(value: { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D }): void;
        };
        const canvas = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
        try {
          await page.render({ canvas: canvas.canvas, canvasContext: canvas.context, viewport })
            .promise;
          const data = Buffer.from(canvas.canvas.toDataURL('image/png').split(',')[1], 'base64');
          images.push({ ...(await image(data, request.config)), page: number });
        } finally {
          factory.destroy(canvas);
        }
      } finally {
        page.cleanup();
      }
    }
    return { content: chunks.join('\n\n'), ...(images.length ? { images } : {}) };
  } finally {
    await task.destroy();
  }
}

export async function readLocalDocument(
  request: Omit<LocalFilesRead, 'signal'>,
): Promise<LocalFilesResult> {
  try {
    const { data, config, input } = request;
    if (data.length > config.maxFileBytes) return fail('TOO_LARGE');
    const format = localFilesFormat(input.path);
    if (!format) return fail('UNSUPPORTED_FORMAT');
    if (
      (input.startPage != null || input.endPage != null) &&
      !['pdf', 'slides'].includes(format[0]) &&
      !input.path.toLowerCase().endsWith('.odp')
    )
      return fail('INVALID_REQUEST');
    let value: Value;
    if (format[0] === 'pdf') value = { path: input.path, ...(await pdf(request)) };
    else if (format[0] === 'image')
      value = { path: input.path, images: [await image(data, config)] };
    else {
      let content: string;
      if (format[0] === 'word') {
        await assertSafeZipSize(data, { name: 'local document' });
        content = (await extractRawText({ buffer: data })).value;
      } else if (format[0] === 'sheet') {
        if (data[0] === 0x50 && data[1] === 0x4b)
          await assertSafeZipSize(data, { name: 'local document' });
        const workbook = read(data, {
          type: 'buffer',
          cellText: input.path.toLowerCase().endsWith('.ods'),
          cellNF: true,
          cellHTML: false,
          dense: false,
        });
        content = workbookToText(workbook, utils, SSF.format);
      } else if (format[0] === 'slides') content = await slides(request);
      else {
        const xml =
          (await members(data, (name) => name === 'content.xml')).get('content.xml') ?? '';
        const body = xml.match(/<office:body\b[^>]*>([\s\S]*?)<\/office:body>/)?.[1] ?? '';
        if (input.path.toLowerCase().endsWith('.odp')) {
          const pages = [...body.matchAll(/<draw:page\b[^>]*>([\s\S]*?)<\/draw:page>/g)];
          const [start, end] = range(input, pages.length, config.maxPages);
          content = pages
            .slice(start - 1, end)
            .map((page, index) => `[Slide ${start + index}]\n${xmlText(page[1])}`)
            .join('\n\n');
        } else content = xmlText(body);
      }
      if (!content.trim()) return fail('UNREADABLE_FILE');
      value = { path: input.path, content };
    }
    if (Buffer.byteLength(value.content ?? '', 'utf8') > config.maxTextBytes)
      return fail('TOO_LARGE');
    if (
      Buffer.byteLength(JSON.stringify(value), 'utf8') + 1024 * (value.images?.length ?? 0) >
      config.maxOutputBytes
    )
      return fail('TOO_LARGE');
    return { ok: true, value };
  } catch (error) {
    if (error instanceof ParseError) return { ok: false, error: { code: error.code } };
    if (error instanceof Error && error.name === 'PasswordException')
      return { ok: false, error: { code: 'PASSWORD_REQUIRED' } };
    if (error instanceof ZipBombError || error instanceof SpreadsheetLimitError)
      return { ok: false, error: { code: 'TOO_LARGE' } };
    return { ok: false, error: { code: 'UNREADABLE_FILE' } };
  }
}

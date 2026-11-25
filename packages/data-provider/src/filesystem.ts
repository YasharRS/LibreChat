import { z } from 'zod';

export const LOCAL_FILES_VERSION = 3 as const;
export const LOCAL_FILES_EVENT = 'on_local_file_request' as const;
export const LOCAL_FILES_HEADER = 'X-Local-Files-Token';

export const localFilesConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    requireReview: z.boolean().default(true),
    maxTextBytes: z
      .number()
      .int()
      .min(1)
      .max(16 * 1024 * 1024)
      .default(1024 * 1024),
    maxMoveBytes: z
      .number()
      .int()
      .min(1)
      .max(256 * 1024 * 1024)
      .default(16 * 1024 * 1024),
    maxFileBytes: z
      .number()
      .int()
      .min(1)
      .max(15 * 1024 * 1024)
      .default(15 * 1024 * 1024),
    // Leave space below the agents SDK's 400,000-character tool-content ceiling.
    maxOutputBytes: z.number().int().min(16384).max(350000).default(350000),
    maxPages: z.number().int().min(1).max(500).default(100),
    maxImages: z.number().int().min(1).max(4).default(4),
    maxImageBytes: z
      .number()
      .int()
      .min(16384)
      .max(1024 * 1024)
      .default(512 * 1024),
    maxImagePixels: z.number().int().min(1).max(64000000).default(25000000),
    imageDimension: z.number().int().min(256).max(2048).default(1600),
    maxReaders: z.number().int().min(1).max(4).default(2),
    extractionTimeoutMs: z.number().int().min(1000).max(120000).default(30000),
    pageSize: z.number().int().min(1).max(1000).default(200),
    requestTimeoutMs: z.number().int().min(1000).max(300000).default(60000),
    sessionTtlMs: z.number().int().min(15000).max(300000).default(60000),
  })
  .strict();
export type LocalFilesConfig = z.infer<typeof localFilesConfigSchema>;

/** An allowlist; browser MIME hints and renamed extensions cannot authorize active content. */
const formats = {
  pdf: ['pdf', 'application/pdf'],
  docx: ['word', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xlsx: ['sheet', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  xls: ['sheet', 'application/vnd.ms-excel'],
  ods: ['sheet', 'application/vnd.oasis.opendocument.spreadsheet'],
  pptx: ['slides', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  odt: ['document', 'application/vnd.oasis.opendocument.text'],
  odp: ['document', 'application/vnd.oasis.opendocument.presentation'],
  jpg: ['image', 'image/jpeg'],
  jpeg: ['image', 'image/jpeg'],
  png: ['image', 'image/png'],
  webp: ['image', 'image/webp'],
  gif: ['image', 'image/gif'],
  tif: ['image', 'image/tiff'],
  tiff: ['image', 'image/tiff'],
  avif: ['image', 'image/avif'],
} as const;
export function localFilesFormat(path: string) {
  const extension = path.split('/').pop()?.split('.').pop()?.toLowerCase() ?? '';
  return Object.prototype.hasOwnProperty.call(formats, extension)
    ? formats[extension as keyof typeof formats]
    : undefined;
}

/** These formats can be generated from text, CSV, or structured JSON without executing code. */
export function localFilesDocument(path: string) {
  const format = localFilesFormat(path);
  return format?.[0] !== 'image' ? format : undefined;
}

export const localFilesRootSchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1).max(255),
    access: z.enum(['read', 'readwrite']),
  })
  .strict();
export type LocalFilesRoot = z.infer<typeof localFilesRootSchema>;

/** Paths are relative to a browser-held directory handle, never host paths. */
export const localFilesPathSchema = z
  .string()
  .max(4096)
  .refine(
    (path) =>
      path === '' ||
      (!/[\\:]/.test(path) &&
        !path.includes('\0') &&
        path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')),
    'A relative path inside the selected folder is required',
  );
const file = localFilesPathSchema.refine((path) => path.length > 0);
export const localFilesInputSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('list'),
      path: localFilesPathSchema,
      cursor: z.number().int().nonnegative().default(0),
    })
    .strict(),
  z
    .object({
      operation: z.literal('read'),
      path: file,
      startPage: z.number().int().positive().optional(),
      endPage: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('write'),
      path: file,
      content: z.string(),
      encoding: z.enum(['utf8', 'base64']).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('edit'),
      path: file,
      edits: z
        .array(z.object({ oldText: z.string().min(1), newText: z.string() }).strict())
        .min(1)
        .max(100),
    })
    .strict(),
  z.object({ operation: z.literal('mkdir'), path: file }).strict(),
  z.object({ operation: z.literal('move'), path: file, destination: file }).strict(),
]);
export type LocalFilesInput = z.infer<typeof localFilesInputSchema>;
export type LocalFilesWrite = Extract<LocalFilesInput, { operation: 'write' }>;

/** A null size denotes malformed base64. Check size before allocating decoded bytes. */
export function localFilesWriteSize(input: LocalFilesWrite): number | null {
  if (input.encoding !== 'base64') return new TextEncoder().encode(input.content).byteLength;
  if (input.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.content)) return null;
  let padding = 0;
  if (input.content.endsWith('==')) padding = 2;
  else if (input.content.endsWith('=')) padding = 1;
  return (input.content.length / 4) * 3 - padding;
}
export type LocalFilesOperation = LocalFilesInput['operation'];
export const LOCAL_FILES_TOOLS: Record<LocalFilesOperation, string> = {
  list: 'local_list',
  read: 'local_read',
  write: 'local_write',
  edit: 'local_edit',
  mkdir: 'local_mkdir',
  move: 'local_move',
};
export function localFilesMutation(operation: LocalFilesOperation): boolean {
  return operation !== 'list' && operation !== 'read';
}
export function localFilesOperation(name: string): LocalFilesOperation | undefined {
  return (Object.keys(LOCAL_FILES_TOOLS) as LocalFilesOperation[]).find(
    (key) => LOCAL_FILES_TOOLS[key] === name,
  );
}

export const localFilesReviewSchema = z
  .object({
    id: z.uuid(),
    sessionId: z.uuid(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    before: z
      .array(
        z
          .object({
            path: file,
            hash: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .nullable(),
          })
          .strict(),
      )
      .max(2),
  })
  .strict();
export type LocalFilesReview = z.infer<typeof localFilesReviewSchema>;

export const LOCAL_FILES_ERRORS = [
  'UNAVAILABLE',
  'INVALID_REQUEST',
  'PERMISSION_DENIED',
  'NOT_FOUND',
  'UNSUPPORTED_TEXT',
  'UNSUPPORTED_FORMAT',
  'UNREADABLE_FILE',
  'PASSWORD_REQUIRED',
  'PROCESSOR_BUSY',
  'TOO_LARGE',
  'CONFLICT',
  'REVIEW_REQUIRED',
  'REVIEW_EXPIRED',
  'CANCELLED',
  'TIMEOUT',
  'EXECUTION_UNCERTAIN',
  'COPY_RETAINED',
  'FAILED',
] as const;
export const localFilesResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      value: z
        .object({
          path: z.string(),
          content: z.string().optional(),
          binary: z.object({ mime: z.string(), data: z.string() }).strict().optional(),
          images: z
            .array(
              z
                .object({
                  mime: z.literal('image/jpeg'),
                  data: z.string(),
                  page: z.number().int().positive().optional(),
                })
                .strict(),
            )
            .max(4)
            .optional(),
          entries: z
            .array(z.object({ name: z.string(), kind: z.enum(['file', 'directory']) }).strict())
            .optional(),
          nextCursor: z.number().int().nonnegative().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      error: z.object({ code: z.enum(LOCAL_FILES_ERRORS) }).strict(),
    })
    .strict(),
]);
export type LocalFilesResult = z.infer<typeof localFilesResultSchema>;
export const localFilesCommandSchema = z
  .object({
    version: z.literal(LOCAL_FILES_VERSION),
    id: z.uuid(),
    sessionId: z.uuid(),
    rootId: z.uuid(),
    conversationId: z.string(),
    runId: z.string().min(1),
    toolCallId: z.string().min(1),
    input: localFilesInputSchema,
    review: localFilesReviewSchema.optional(),
    expiresAt: z.number(),
    cancelled: z.literal(true).optional(),
  })
  .strict();
export type LocalFilesCommand = z.infer<typeof localFilesCommandSchema>;
export interface LocalFilesSession {
  id: string;
  token: string;
  root: LocalFilesRoot;
  config: LocalFilesConfig;
  version: typeof LOCAL_FILES_VERSION;
}

/** Stable serialization shared by the proposal UI and the execution boundary. */
export function serializeLocalFiles(input: LocalFilesInput): string {
  const parsed = localFilesInputSchema.parse(input);
  return JSON.stringify(parsed);
}

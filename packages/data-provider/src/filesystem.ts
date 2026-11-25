import { z } from 'zod';

export const LOCAL_FILES_VERSION = 1 as const;
export const LOCAL_FILES_EVENT = 'on_local_file_request' as const;
export const LOCAL_FILES_HEADER = 'X-Local-Files-Token';

export const localFilesConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
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
    pageSize: z.number().int().min(1).max(1000).default(200),
    requestTimeoutMs: z.number().int().min(1000).max(300000).default(60000),
    sessionTtlMs: z.number().int().min(15000).max(300000).default(60000),
  })
  .strict();
export type LocalFilesConfig = z.infer<typeof localFilesConfigSchema>;

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
  z.object({ operation: z.literal('read'), path: file }).strict(),
  z.object({ operation: z.literal('write'), path: file, content: z.string() }).strict(),
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

import {
  localFilesConfigSchema,
  localFilesInputSchema,
  localFilesPathSchema,
  localFilesResultSchema,
  serializeLocalFiles,
} from './filesystem';

describe('local file contracts', () => {
  it.each([
    '/etc/passwd',
    '../secret',
    'a/../secret',
    'C:/secret',
    'C:\\secret',
    '\\\\host\\share',
    'a//b',
    './file',
    'a\0b',
  ])('rejects an escaping or ambiguous path: %s', (path) => {
    expect(localFilesPathSchema.safeParse(path).success).toBe(false);
  });
  it.each(['', 'notes.txt', 'پروژه/یادداشت.txt', 'src/a.ts'])(
    'accepts an explicit relative path: %s',
    (path) => {
      expect(localFilesPathSchema.safeParse(path).success).toBe(true);
    },
  );
  it('preserves existing behavior until explicitly enabled', () => {
    expect(localFilesConfigSchema.parse({}).enabled).toBe(false);
  });
  it('canonicalizes property order and defaults before review hashing', () => {
    expect(serializeLocalFiles({ operation: 'list', path: '', cursor: 0 })).toBe(
      serializeLocalFiles(localFilesInputSchema.parse({ path: '', operation: 'list' })),
    );
  });
  it('does not accept a shell, deletion, unknown parameters, or raw error diagnostics', () => {
    expect(
      localFilesInputSchema.safeParse({ operation: 'execute', path: 'a', command: 'rm' }).success,
    ).toBe(false);
    expect(
      localFilesInputSchema.safeParse({ operation: 'read', path: 'a', command: 'rm' }).success,
    ).toBe(false);
    expect(
      localFilesResultSchema.safeParse({
        ok: false,
        error: { code: 'FAILED', message: 'password=secret' },
      }).success,
    ).toBe(false);
  });
});

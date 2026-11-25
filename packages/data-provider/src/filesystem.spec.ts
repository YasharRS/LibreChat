import {
  localFilesConfigSchema,
  localFilesInputSchema,
  localFilesPathSchema,
  localFilesResultSchema,
  localFilesFormat,
  serializeLocalFiles,
  localFilesWriteSize,
  localFilesCommandSchema,
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
    expect(localFilesConfigSchema.parse({}).requireReview).toBe(true);
  });
  it('accepts explicit binary writes of any format and measures decoded bytes', () => {
    const input = {
      operation: 'write' as const,
      path: 'archive.zip',
      content: 'AAGA/w==',
      encoding: 'base64' as const,
    };
    expect(localFilesInputSchema.parse(input)).toEqual(input);
    expect(localFilesWriteSize(input)).toBe(4);
    expect(localFilesWriteSize({ ...input, content: '' })).toBe(0);
    for (const content of [
      'abc',
      'ab=c',
      'a===',
      'abcd====',
      'data:application/pdf;base64,AA==',
      'AA==\n',
    ])
      expect(localFilesWriteSize({ ...input, content })).toBeNull();
    expect(localFilesWriteSize({ ...input, content: 'سلام', encoding: 'utf8' })).toBe(8);
  });
  it('rejects commands from older protocol versions', () => {
    expect(localFilesCommandSchema.safeParse({ version: 2 }).success).toBe(false);
  });
  it('recognizes document/image extensions without treating filenames or MIME hints as executable content', () => {
    expect(localFilesFormat('folder/REPORT.PDF')).toEqual(['pdf', 'application/pdf']);
    expect(localFilesFormat('photo.jpeg')?.[0]).toBe('image');
    expect(localFilesFormat('slides.pptx')?.[0]).toBe('slides');
    expect(localFilesFormat('macro.docm')).toBeUndefined();
    expect(localFilesFormat('image.svg')).toBeUndefined();
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

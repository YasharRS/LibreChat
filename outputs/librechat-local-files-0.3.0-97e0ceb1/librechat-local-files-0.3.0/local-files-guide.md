# Browser local folders

Local folders let a signed-in user connect a folder on their own computer to a chat.
The browser performs the file operations. Docker does not need a host bind mount, and
the application server never receives filesystem handles or opens a local host path.

Enable the feature after every serving replica has upgraded:

```yaml
localFiles:
  enabled: true
  requireReview: true
  maxTextBytes: 1048576
  maxMoveBytes: 16777216
  maxFileBytes: 15728640
  maxOutputBytes: 350000
  maxPages: 100
  maxImages: 4
  maxImageBytes: 524288
  maxImagePixels: 25000000
  imageDimension: 1600
  maxReaders: 2
  extractionTimeoutMs: 30000
  pageSize: 200
  requestTimeoutMs: 60000
  sessionTtlMs: 60000

endpoints:
  agents:
    toolApproval:
      enabled: true
```

Local folders are off by default. `requireReview` defaults to `true`: every local write,
edit, directory creation and move requires a one-time review. Set `requireReview: false`
to execute changes directly after granting the connected folder write access. In direct
mode, tool approval does not need to be enabled. With tool approval enabled, explicit
administrator ask/deny rules remain authoritative; unmatched local tools run directly.
Remembered approvals do not bypass review when `requireReview` is enabled.

Build this checkout with `npm run frontend` before starting the server. For Docker,
build a local image containing these changes; the standard prebuilt image does not
contain an unmerged feature. Merge this fragment into `docker-compose.override.yaml`
and run `docker compose up -d --build` with your normal `.env` and model credentials:

```yaml
services:
  api:
    image: librechat-local-files:local
    build:
      context: .
      dockerfile: Dockerfile
    volumes:
      - ./librechat.yaml:/app/librechat.yaml:ro
```

Use Chrome or Edge on desktop over HTTPS or localhost. Open **Local folder**, choose
a test folder, and select **Enable changes with review** (or **Enable changes** in direct
mode) before asking the assistant to write. The initial connection is read only. Each chat has one active folder. The tools
belong to the main interactive chat agent; unattended and API-only runs cannot use them.

Expand directories to browse their contents and select a file for a local preview.
UTF-8 text/code, CSV, Markdown and JSON can be read and edited. PDF, DOCX, XLSX, XLS,
PPTX, ODT, ODS and ODP can be read as extracted text. JPEG, PNG, WebP, GIF, TIFF and
AVIF can be read as images (first frame/page). Previews remain local: the panel shows
text and browser-supported images, with a format notice for documents. Content read
by the assistant enters the normal model request and chat history; connecting a folder
does not upload or index the folder. Binary documents are sent only for the requested
read, parsed in a disposable server process, and never saved as server files.

PDF.js extracts PDF text and renders textless pages as image blocks for vision-capable
models, without a separate OCR API/key. Mammoth reads DOCX; SheetJS reads spreadsheets;
bounded ZIP/XML extraction reads presentation/OpenDocument text. No macros, external
links or embedded scripts execute. Office extraction preserves text and spreadsheet
values, not page layout or embedded chart/image interpretation. Scanned PDFs are limited
by `maxImages`; ask for a smaller range with `local_read`'s inclusive, 1-based
`startPage`/`endPage` arguments (also available for PPTX/ODP slides). These limits fail
explicitly rather than silently omitting pages. Images are resized and encoded as JPEG
before entering model history. Legacy DOC/PPT require conversion; password-protected
documents require an unlocked copy. Other files can be listed and moved.

`local_write` creates or replaces files in any format:

- PDF, DOCX and ODT are generated as real documents from UTF-8 text. PDFs use embedded
  fonts, wrap text, and paginate automatically; a form-feed character starts a new page.
- XLSX, XLS and ODS accept CSV, or JSON such as
  `{"sheets":[{"name":"Data","rows":[["Name","Count"],["Example",42]]}]}`.
  JSON cell values are literal strings, numbers, booleans or null; formulas are not executed.
- PPTX and ODP accept slides separated by a line containing `---`, with each slide's first
  line as its title, or `{"slides":[{"title":"Title","body":"Slide text"}]}`.
- Any binary format, including images, archives and formats without a built-in generator,
  accepts complete base64-encoded bytes with `encoding: "base64"`. The decoded file is
  bounded by `maxFileBytes`; malformed base64 is rejected before writing.
- Other extensions keep the existing UTF-8 text behavior. `local_edit` performs exact
  text replacements; for document changes, read the document and use `local_write` to
  generate its replacement. Regeneration uses the supplied content and a basic layout;
  supply complete binary bytes to retain an externally generated layout or embedded media.

Generation runs in a disposable server process without shell execution, external resources,
or server-side output files. Input uses `maxTextBytes`, generated files use `maxFileBytes`,
and PDF pages, sheets and slides use `maxPages`. Rendering shares the existing processor
timeout and concurrency settings. A text write never stores fake text bytes under a PDF
or Office extension. Images require actual image bytes rather than UTF-8 text.

`maxOutputBytes` bounds a parsed document's complete text/base64 output below the SDK's
tool-content ceiling. Large documents or multiple scanned pages can reach this limit
before the input-file limit; request fewer pages instead of losing an image to truncation.
The selected agent's tool-output/context budget can lower this ceiling further; image
compression follows that effective budget. For detailed image analysis, use a vision
model with enough context or increase the existing agent `maxToolResultChars` setting.

When review is enabled, inspect the current and proposed contents in the connected tab.
A generated/binary proposal includes its byte size, SHA-256 and a download for inspection.
Approval saves those exact bytes without rendering the document again.
A review binds the operation, paths, connection, and current file hashes. Changed files
need a new proposal. Local writes cannot use "Always allow". Moves copy and verify one
file before removing its source, never overwrite a destination, and are not atomic.
A failed removal leaves both copies. Directory moves, standalone deletion, shell
execution and unsupported browsers are outside this version.

The local-folder protocol is version 3. Upgrade every replica and reload browser tabs
when installing this version over an earlier local-folder feature.

Disconnecting or replacing a connected folder stops its active chat run. The browser
remembers selected folder handles in account-scoped IndexedDB and offers the last
folder for reconnecting. Reusing a folder shares its write lock across tabs. Reloading
requires an explicit reconnect, and pending writes are never replayed automatically.
Logout disconnects all this account's tabs and removes its remembered handles. A small
local operation journal prevents duplicate disk writes; an interrupted execution whose
outcome is unknown requires inspection, rather than an automatic retry. Browser grants
are origin-wide: using another local application to edit the same files can still race
with an approved operation; the browser API does not provide a cross-application file
transaction or lock.

The session token travels in `X-Local-Files-Token`, stays in memory, and is never included
in model messages or SSE events. File-operation HTTP bodies and the token header are
excluded from RUM. The feature adds no file scans or network requests while disabled.

The complete browser test uses real OPFS file handles as the picker boundary, the
real Express server and resumable chat, a disposable MongoDB, and a deterministic
model. After building, run `npx playwright test --config=e2e/playwright.config.filesystem.ts`.
Set `E2E_CHROMIUM_CHANNEL=chrome` to use an installed Chrome. Native handle and
telemetry tests run with `npx playwright test --config=e2e/playwright.config.rum.ts`.
Run the direct-writing document tests with
`npx cross-env E2E_LOCAL_FILES_DIRECT=true playwright test --config=e2e/playwright.config.filesystem.ts`.

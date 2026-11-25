# Browser local folders

Local folders let a signed-in user connect a folder on their own computer to a chat.
The browser performs the file operations. Docker does not need a host bind mount, and
the application server never receives filesystem handles or opens a local host path.

Enable the feature after every serving replica has upgraded:

```yaml
localFiles:
  enabled: true
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

Keep your existing tool policy. A built-in policy asks for every local write, edit, directory
creation, and move. Remembered approvals never grant local disk writes. Explicit
administrator deny rules remain authoritative, including under `mode: bypass`.
Local folders are off by default.

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
a test folder, and optionally select **Enable changes with review** before sending a
turn. The initial connection is read only. Each chat has one active folder. The tools
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
documents require an unlocked copy. Direct binary editing is unavailable; save a summary
or proposed changes to a text/Markdown file instead. Other files can be listed and moved.

`maxOutputBytes` bounds a parsed document's complete text/base64 output below the SDK's
tool-content ceiling. Large documents or multiple scanned pages can reach this limit
before the input-file limit; request fewer pages instead of losing an image to truncation.
The selected agent's tool-output/context budget can lower this ceiling further; image
compression follows that effective budget. For detailed image analysis, use a vision
model with enough context or increase the existing agent `maxToolResultChars` setting.

Before changing a file, review its current and proposed contents in the connected tab.
A review binds the operation, paths, connection, and current file hashes. Changed files
need a new proposal. Local writes cannot use "Always allow". Moves copy and verify one
file before removing its source, never overwrite a destination, and are not atomic.
A failed removal leaves both copies. Directory moves, standalone deletion, shell
execution and unsupported browsers are outside this version.

The local-folder protocol is version 2. Upgrade every replica and reload browser tabs
when installing this version over the original text-only feature.

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

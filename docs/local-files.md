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
Only UTF-8 text and code can be read or edited. Previews remain local. Content read by
the assistant enters the normal model request and chat history; connecting a folder
does not upload or index the folder. Other files may be listed and moved.

Before changing a file, review its current and proposed contents in the connected tab.
A review binds the operation, paths, connection, and current file hashes. Changed files
need a new proposal. Local writes cannot use "Always allow". Moves copy and verify one
file before removing its source, never overwrite a destination, and are not atomic.
A failed removal leaves both copies. Directory moves, standalone deletion, shell
execution, PDF/Office extraction, and unsupported browsers are outside this version.

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

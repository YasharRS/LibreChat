# LibreChat browser local folders — source export 0.2.0

This package adds folder selection, a paginated file browser, local text/image previews,
chat tools for reading/editing/creating files, directory creation, and reviewed file
moves. It changes LibreChat's frontend and backend and requires a rebuild.

## Compatibility

- Tested LibreChat source: v0.8.9, upstream dev commit
  04fbc0256084f5d3bfa5f1b5f7e2474b01abc93f.
- Upstream: https://github.com/LibreChat-AI/LibreChat
- Use that checkout's package-lock.json and Node 24. The locked agents SDK is 4.2.13.
- Existing HITL approvals, resumable generation streams, and packages/chat are required.
- Desktop Chrome/Edge, HTTPS on a remote server, or localhost on the same computer.
  An ordinary HTTP connection to a remote server does not enable the folder picker.
- Frontend and API should be served on the same HTTPS origin. Preserve SSE support
  and allow /api/local-files/* and X-Local-Files-Token through your reverse proxy.
  Allow raw binary request bodies up to maxFileBytes (15 MiB by default).
- Each user selects a folder on their own browser device, including when LibreChat
  runs on a remote server. No user's folder is mounted into Docker.

The installers require the exact tested commit and clean tracked files. A matching
v0.8.9 version label alone does not establish compatibility. For another commit,
port and review the patch against that version and run the included tests before
deploying. Do not overwrite newer source files to force an installation.

Version 0.2.0 adds PDF, DOCX, XLSX/XLS/ODS, PPTX/ODT/ODP and raster-image reading.
PDF.js, Mammoth and SheetJS process only requested files in bounded child processes.
Scanned PDF pages use model vision. Binary files are read-only; save edits as text.
The local-folder protocol is now version 2; upgrade all replicas and reload browsers.
If upgrading an already-patched 0.1.0 deployment, build 0.2.0 in a fresh checkout at
this exact base and replace the image while keeping the existing data and config.

## 1. Apply the source patch

Extract the ZIP outside the target checkout and Docker build context. Preserve your
existing environment, configuration, uploads, database and deployment files.
The package contains no accounts, passwords, API keys, database or browser handles.

In an existing source checkout at the tested base:

~~~sh
cd /srv/LibreChat
git switch -c browser-local-files
bash /path/to/librechat-local-files-0.2.0/apply.sh /srv/LibreChat --check
bash /path/to/librechat-local-files-0.2.0/apply.sh /srv/LibreChat
git diff --cached --stat
git diff --cached
~~~

PowerShell equivalent:

~~~powershell
git -C C:\LibreChat switch -c browser-local-files
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Export\librechat-local-files-0.2.0\apply.ps1 -Repository C:\LibreChat -Check
powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Export\librechat-local-files-0.2.0\apply.ps1 -Repository C:\LibreChat
~~~

The check form changes no source files. Installation verifies the patch checksum,
checks the complete patch, and applies and stages the feature. It does not commit,
build, change your runtime configuration, restart services or contact a model.

If you only have a prebuilt Docker deployment, prepare a separate build checkout:

~~~sh
git clone https://github.com/LibreChat-AI/LibreChat.git LibreChat-local-files-build
cd LibreChat-local-files-build
git checkout -b browser-local-files 04fbc0256084f5d3bfa5f1b5f7e2474b01abc93f
bash /path/to/librechat-local-files-0.2.0/apply.sh "$PWD" --check
bash /path/to/librechat-local-files-0.2.0/apply.sh "$PWD"
~~~

## 2. Build

For a source installation:

~~~sh
npm ci
npm run frontend
~~~

For Docker, build from the patched source directory:

~~~sh
docker build -t librechat-local-files:0.2.0 .
~~~

The repository Dockerfile builds all required workspaces and the frontend.
Deploy this custom image on the other server. For a separate build machine, you can
transfer it with docker save / docker load or your existing private registry.

## 3. Enable the feature

Merge librechat.local-files.example.yaml into the server's active librechat.yaml.
Preserve the current version line and all existing settings and tool policy. Append
the two read-tool names to an existing allow list rather than replacing that list.
The reads are optional conveniences; writes always require their own local review.

For a standard Docker Compose deployment, merge the image and config mount from
docker-compose.local-files.example.yaml into your normal deployment, or append it
to your usual compose file list:

~~~sh
# Run in the existing deployment directory; include your normal overrides as well.
docker compose -f docker-compose.yml -f /path/to/librechat-local-files-0.2.0/docker-compose.local-files.example.yaml up -d --no-deps api
~~~

This uses the already-built local image and keeps existing dependent services.
Keep your existing data volumes and model credentials. The sample mount assumes the
standard /app/librechat.yaml configuration location; adapt it if you use CONFIG_PATH.
For a source deployment, restart your existing LibreChat service normally after the build.

Upgrade every serving replica and the frontend before enabling the flag. With multiple
replicas, use the existing shared Redis cache and shared generation/event store;
the local-files cache namespace must not be forced into per-process memory.

## 4. Verify

1. Check /readyz, sign in, then reload the application in desktop Chrome or Edge.
2. Open Local folder -> Choose folder and select a disposable test folder.
3. Confirm Read only. Preview a UTF-8 file, then ask the assistant to read it.
4. Read a PDF, DOCX and PNG from the chat. Use a vision-capable model for images/scans.
5. Wait for the reply, enable changes with review, and request a small edit.
6. Check current/proposed contents, approve and submit. Verify the real file on disk.
7. Reject a new-file proposal and confirm the file is not created.

If the panel is missing, check the active configuration has localFiles.enabled and
endpoints.agents.toolApproval.enabled both true, that the custom frontend was built,
and that the page is HTTPS or localhost. After a browser reload, explicitly reconnect
the folder and start pending write requests again. A model API key is configured on
the destination server through its normal LibreChat flow.

## Tests included

From the patched checkout after installing dependencies and building:

~~~sh
(cd packages/data-provider && npx jest --runInBand src/filesystem.spec.ts src/filesystem-service.spec.ts --coverage=false)
(cd packages/api && npx jest --runInBand src/filesystem --coverage=false)
(cd client && npx jest --runInBand src/components/Filesystem/__tests__ src/lib/rum/privacy.spec.ts --coverage=false)
E2E_CHROMIUM_CHANNEL=chrome npx playwright test --config=e2e/playwright.config.filesystem.ts
E2E_CHROMIUM_CHANNEL=chrome npx playwright test --config=e2e/playwright.config.rum.ts
~~~

The browser fixtures use a disposable MongoDB, real OPFS handles at the native picker
boundary, and a deterministic model. They do not require a live model key. Run tsc
--noEmit in packages/data-provider, packages/api, packages/chat and client as well.
See VALIDATION.json for the source validation record and package verification.

## Rollback

Set localFiles.enabled to false and restart. Stop or let pending local operations finish
before replacing the image. Re-deploy your previous image or source build while keeping
the same database, uploads, environment and other volumes.

For an otherwise unchanged patched source tree, the patch can also be reversed:

~~~sh
git apply --check --reverse --index /path/to/librechat-local-files-0.2.0/feature.patch
git apply --reverse --index /path/to/librechat-local-files-0.2.0/feature.patch
~~~

If you committed the feature and later changed those files, review a normal Git revert
instead. Removing code does not undo file operations users already approved.

The upstream MIT license is included. SHA256SUMS covers the package files, and the
ZIP has a separate checksum file alongside it.

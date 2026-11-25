param(
  [Parameter(Mandatory = $true)][string]$Repository,
  [switch]$Check
)
$ErrorActionPreference = 'Stop'
$path = (Resolve-Path -LiteralPath $Repository).Path
$root = & git -C $path rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0) { throw 'The target must be a LibreChat Git working tree.' }
$head = & git -C $root rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot read the target commit.' }
$base = '04fbc0256084f5d3bfa5f1b5f7e2474b01abc93f'
if ($head -ne $base) { throw "Unsupported base: $head. Tested base: $base. See INSTALL.md for a compatible checkout or manual port." }
$dirty = & git -C $root status --porcelain --untracked-files=no
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the target working tree.' }
if ($dirty) { throw 'Commit or otherwise preserve your tracked changes before installing.' }
$patch = Join-Path $PSScriptRoot 'feature.patch'
$hash = (Get-FileHash -LiteralPath $patch -Algorithm SHA256).Hash.ToLowerInvariant()
if ($hash -ne 'f27d22dfc6ec9966e7a49469f81fd61a3cf0143e963eac78a220a25a47619fa1') { throw 'Patch checksum mismatch.' }
& git -C $root apply --check --index --whitespace=error-all -- $patch
if ($LASTEXITCODE -ne 0) { throw 'The patch does not apply cleanly. No source changes were applied.' }
if ($Check) { Write-Output 'Checks passed; no source changes were applied.'; exit 0 }
& git -C $root apply --index --whitespace=error-all -- $patch
if ($LASTEXITCODE -ne 0) { throw 'Patch application failed.' }
Write-Output 'Feature applied and staged. Review git diff --cached, then rebuild and enable it as described in INSTALL.md.'

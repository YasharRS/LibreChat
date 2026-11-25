#!/usr/bin/env bash
set -euo pipefail
usage() {
  printf 'Usage: bash apply.sh /path/to/LibreChat [--check]\n'
}
if [[ "$#" == 1 && ( "$1" == "--help" || "$1" == "-h" ) ]]; then usage; exit 0; fi
if [[ "$#" -lt 1 || "$#" -gt 2 ]]; then usage >&2; exit 2; fi
check=false
if [[ "$#" == 2 ]]; then
  [[ "$2" == "--check" ]] || { usage >&2; exit 2; }
  check=true
fi
package=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
patch="$package/feature.patch"
root=$(git -C "$1" rev-parse --show-toplevel)
head=$(git -C "$root" rev-parse HEAD)
base=04fbc0256084f5d3bfa5f1b5f7e2474b01abc93f
if [[ "$head" != "$base" ]]; then
  printf 'Unsupported base: %s\nTested base: %s\nSee INSTALL.md for a compatible checkout or manual port.\n' "$head" "$base" >&2
  exit 3
fi
if [[ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]]; then
  printf 'Commit or otherwise preserve your tracked changes before installing.\n' >&2
  exit 4
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$patch" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$patch" | awk '{print $1}')
else
  printf 'Install sha256sum or shasum to verify the patch.\n' >&2
  exit 5
fi
[[ "$actual" == "a4a449678cd7a5f0b832d014b6040eebde0e4f460e986760b5d2dab0803b80bb" ]] || { printf 'Patch checksum mismatch.\n' >&2; exit 6; }
git -C "$root" apply --check --index --whitespace=error-all -- "$patch"
if "$check"; then printf 'Checks passed; no source changes were applied.\n'; exit 0; fi
git -C "$root" apply --index --whitespace=error-all -- "$patch"
printf 'Feature applied and staged. Review git diff --cached, then rebuild and enable it as described in INSTALL.md.\n'

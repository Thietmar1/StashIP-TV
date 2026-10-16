#!/usr/bin/env bash
# Optional Linux developer wrapper. Installed plugins do not need this script.
set -euo pipefail
outdir="${1:-dist}"
(
  cd plugins/StashIP-TV
  npm ci
  npm run build
)
revision="$(git rev-parse --short=12 HEAD 2>/dev/null || echo local)"
python3 tools/package_stashiptv.py --output-dir "$outdir" --revision "$revision" --check

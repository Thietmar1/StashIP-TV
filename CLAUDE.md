# StashIP-TV development

This repository contains `plugins/StashIP-TV` and the independent experimental
`plugins/FunscriptOllama`. GalleryMode, SpriteTab and TheaterMode have been
removed. Preserve the original AGPL license and notices.

Funscript Ollama uses Python/OpenCV plus native Ollama vision/structured JSON or
the official Codex/Gemini CLI with account login. Preserve the account-only mode:
do not extract OAuth tokens, call private backends, silently use API keys, or
install CLIs at task runtime. CLI subprocesses must have bounded output/time,
stop descendants on exit/cancellation, and never log raw credential-bearing output.
Run `python -m unittest discover -s plugins/FunscriptOllama/tests -v` and
`python tools/package_funscript_ollama.py --output-dir dist/funscript-ollama --revision local --check`.
Keep the two plugin packages independent. `tools/package_catalog.py` builds the
shared `tvguide-iptv/index.yml` with both IDs and archives. The single release
workflow waits for both test matrices before publishing this shared source and
the compatible Funscript-only `funscript-ollama` source. Do not add a competing
publisher that overwrites the shared index with only one plugin.
Never overwrite media sidecars by default, generate invented timing from model
responses, install dependencies at task runtime or log access credentials.

Build in `plugins/StashIP-TV`: `npm ci`, `npm run build`.
Run `npm test -- --runInBand --silent` and `npm run test:iptv`.
Set `FFMPEG_TEST_PATH` to run the real-media tests; CI does so on Windows/Ubuntu.
Build/check an installable archive from the root with
`python tools/package_stashiptv.py --output-dir dist --revision local --check`.

Keep package inclusion explicit. Never ship node_modules, development fixtures,
or extra plugin YAML files. Stash scans all YAML files as potential manifests.

The visible name is StashIP-TV, but the technical ID `TVGuide`, manifest name
`TVGuide.yml`, `configuration.plugins.TVGuide`, `tvguide_state` and its keys,
legacy environment variables, stream/channel IDs and daemon state directory
are compatibility boundaries. Do not rename them or change the tuner identity
seed without an explicit migration strategy. An ordinary update must retain all
channels, names, saved filters, credentials and connected client mappings.

Use `node` from the Stash process PATH in the manifest. Node and FFmpeg must be
available to the same runtime/account as Stash. No Linux-only executable path in
the shared plugin manifest; document service PATH and Windows executable paths.

Do not restore the browser player/grid entry point. Shared domain/state modules
and existing tests remain because IPTV and channel management depend on them.

TVGuide's original per-directory coverage thresholds remain: src/domain and
src/state have 100% statements/lines/functions and 90% branches; src/api and
src/ui have 80% statements/lines/functions and 70% branches. Tests must verify
behaviour, persistence, protocol compatibility, lifecycle and credential isolation.

The release workflow tests Ubuntu/Windows on Node 20/22/24, then publishes only
from main to the stable `tvguide-iptv` branch. The index ID remains TVGuide while
the name/archive are StashIP-TV. No GitHub Pages deployment is required.

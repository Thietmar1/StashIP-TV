"""Build and validate the independent Intiface Sync Stash package."""
import argparse
import datetime
import hashlib
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = ["IntifaceSync.yml", "IntifaceSync.py", "IntifaceSync.js", "README.md"]


def package(output_dir, revision, check=False):
    if not re.fullmatch(r"[A-Za-z0-9._-]+", revision):
        raise ValueError("Invalid revision")
    plugin = ROOT / "plugins" / "intifacesyncer"
    manifest = (plugin / "IntifaceSync.yml").read_text(encoding="utf-8")
    version = re.search(r'^version:\s*"([^"]+)"', manifest, re.M)[1]
    output_dir.mkdir(parents=True, exist_ok=True)
    archive = output_dir / "IntifaceSync.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name in FILES:
            bundle.write(plugin / name, name)
        bundle.write(ROOT / "LICENCE", "LICENCE")
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    date = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    index = (
        '- id: IntifaceSync\n'
        '  name: Intiface Sync\n'
        '  metadata:\n'
        '    description: Funscript synchronization with Intiface Central, Buttplug.io and The Handy, including vibrating devices.\n'
        f'  version: "{version}-{revision}"\n'
        f'  date: "{date}"\n'
        '  path: IntifaceSync.zip\n'
        f'  sha256: {checksum}\n'
    )
    (output_dir / "index.yml").write_text(index, encoding="utf-8")
    if check:
        with zipfile.ZipFile(archive) as bundle:
            assert set(bundle.namelist()) == set(FILES + ["LICENCE"]), "Unexpected package contents"
            assert [n for n in bundle.namelist() if n.endswith((".yml", ".yaml"))] == ["IntifaceSync.yml"], "Plugin ID changed"
            backend = bundle.read("IntifaceSync.py").decode("utf-8")
            javascript = bundle.read("IntifaceSync.js").decode("utf-8")
            compile(backend, "IntifaceSync.py", "exec")
            assert re.search(r'^PLUGIN_VERSION\s*=\s*"' + re.escape(version) + '"', backend, re.M), "Backend version differs"
            assert re.search(r'const PLUGIN_VERSION\s*=\s*"' + re.escape(version) + '"', javascript), "UI version differs"
            assert re.search(r'const PLUGIN_ID\s*=\s*"IntifaceSync"', javascript), "Settings identity differs"
            assert re.search(r'^  - "\{pluginDir\}/IntifaceSync.py"$', manifest, re.M), "Backend entry point differs"
            assert re.search(r'^    - IntifaceSync.js$', manifest, re.M), "UI entry point differs"
        assert checksum in (output_dir / "index.yml").read_text(encoding="utf-8"), "Index checksum differs"
    print(f"Built {archive} (SHA256 {checksum})" + ("; package checks passed" if check else ""))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--revision", default="dev")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    package(args.output_dir, args.revision, args.check)

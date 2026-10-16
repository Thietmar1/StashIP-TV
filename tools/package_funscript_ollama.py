"""Package the independent Ollama plugin, without changing the IPTV source."""
import argparse
import datetime
import hashlib
import pathlib
import re
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
FILES = ["FunscriptOllama.yml", "funscript_ollama.py", "haven_motion.py", "chapters.py",
         "requirements.txt", "recommended-settings.json", "README.md", "THIRD-PARTY-NOTICES.md"]


def package(output_dir, revision, check=False):
    if not re.fullmatch(r"[A-Za-z0-9._-]+", revision):
        raise ValueError("Invalid revision")
    plugin = ROOT / "plugins" / "FunscriptOllama"
    manifest = (plugin / "FunscriptOllama.yml").read_text(encoding="utf-8")
    version = re.search(r'^version:\s*"([^"]+)"', manifest, re.M)[1]
    output_dir.mkdir(parents=True, exist_ok=True)
    archive = output_dir / "FunscriptOllama.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for name in FILES:
            bundle.write(plugin / name, name)
        bundle.write(ROOT / "LICENCE", "LICENCE")
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    date = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    (output_dir / "index.yml").write_text(
        f'- id: FunscriptOllama\n'
        f'  name: Funscript Ollama\n'
        f'  metadata:\n'
        f'    description: Ollama and Haven motion analysis with VR, extra axes and chapter markers.\n'
        f'  version: "{version}-{revision}"\n'
        f'  date: "{date}"\n'
        f'  path: FunscriptOllama.zip\n'
        f'  sha256: {checksum}\n', encoding="utf-8")
    if check:
        code = (plugin / "funscript_ollama.py").read_text(encoding="utf-8")
        assert f'VERSION = "{version}"' in code, "Versions differ"
        assert 'PLUGIN_ID = "FunscriptOllama"' in code, "Settings identity differs"
        with zipfile.ZipFile(archive) as bundle:
            assert set(bundle.namelist()) == set(FILES + ["LICENCE"]), "Unexpected package contents"
            assert sum(n.endswith(".yml") for n in bundle.namelist()) == 1, "Multiple plugin manifests"
            for name in ("funscript_ollama.py", "haven_motion.py", "chapters.py"):
                compile(bundle.read(name), name, "exec")
        assert checksum in (output_dir / "index.yml").read_text(), "Index checksum differs"
    print(f"Built {archive} (SHA256 {checksum})" + ("; package checks passed" if check else ""))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=pathlib.Path, required=True)
    parser.add_argument("--revision", default="dev")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    package(args.output_dir, args.revision, args.check)

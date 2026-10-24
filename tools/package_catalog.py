"""Build the independent packages and the shared Stash plugin catalog."""
import argparse
import hashlib
from pathlib import Path
import shutil

from package_stashiptv import package as package_tv
from package_funscript_ollama import package as package_funscript
from package_intifacesyncer import package as package_intiface


def package(output_dir, revision, check=False):
    package_tv(output_dir / "tvguide", revision, check)
    package_funscript(output_dir / "funscript", revision, check)
    package_intiface(output_dir / "intifacesyncer", revision, check)
    indices = []
    for folder, archive, identity in (("tvguide", "StashIP-TV.zip", "TVGuide"),
                                      ("funscript", "FunscriptOllama.zip", "FunscriptOllama"),
                                      ("intifacesyncer", "IntifaceSync.zip", "IntifaceSync")):
        source = output_dir / folder
        index = (source / "index.yml").read_text(encoding="utf-8")
        shutil.copyfile(source / archive, output_dir / archive)
        if check:
            assert index.startswith(f"- id: {identity}\n"), "Wrong plugin identity"
            assert f"  path: {archive}\n" in index, "Wrong relative archive path"
            assert hashlib.sha256((output_dir / archive).read_bytes()).hexdigest() in index, "Checksum mismatch"
        indices.append(index.rstrip()+"\n")
    (output_dir / "index.yml").write_text("".join(indices), encoding="utf-8")
    print("Shared catalog contains TVGuide, FunscriptOllama and IntifaceSync; all archives checked" if check else "Built shared catalog")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--revision", default="dev")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    package(args.output_dir, args.revision, args.check)

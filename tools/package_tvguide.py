"""Build the TVGuide-only Stash package source, without requiring GitHub Pages."""
import argparse
import datetime
import hashlib
import pathlib
import re
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
FILES = ['TVGuide.yml', 'tvguide.js', 'tvguide.css', 'tvguide-server.js',
         'IPTV.md', 'NATIVE-APPS.md', 'THIRD-PARTY-NOTICES.txt', 'tvguide-iptv.service']


def package(output_dir, revision):
    if not re.fullmatch(r'[A-Za-z0-9._-]+', revision):
        raise ValueError('Invalid revision')
    plugin = ROOT / 'plugins' / 'TVGuide'
    version = re.search(r'^version:\s*"([^"]+)"', (plugin / 'TVGuide.yml').read_text(), re.M)[1]
    output_dir.mkdir(parents=True, exist_ok=True)
    archive = output_dir / 'TVGuide.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
        for name in FILES:
            bundle.write(plugin / name, name)
        bundle.write(ROOT / 'LICENCE', 'LICENCE')
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    date = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
    (output_dir / 'index.yml').write_text(
        f'- id: TVGuide\n'
        f'  name: TV Guide\n'
        f'  metadata:\n'
        f'    description: TVGuide channel management, Jellyfin live TV and optional Stashy adapter.\n'
        f'  version: "{version}-{revision}"\n'
        f'  date: "{date}"\n'
        f'  path: TVGuide.zip\n'
        f'  sha256: {checksum}\n', encoding='utf-8')
    print(f'Built {archive} (SHA256 {checksum})')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=pathlib.Path, required=True)
    parser.add_argument('--revision', default='dev')
    args = parser.parse_args()
    package(args.output_dir, args.revision)

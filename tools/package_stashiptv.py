"""Build and check the portable StashIP-TV package without GitHub Pages."""
import argparse
import datetime
import hashlib
import pathlib
import re
import zipfile
import json

ROOT = pathlib.Path(__file__).resolve().parents[1]
FILES = ['TVGuide.yml', 'tvguide.js', 'tvguide.css', 'tvguide-server.js', 'README.md',
         'IPTV.md', 'NATIVE-APPS.md', 'PLEX-EMBY.md', 'THIRD-PARTY-NOTICES.txt', 'stashiptv.service']


def package(output_dir, revision, check=False):
    if not re.fullmatch(r'[A-Za-z0-9._-]+', revision):
        raise ValueError('Invalid revision')
    plugin = ROOT / 'plugins' / 'StashIP-TV'
    version = re.search(r'^version:\s*"([^"]+)"', (plugin / 'TVGuide.yml').read_text(encoding='utf-8'), re.M)[1]
    output_dir.mkdir(parents=True, exist_ok=True)
    archive = output_dir / 'StashIP-TV.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
        for name in FILES:
            if name == 'README.md':
                readme = (ROOT / name).read_text(encoding='utf-8').replace('](plugins/StashIP-TV/', '](')
                bundle.writestr(name, readme)
            else:
                bundle.write(plugin / name, name)
        bundle.write(ROOT / 'LICENCE', 'LICENCE')
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    date = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S')
    (output_dir / 'index.yml').write_text(
        f'- id: TVGuide\n'
        f'  name: StashIP-TV\n'
        f'  metadata:\n'
        f'    description: StashIP-TV live channels and EPG for Jellyfin, Stashy, Plex and Emby.\n'
        f'  version: "{version}-{revision}"\n'
        f'  date: "{date}"\n'
        f'  path: StashIP-TV.zip\n'
        f'  sha256: {checksum}\n', encoding='utf-8')
    if check:
        manifest = (plugin / 'TVGuide.yml').read_text(encoding='utf-8')
        metadata = json.loads((plugin / 'package.json').read_text(encoding='utf-8'))
        lock = json.loads((plugin / 'package-lock.json').read_text(encoding='utf-8'))
        assert re.search(r'^name: StashIP-TV$', manifest, re.M), 'Incorrect visible name'
        assert re.search(r'^exec:\s*\n  - node\s*\n', manifest, re.M), 'Portable Node launcher missing'
        assert version == metadata['version'] == lock['version'] == lock['packages']['']['version'], 'Versions differ'
        with zipfile.ZipFile(archive) as bundle:
            assert set(bundle.namelist()) == set(FILES + ['LICENCE']), 'Unexpected package contents'
            assert [name for name in bundle.namelist() if name.endswith('.yml')] == ['TVGuide.yml'], 'Plugin ID changed'
        assert checksum in (output_dir / 'index.yml').read_text(), 'Index checksum differs'
    print(f'Built {archive} (SHA256 {checksum})' + ('; package checks passed' if check else ''))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=pathlib.Path, required=True)
    parser.add_argument('--revision', default='dev')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    package(args.output_dir, args.revision, args.check)

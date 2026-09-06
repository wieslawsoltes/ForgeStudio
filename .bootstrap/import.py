#!/usr/bin/env python3
"""One-time, checksum-verified import of the delivered Forge Studio source."""
import base64
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE_SHA = '99ae006e998bc0fb2d5325b05b33e57c373c79a96d81ba4a57013cd41b8b89a1'
ACORN_SHA = 'b4c8c70200e72bae33cf1085e0ecb1e792c1b6924ed50cab817caf14f51bb249'
STANDALONE_SHA = '6c3653afd2a05c5c6b04af56156f04c31c75fcd7c5788a5f1ce825fabfc42240'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    encoded = ''.join((ROOT / '.bootstrap' / f'chunk-{i:02d}.b64').read_text(encoding='ascii').strip() for i in range(1, 14))
    data = base64.b64decode(encoded, validate=True)
    if len(data) != 77924 or digest(data) != ARCHIVE_SHA:
        raise RuntimeError('Source archive integrity check failed')
    files = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:xz') as archive:
        members = archive.getmembers()
        if len(members) != 28 or sum(m.size for m in members) > 10_000_000:
            raise RuntimeError('Unexpected source archive size')
        for member in members:
            path = PurePosixPath(member.name)
            if not member.isfile() or path.is_absolute() or '..' in path.parts or '\\' in member.name:
                raise RuntimeError('Unsafe source archive entry')
            if not path.parts or path.parts[0] in {'.git', '.github', '.bootstrap'} or member.name in files:
                raise RuntimeError('Unexpected source archive entry')
            with archive.extractfile(member) as source:
                contents = source.read()
            destination = ROOT.joinpath(*path.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(contents)
            files[member.name] = digest(contents)
    request = urllib.request.Request('https://registry.npmjs.org/acorn/-/acorn-8.15.0.tgz', headers={'User-Agent': 'ForgeStudio-source-import'})
    with urllib.request.urlopen(request, timeout=60) as response:
        package = response.read(5_000_001)
    if len(package) > 5_000_000:
        raise RuntimeError('Parser package exceeded size limit')
    with tarfile.open(fileobj=io.BytesIO(package), mode='r:gz') as archive:
        entry = archive.getmember('package/dist/acorn.mjs')
        if not entry.isfile() or entry.size > 2_000_000:
            raise RuntimeError('Unexpected parser archive entry')
        with archive.extractfile(entry) as source:
            parser = source.read()
    if digest(parser) != ACORN_SHA:
        raise RuntimeError('Vendored Acorn integrity check failed')
    (ROOT / 'vendor' / 'acorn.mjs').write_bytes(parser)
    files['vendor/acorn.mjs'] = ACORN_SHA
    provenance = {'source_archive_sha256': ARCHIVE_SHA, 'portable_html_sha256': STANDALONE_SHA, 'files': files}
    (ROOT / 'docs' / 'SOURCE-INTEGRITY.json').write_text(json.dumps(provenance, indent=2, sort_keys=True) + '\n', encoding='utf-8')
    print(f'Imported {len(files)} verified source files; archive SHA-256 {ARCHIVE_SHA}')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Verify that Pages serves this exact build, including module and worker assets."""
import hashlib
import json
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


def fetch(url):
    request = urllib.request.Request(url, headers={'Cache-Control': 'no-cache', 'User-Agent': 'ForgeStudio-deployment-check'})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def main():
    if len(sys.argv) != 4:
        raise SystemExit('Usage: verify-deployment.py BASE_URL SOURCE_COMMIT SITE_DIRECTORY')
    base, commit, directory = sys.argv[1:]
    base = base.rstrip('/') + '/'
    site = Path(directory)
    if not site.is_dir():
        raise SystemExit('Static site directory does not exist')
    expected = {p.relative_to(site).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in site.rglob('*') if p.is_file() and p.name != '.nojekyll'}
    last_error = None
    for attempt in range(1, 61):
        try:
            suffix = '?revision=' + urllib.parse.quote(commit) + '&attempt=' + str(attempt)
            metadata = json.loads(fetch(base + 'deployment.json' + suffix))
            if metadata.get('source_commit') != commit:
                raise ValueError('Pages is still serving a previous revision')
            for path, checksum in expected.items():
                actual = hashlib.sha256(fetch(base + urllib.parse.quote(path, safe='/') + suffix)).hexdigest()
                if actual != checksum:
                    raise ValueError('Published asset mismatch: ' + path)
            print(f'PASS: {base} serves source revision {commit}; verified {len(expected)} asset SHA-256 checksums.', flush=True)
            return
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as error:
            last_error = error
            print(f'Deployment check {attempt}/60: {error}', flush=True)
            if attempt < 60:
                time.sleep(5)
    raise SystemExit('Published deployment verification failed: ' + str(last_error))


if __name__ == '__main__':
    main()

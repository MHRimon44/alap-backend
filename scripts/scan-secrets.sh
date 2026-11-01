#!/usr/bin/env bash
set -euo pipefail

# Scan repository files, honoring .gitignore. Report paths only, never matching secrets.
python3 - <<'PY'
import pathlib
import re
import subprocess
import sys

files = subprocess.check_output([
    'git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'
]).decode().split('\0')
patterns = [
    re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{40,}'),
    re.compile(rb'AKIA[0-9A-Z]{16}'),
    re.compile(rb'"private_key"\s*:\s*"-----BEGIN'),
]
hits = set()
for name in set(files):
    path = pathlib.Path(name)
    if not path.is_file() or path.is_symlink() or name.endswith(('.zip', '.lock')):
        continue
    if path.name == '.env' or (path.name.startswith('.env.') and not path.name.endswith('.example')):
        hits.add(name)
        continue
    content = path.read_bytes()
    if any(pattern.search(content) for pattern in patterns):
        hits.add(name)
if hits:
    print('Potential credential material detected in:')
    for name in sorted(hits):
        print(name)
    sys.exit(1)
print('PASS: no high-confidence private key, service-account key, AWS access key or tracked environment file detected. This is not a complete historical secret audit.')
PY

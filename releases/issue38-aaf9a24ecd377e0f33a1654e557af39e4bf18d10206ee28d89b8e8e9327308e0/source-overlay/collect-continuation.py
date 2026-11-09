# SPDX-License-Identifier: GPL-3.0-or-later
from pathlib import Path
import hashlib
import json
import re
import sys
import time

operation_path, downloads, record_path, binding_path = map(Path, sys.argv[1:])
operation_bytes = operation_path.read_bytes()
operation = json.loads(operation_bytes)
assert operation['returncode'] == 0 and operation['pid'] > 0
start = operation['epoch'] * 1000
assert record_path.suffix == binding_path.suffix == '.json'
assert record_path != binding_path and not record_path.exists() and not binding_path.exists()
deadline = time.monotonic() + 15
while True:
    found = []
    for path in downloads.glob('voice-project-*.json'):
        match = re.fullmatch(r'voice-project-([0-9]+)\.json', path.name)
        if not match or path.is_symlink():
            continue
        stat = path.stat()
        if (int(start) <= int(match[1]) <= start + 55000 and
                start <= stat.st_mtime_ns / 1_000_000 <= start + 55000 and
                0 < stat.st_size < 262144 and not path.with_suffix('.json.part').exists()):
            found.append(path)
    if found:
        break
    if time.monotonic() >= deadline:
        raise TimeoutError('own_metadata_not_downloaded')
    time.sleep(.2)
assert len(found) == 1, 'current_export_ambiguous'
path = found[0]
content = path.read_bytes()
assert json.loads(content)['schema'] == 'voice-version-record-v1'
binding = {'schema': 'voice-current-export-binding-v1',
           'operation_sha256': hashlib.sha256(operation_bytes).hexdigest(),
           'download': path.name, 'download_mtime_ms': path.stat().st_mtime_ns / 1_000_000,
           'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()}
with record_path.open('xb') as stream:
    stream.write(content)
with binding_path.open('x') as stream:
    json.dump(binding, stream, indent=2)
    stream.write('\n')
print(json.dumps(binding))

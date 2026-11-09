# SPDX-License-Identifier: GPL-3.0-or-later
from pathlib import Path
import argparse
import hashlib
import json

parser=argparse.ArgumentParser(description='Verify and apply the complete source overlay to the unpacked base source.')
parser.add_argument('source_root',type=Path)
args=parser.parse_args()
here=Path(__file__).resolve().parent
manifest=json.loads((here/'manifest.json').read_text())
assert args.source_root.is_dir()
for item in manifest['files']:
    name=Path(item['path'])
    assert not name.is_absolute() and '..' not in name.parts
    data=(here/name).read_bytes()
    assert len(data)==item['bytes'] and hashlib.sha256(data).hexdigest()==item['sha256'],str(name)
for item in manifest['files']:
    name=Path(item['path'])
    if name.parts[0] not in {'issue42','tests'} and name.as_posix() not in {'prepare-continuation.mjs','check-continuation.mjs','collect-continuation.py'}:continue
    destination=args.source_root/name
    destination.parent.mkdir(parents=True,exist_ok=True)
    destination.write_bytes((here/name).read_bytes())
print('Verified source overlay applied. Follow the base package build instructions; SDK native sources are unchanged.')

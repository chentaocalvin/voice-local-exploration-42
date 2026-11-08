# SPDX-License-Identifier: GPL-3.0-or-later
from pathlib import Path
import argparse
import ast
import hashlib
import json
import re

parser=argparse.ArgumentParser(description='Build the browser text files and reusable Git tree entries for this release.')
parser.add_argument('source_root',type=Path)
parser.add_argument('base_manifest',type=Path)
parser.add_argument('public_basis',type=Path)
parser.add_argument('output_root',type=Path)
parser.add_argument('--text-only',action='store_true',help='Keep generated HTML as .html.txt for text-only preparation.')
args=parser.parse_args()
root=args.source_root
sha=lambda value:hashlib.sha256(value).hexdigest()
gitsha=lambda value:hashlib.sha1(b'blob '+str(len(value)).encode()+b'\0'+value).hexdigest()
old=json.loads(args.base_manifest.read_text())
basis=json.loads(args.public_basis.read_text())
assets={item['path']:item for item in basis['leaf']['tree'] if item['type']=='blob'}
RUNTIME_PATHS = (
    'app.mjs',
    'assets.mjs',
    'engine.mjs',
    'identity.mjs',
    'joint/actions.mjs',
    'joint/archive.mjs',
    'joint/difference.mjs',
    'joint/engine.mjs',
    'joint/exploration_feedback.mjs',
    'joint/exploration_profile.mjs',
    'joint/feedback.mjs',
    'joint/input.mjs',
    'joint/intent_editor.mjs',
    'joint/intents.mjs',
    'joint/native_piano.mjs',
    'joint/piano_phase.mjs',
    'joint/praat_quality.mjs',
    'joint/private_piano_controls.mjs',
    'joint/private_run.mjs',
    'joint/private_run_receipt.mjs',
    'joint/private_run_transfer.mjs',
    'joint/private_setup.mjs',
    'joint/private_usage.mjs',
    'joint/public_probe.mjs',
    'joint/registered_piano.mjs',
    'joint/signed_exploration.mjs',
    'joint/signed_piano.mjs',
    'joint/signed_piano_model.mjs',
    'joint/solo_motion.mjs',
    'joint/solo_noise.mjs',
    'joint/solo_phase.mjs',
    'joint/solo_waveform.mjs',
    'joint/spectral_headroom.mjs',
    'joint/version_records.mjs',
    'pcm.mjs',
    'pitch.mjs',
    'processor.mjs',
    'projects.mjs',
    'qualification.mjs',
    'state.mjs',
    't_control.mjs',
    'waveform_tilt.mjs',
    'world.mjs',
)
runtime_files=[root/'issue42'/name for name in RUNTIME_PATHS]
files={f.relative_to(root/'issue42').as_posix():f.read_text() for f in runtime_files}
page=ast.parse((root/'issue42/page.py').read_text())
assign=next(node for node in page.body if isinstance(node,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='HTML' for t in node.targets))
files['index.html']=ast.literal_eval(assign.value)
overlay={f'source-overlay/issue42/{name}':content for name,content in files.items() if name.endswith('.mjs')}
overlay['source-overlay/issue42/page.py']=(root/'issue42/page.py').read_text()
TEST_PATHS = (
    'fixed_combination_plan.mjs',
    'test_fixed_combination_plan.mjs',
    'test_archive_feedback.mjs',
    'test_shared_spectral_headroom.mjs',
    'test_shared_headroom_engine.mjs',
    'test_shared_headroom_contract.mjs',
    'test_shared_headroom_ui.mjs',
    'test_spectral_headroom.mjs',
    'test_headroom_engine.mjs',
    'test_headroom_run_scope.mjs',
    'test_headroom_contract.mjs',
    'test_headroom_ui.mjs',
    'test_exploration_contract.mjs',
    'test_exploration_engine.mjs',
    'test_exploration_matrix.mjs',
    'test_exploration_methods.mjs',
    'test_exploration_public_probe.mjs',
    'test_exploration_transfer.mjs',
    'test_exploration_ui.mjs',
    'exploration_fixture.mjs',
    'public_probe_fixture.mjs',
    'app_fixture.mjs',
    'memory_indexeddb.mjs',
)
tests=[root/'tests/issue38'/name for name in TEST_PATHS]
for f in tests:overlay['source-overlay/'+f.relative_to(root).as_posix()]=f.read_text()
overlay['source-overlay/apply_overlay.py']='''# SPDX-License-Identifier: GPL-3.0-or-later
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
    if name.parts[0] not in {'issue42','tests'}:continue
    destination=args.source_root/name
    destination.parent.mkdir(parents=True,exist_ok=True)
    destination.write_bytes((here/name).read_bytes())
print('Verified source overlay applied. Follow the base package build instructions; SDK native sources are unchanged.')
'''
overlay['source-overlay/README.md']='''# Complete corresponding source

This release is GPL-3.0-or-later. Its complete source consists of the unchanged base source archive linked by ../release.json plus every file in this source-overlay directory. The base includes the native SDK sources, existing build instructions and notices; the overlay supplies all browser application modules, the PAGE source and the new SDK0 tests. No native SDK binary was changed for this release.

1. Download the base archive using the page's base-source button or the source chunks listed in ../release.json. Verify its published SHA-256 and unpack it.
2. Download this directory (or the complete repository at this release's public commit). manifest.json lists every overlay file with its byte count and SHA-256. Keep its relative directory structure.
3. Run `python3 -B apply_overlay.py /path/to/unpacked/source` with the directory containing issue42 and tests. It verifies the overlay and copies only those source directories. Existing files are intentionally replaced by this release's source.
4. Follow the base source's native SDK/build instructions. The web layer uses the supplied issue42/**/*.mjs files unchanged and renders the literal HTML string in issue42/page.py as index.html. Deploy them alongside the unchanged assets and licenses, and use this release's ../release.json. The public example retains its separate CC-BY-4.0 attribution there.

The base source archive alone represents the earlier base. Apply the overlay to obtain this release. The parent source archive SHA-256 is 5fbcaab06e721a9825c5bb6a55f3f365fa5244ff0a1f0a6146b55e368d094dff. Full GPL text and third-party notices are available in ../licenses/.

The exact text/Git-object build helper is included as build_release.py, with its public base inputs base-release.json and public-basis.json. After applying the overlay, run `python3 -B source-overlay/build_release.py /path/to/source source-overlay/base-release.json source-overlay/public-basis.json /path/to/output`. It emits the text files and Git tree entries; unchanged assets/licenses are reused by their object identities. Export those assets/licenses from the public base release into the output before serving. The --text-only option writes index.html.txt for environments restricted to source text; the Git payload still names index.html.

The new tests use synthetic inputs and external SDK/storage boundary substitutes. Passing them does not establish sound quality on arbitrary recordings. Node with node:module registerHooks support was used for the SDK0 Worker cases. Private recordings, operational credentials and internal work records are not part of this public distribution.
'''
overlay['source-overlay/build_release.py']=Path(__file__).read_text()
overlay['source-overlay/base-release.json']=json.dumps(old,ensure_ascii=False,indent=2)+'\n'
overlay['source-overlay/public-basis.json']=json.dumps(basis,ensure_ascii=False,indent=2)+'\n'
inventory=[{'path':name.removeprefix('source-overlay/'),'bytes':len(content.encode()),'sha256':sha(content.encode())} for name,content in sorted(overlay.items())]
overlay['source-overlay/manifest.json']=json.dumps({'schema':'voice-source-overlay-v1','license':'GPL-3.0-or-later','base_source_sha256':old['source']['sha256'],'files':inventory},ensure_ascii=False,indent=2)+'\n'
files.update(overlay)
manifest=json.loads(json.dumps(old))
manifest.pop('release',None)
manifest['public_probe']='issue38-anonymous-example-v1'
manifest['private_profile']='issue38-joint-shared-spectral-headroom-v1'
manifest['source_overlay']={'path':'source-overlay/README.md','bytes':len(overlay['source-overlay/README.md'].encode()),'sha256':sha(overlay['source-overlay/README.md'].encode()),'inventory':'source-overlay/manifest.json','inventory_sha256':sha(overlay['source-overlay/manifest.json'].encode())}
source_inventory=[{'path':name,'bytes':len(content.encode()),'sha256':sha(content.encode())} for name,content in sorted(files.items())]
identity={'schema':'issue38-public-exploration-release-source-v1','files':source_inventory,'manifest_without_release':manifest}
release=sha(json.dumps(identity,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode())
manifest['release']=release
files['release.json']=json.dumps(manifest,ensure_ascii=False,indent=2)+'\n'
for name,content in files.items():
    assert not Path(name).is_absolute() and '..' not in Path(name).parts
    assert not any(part.startswith('.') for part in Path(name).parts)
    assert not re.search(r'/(?:Users|home|scratch)/[A-Za-z0-9_.-]+|/private/\x74mp/[A-Za-z0-9_.-]+|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|MessageTemp/[a-f0-9]{32}/|sourceSha256\s*:\s*[\'\"][a-f0-9]{64}',content),name
    assert len(content.encode())<256*1024,name
directory=args.output_root/'public-candidate';directory.mkdir(parents=True,exist_ok=True)
for name,content in files.items():
    # Keep all local preparation inside the text whitelist. index.html is only
    # emitted as an in-memory Git blob at publication time.
    target=directory/(name+'.txt' if args.text_only and name.endswith('.html') else name)
    target.parent.mkdir(parents=True,exist_ok=True);target.write_text(content)
entries=[]
for name,item in sorted(assets.items()):
    if name in files:continue
    entries.append({'path':name,'mode':'100644','type':'blob','sha':item['sha']})
new_blobs={}
known={item['sha'] for item in assets.values()}
for name,content in sorted(files.items()):
    object_sha=gitsha(content.encode())
    entries.append({'path':name,'mode':'100644','type':'blob','sha':object_sha})
    if object_sha not in known:new_blobs.setdefault(object_sha,content)
summary={'schema':'issue38-public-exploration-candidate-v1','release':release,'relative_destination':'releases/issue38-'+release,
    'parent_public_commit':basis['commit']['sha'],'parent_public_tree':basis['tree']['sha'],'parent_releases_tree':next(x['sha'] for x in basis['tree']['tree'] if x['path']=='releases'),
    'files':source_inventory,'manifest':manifest,'tree_entries':entries,'new_blobs':list(new_blobs),'blob_count':len(new_blobs),'source_assets_reused':True,'existing_paths_to_replace':[],
    'private_media_published':False,'scan':'PASS','real_sdk_calls':0,'real_input_reads':0,'new_jobs':0}
(args.output_root/'public-candidate.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
(args.output_root/'public-blobs.json').write_text(json.dumps(new_blobs,ensure_ascii=False))
(args.output_root/'public-candidate-source-identity.json').write_text(json.dumps(identity,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'release':release,'public_files':len(entries),'new_text_blobs':len(new_blobs),'new_text_bytes':sum(len(x.encode()) for x in new_blobs.values()),'scan':'PASS','SDK0':True}))

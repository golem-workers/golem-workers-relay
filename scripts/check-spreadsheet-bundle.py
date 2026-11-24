#!/usr/bin/env python3
"""Pin every deployed runtime byte into the snapshot preparation fingerprint."""
import hashlib,pathlib,re,sys,os
root=pathlib.Path(__file__).resolve().parent.parent
skill=root/'tools/golem-spreadsheets'
files=[skill/'package.json',skill/'package-lock.json',root/'scripts/install-spreadsheet-tools.sh',root/'scripts/prepare-spreadsheet-runtime.sh']
for folder in ['scripts','vendor']:
    files += [p for p in (skill/folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.suffix!='.pyc']
manifest=''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+pathlib.Path(os.path.relpath(p,skill)).as_posix()+'\n' for p in sorted(files))
pin=hashlib.sha256(manifest.encode()).hexdigest();prepare=root/'scripts/prepare-agent-server.sh';script=prepare.read_text()
if sys.argv[1:]==['--write']:
    (skill/'manifest.sha256').write_text(manifest)
    if 'SPREADSHEET_BUNDLE_SHA256=' not in script:
        script=script.replace('RUN_OPENCLAW_ONBOARD=1','SPREADSHEET_BUNDLE_SHA256="'+pin+'"\nRUN_OPENCLAW_ONBOARD=1',1)
    else: script=re.sub(r'SPREADSHEET_BUNDLE_SHA256="[a-f0-9]+"','SPREADSHEET_BUNDLE_SHA256="'+pin+'"',script)
    prepare.write_text(script)
else:
    assert (skill/'manifest.sha256').read_text()==manifest,'Spreadsheet bundle changed; run python3 scripts/check-spreadsheet-bundle.py --write'
    assert 'SPREADSHEET_BUNDLE_SHA256="'+pin+'"' in script,'Snapshot fingerprint pin is stale'
print('Spreadsheet bundle SHA256: '+pin)

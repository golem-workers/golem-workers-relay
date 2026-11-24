#!/usr/bin/env python3
import sys,json,zipfile
try:
    r=json.load(sys.stdin)
    with zipfile.ZipFile(r['input']) as z:
        files=z.infolist()
        if len(files)>10000 or sum(f.file_size for f in files)>256*1024*1024: raise ValueError('ZIP expansion limit exceeded')
        if len({f.filename for f in files})!=len(files): raise ValueError('Duplicate ZIP members')
        kind=None
        if 'xl/workbook.bin' in z.namelist(): kind='xlsb'
        elif '[Content_Types].xml' in z.namelist():
            import xml.etree.ElementTree as ET
            data=z.read('[Content_Types].xml')
            if b'<!DOCTYPE' in data or b'<!ENTITY' in data: raise ValueError('DTD/entities refused')
            for item in ET.fromstring(data):
                if item.attrib.get('PartName')=='/xl/workbook.xml':
                    ct=item.attrib.get('ContentType','')
                    kind='xltm' if 'template.macroEnabled' in ct else 'xltx' if 'template.main' in ct else 'xlsm' if 'macroEnabled' in ct else 'xlsx'
    print(json.dumps({'archiveChecked':True,'workbookFormat':kind}))
except Exception as e: print(str(e),file=sys.stderr);sys.exit(1)

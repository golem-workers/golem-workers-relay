#!/usr/bin/env python3
"""Patch cell XML while retaining every other ZIP member's uncompressed bytes."""
import sys, json, zipfile, posixpath, re, hashlib
from xml.dom import minidom

def elements(node, name):
    return [x for x in node.childNodes if x.nodeType == x.ELEMENT_NODE and x.localName == name]
def xml(data):
    if re.search(br'<!\s*(DOCTYPE|ENTITY)', data, re.I):
        raise ValueError('DTD/entity declarations are not accepted')
    return minidom.parseString(data)
def text(doc, parent, ns, name, value):
    child = doc.createElementNS(ns, name)
    child.appendChild(doc.createTextNode(str(value)))
    parent.appendChild(child)
    return child
def coordinate(address):
    if not re.fullmatch(r'[A-Z]{1,3}[1-9][0-9]*', address): raise ValueError('Invalid A1 cell')
    col, row = re.match(r'([A-Z]+)([0-9]+)', address).groups()
    n = 0
    for c in col: n = n * 26 + ord(c) - 64
    if n > 16384 or int(row) > 1048576: raise ValueError('Excel address limit exceeded')
    return int(row), n

def patch(request):
    with zipfile.ZipFile(request['input']) as source:
        infos = source.infolist()
        if len(infos) > 10000 or sum(x.file_size for x in infos) > 256*1024*1024: raise ValueError('ZIP expansion limit exceeded')
        if len({x.filename for x in infos}) != len(infos): raise ValueError('Duplicate ZIP members')
        if any(x.filename.startswith('_xmlsignatures/') for x in infos): raise ValueError('Signed workbook needs explicit signature-removal workflow')
        parts = {x.filename: source.read(x) for x in infos}
        wb = xml(parts['xl/workbook.xml'])
        rel = xml(parts['xl/_rels/workbook.xml.rels'])
        rels = {}
        for item in rel.getElementsByTagName('*'):
            if item.localName != 'Relationship': continue
            if item.getAttribute('TargetMode') == 'External': continue
            target = item.getAttribute('Target')
            target = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join('xl', target))
            if not target.startswith('xl/'): raise ValueError('Invalid worksheet relationship')
            rels[item.getAttribute('Id')] = target
        sheets = {}
        for item in wb.getElementsByTagName('*'):
            if item.localName == 'sheet':
                rid = next((a.value for a in item.attributes.values() if a.localName == 'id'), None)
                if rid in rels: sheets[item.getAttribute('name')] = rels[rid]
        grouped = {}
        for change in request['changes']: grouped.setdefault(sheets[change['sheet']], []).append(change)
        modified = {}
        for filename, changes in grouped.items():
            doc = xml(parts[filename]); root = doc.documentElement; ns = root.namespaceURI
            if root.prefix: raise ValueError('Prefixed OOXML worksheet requires a namespace-aware extended editor')
            data = elements(root, 'sheetData')
            if len(data) != 1: raise ValueError('No unique sheetData')
            data = data[0]
            if elements(root, 'sheetProtection'): raise ValueError('Protected worksheet; do not bypass protection')
            # Reject edits to non-anchor merged cells and shared/array formula regions.
            for change in changes:
                rownum, colnum = coordinate(change['cell'])
                for node in root.getElementsByTagName('*'):
                    if node.localName not in ('mergeCell', 'f') or not node.hasAttribute('ref'): continue
                    region = node.getAttribute('ref').split(':'); start = coordinate(region[0]); end = coordinate(region[-1])
                    if start[0] <= rownum <= end[0] and start[1] <= colnum <= end[1]:
                        if node.localName == 'f' or (rownum, colnum) != start: raise ValueError('Shared/array formula or non-anchor merged cell edit requires dedicated handling')
                rows = elements(data, 'row'); row = next((r for r in rows if r.getAttribute('r') == str(rownum)), None)
                if row is None:
                    row = doc.createElementNS(ns, 'row'); row.setAttribute('r', str(rownum))
                    following = next((r for r in rows if int(r.getAttribute('r')) > rownum), None)
                    data.insertBefore(row, following)
                existing = elements(row, 'c'); cell = next((c for c in existing if c.getAttribute('r') == change['cell']), None)
                if cell is None:
                    cell = doc.createElementNS(ns, 'c'); cell.setAttribute('r', change['cell'])
                    following = next((c for c in existing if coordinate(c.getAttribute('r'))[1] > colnum), None)
                    row.insertBefore(cell, following)
                if any(f.getAttribute('t') in ('shared','array','dataTable') for f in elements(cell,'f')): raise ValueError('Complex formula cell edit refused')
                for child in list(cell.childNodes): cell.removeChild(child)
                if cell.hasAttribute('t'): cell.removeAttribute('t')
                value = change['value']
                if isinstance(value, dict):
                    if 'formula' in value:
                        formula = value['formula'].lstrip('=')
                        if not formula: raise ValueError('Empty formula')
                        text(doc, cell, ns, 'f', formula)
                        if 'value' in value:
                            cached = value['value']
                            if isinstance(cached, bool): cell.setAttribute('t','b'); cached = int(cached)
                            elif isinstance(cached, str): cell.setAttribute('t','str')
                            text(doc, cell, ns, 'v', cached)
                        continue
                    if any(k != 'value' for k in value): raise ValueError('Package edit accepts scalar or formula; existing number formats/styles are retained')
                    value = value['value']
                if value is None: continue
                if isinstance(value, bool): cell.setAttribute('t','b'); text(doc,cell,ns,'v',int(value))
                elif isinstance(value, (int,float)): text(doc,cell,ns,'v',value)
                elif isinstance(value, str):
                    cell.setAttribute('t','inlineStr'); container = doc.createElementNS(ns,'is'); cell.appendChild(container)
                    t = text(doc,container,ns,'t',value); t.setAttribute('xml:space','preserve')
                else: raise ValueError('Unsupported value')
            addresses = [coordinate(c.getAttribute('r')) for r in elements(data,'row') for c in elements(r,'c')]
            if addresses:
                def addr(row,col):
                    letters=''
                    while col: col,k=divmod(col-1,26); letters=chr(65+k)+letters
                    return letters+str(row)
                ref=addr(min(a[0] for a in addresses),min(a[1] for a in addresses))+':'+addr(max(a[0] for a in addresses),max(a[1] for a in addresses))
                dims=elements(root,'dimension')
                if dims: dims[0].setAttribute('ref',ref)
            modified[filename] = doc.toxml(encoding='UTF-8')
        # Request recalculation on open while preserving formula/calc-chain package parts.
        calc = next(iter(wb.getElementsByTagName('calcPr')),None)
        if calc is None:
            calc = wb.createElementNS(wb.documentElement.namespaceURI,'calcPr')
            following = next((n for n in wb.documentElement.childNodes if getattr(n,'localName',None) in {'oleSize','customWorkbookViews','pivotCaches','smartTagPr','smartTagTypes','webPublishing','fileRecoveryPr','webPublishObjects','extLst'}),None)
            wb.documentElement.insertBefore(calc,following)
        calc.setAttribute('fullCalcOnLoad','1');calc.setAttribute('forceFullCalc','1')
        modified['xl/workbook.xml'] = wb.toxml(encoding='UTF-8')
        with zipfile.ZipFile(request['output'],'w') as target:
            for info in infos: target.writestr(info, modified.get(info.filename,parts[info.filename]))
        with zipfile.ZipFile(request['output']) as target:
            assert set(target.namelist()) == set(parts)
            preserved = {name: hashlib.sha256(data).hexdigest() for name,data in parts.items() if name not in modified}
            assert all(target.read(name) == parts[name] for name in preserved)
        return {'changedParts':list(modified),'preservedParts':len(preserved),'untouchedPartsByteIdentical':True,'macroExecution':False,'externalLinksUpdated':False}
if __name__ == '__main__':
    try: print(json.dumps(patch(json.load(sys.stdin))))
    except Exception as exc: print(str(exc),file=sys.stderr);sys.exit(1)

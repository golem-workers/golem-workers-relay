import sys,json,zipfile
r=json.load(sys.stdin)
old=b'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml' if r['format']=='xltx' else b'application/vnd.ms-excel.sheet.macroEnabled.main+xml'
new=b'application/vnd.openxmlformats-officedocument.spreadsheetml.template.main+xml' if r['format']=='xltx' else b'application/vnd.ms-excel.template.macroEnabled.main+xml'
with zipfile.ZipFile(r['input']) as a,zipfile.ZipFile(r['output'],'w') as b:
    for info in a.infolist():
        data=a.read(info)
        if info.filename=='[Content_Types].xml':
            if old not in data: raise ValueError('Unexpected workbook content type')
            data=data.replace(old,new)
        b.writestr(info,data)
print(json.dumps({'templateTypeVerified':True}))

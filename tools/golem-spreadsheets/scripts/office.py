#!/usr/bin/env python3
"""Dedicated headless UNO profile; macros and linked-document updates disabled."""
import sys,json,subprocess,tempfile,time,uuid,pathlib
import uno
from com.sun.star.beans import PropertyValue

def prop(name,value):
    p=PropertyValue();p.Name=name;p.Value=value;return p

def run(r):
    formats={'xlsx':'Calc MS Excel 2007 XML','xls':'MS Excel 97','biff8':'MS Excel 97','ods':'calc8','xlsm':'Calc MS Excel 2007 VBA XML','xltx':'Calc MS Excel 2007 XML Template','xltm':'Calc MS Excel 2007 VBA XML Template'}
    with tempfile.TemporaryDirectory(prefix='gw-sheet-office-') as profile:
        pipe='gwsheet'+uuid.uuid4().hex
        proc=subprocess.Popen(['soffice','--headless','--nologo','--nodefault','--nofirststartwizard','--norestore','-env:UserInstallation='+pathlib.Path(profile).as_uri(),'--accept=pipe,name='+pipe+';urp;StarOffice.ComponentContext'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        doc=None
        try:
            local=uno.getComponentContext();resolver=local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver',local)
            deadline=time.monotonic()+30
            while True:
                try: ctx=resolver.resolve('uno:pipe,name='+pipe+';urp;StarOffice.ComponentContext');break
                except Exception:
                    if time.monotonic()>deadline or proc.poll() is not None: raise RuntimeError('LibreOffice startup failed')
                    time.sleep(.2)
            desktop=ctx.ServiceManager.createInstanceWithContext('com.sun.star.frame.Desktop',ctx)
            doc=desktop.loadComponentFromURL(pathlib.Path(r['input']).as_uri(),'_blank',0,(prop('Hidden',True),prop('ReadOnly',False),prop('MacroExecutionMode',uno.getConstantByName('com.sun.star.document.MacroExecMode.NEVER_EXECUTE')),prop('UpdateDocMode',uno.getConstantByName('com.sun.star.document.UpdateDocMode.NO_UPDATE'))))
            if doc is None: raise RuntimeError('LibreOffice could not load workbook')
            for c in r['changes']:
                sheet=doc.Sheets.getByName(c['sheet'])
                if sheet.isProtected(): raise ValueError('Protected sheet; refusing modification')
                cell=sheet.getCellRangeByName(c['cell']);v=c['value']
                if isinstance(v,dict):
                    if 'formula' in v: cell.setFormula('='+v['formula'].lstrip('='));continue
                    v=v['value']
                if v is None: cell.clearContents(1023)
                elif isinstance(v,bool): cell.setFormula('=TRUE()' if v else '=FALSE()')
                elif isinstance(v,(int,float)): cell.setValue(v)
                else: cell.setString(v)
            if r.get('recalculate',True): doc.calculateAll()
            doc.storeAsURL(pathlib.Path(r['output']).as_uri(),(prop('FilterName',formats[r['format']]),prop('Overwrite',False)))
            return {'engine':'libreoffice','formulasRecalculated':r.get('recalculate',True),'macroExecution':False,'externalLinksUpdated':False}
        finally:
            if doc is not None:
                try: doc.close(True)
                except Exception: pass
            proc.terminate()
            try: proc.wait(timeout=5)
            except subprocess.TimeoutExpired: proc.kill();proc.wait()
if __name__=='__main__':
    try: print(json.dumps(run(json.load(sys.stdin))))
    except Exception as exc: print(str(exc),file=sys.stderr);sys.exit(1)

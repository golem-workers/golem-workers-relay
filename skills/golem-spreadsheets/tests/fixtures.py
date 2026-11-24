from pathlib import Path
import sys,json,zipfile
import openpyxl,xlwt
from openpyxl.chart import BarChart,Reference
p=Path(sys.argv[1]);p.mkdir(exist_ok=True)
w=openpyxl.Workbook();s=w.active;s.title='Данные'
s.append(['Item','Qty','Total']);s.append(['Кириллица',13,'=B2*2']);s['A3']='00123';s['B3']=True
s['B2'].number_format='0.00';s['B2'].font=openpyxl.styles.Font(bold=True,color='FF0000')
s.merge_cells('A5:C5');s['A5']='Merged';s.freeze_panes='B2';s.column_dimensions['A'].width=30
chart=BarChart();chart.add_data(Reference(s,min_col=2,min_row=1,max_row=2),titles_from_data=True);s.add_chart(chart,'E2')
s2=w.create_sheet('Hidden');s2['A1']='keep';s2.sheet_state='hidden';w.save(p/'independent.xlsx')
w=xlwt.Workbook();s=w.add_sheet('Data');s.write(0,0,'Кириллица');s.write(0,1,13);s.write(0,2,xlwt.Formula('B1*2'));w.save(str(p/'independent.xls'))

# An OOXML macro container fixture tests opaque binary preservation, not VBA execution.
with zipfile.ZipFile(p/'independent.xlsx') as z, zipfile.ZipFile(p/'opaque-macro.xlsm','w') as out:
    for item in z.infolist():
        data=z.read(item)
        if item.filename=='[Content_Types].xml':
            data=data.replace(b'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',b'application/vnd.ms-excel.sheet.macroEnabled.main+xml').replace(b'</Types>',b'<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>')
        out.writestr(item,data)
    out.writestr('xl/vbaProject.bin',b'OPAQUE-PRESERVATION-FIXTURE-NOT-EXECUTABLE-VBA')

from PIL import Image
Image.new('RGB',(8,8),'blue').save(p/'logo.png')

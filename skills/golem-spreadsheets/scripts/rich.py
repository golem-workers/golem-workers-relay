import sys,json,datetime
import openpyxl
from openpyxl.styles import Font,PatternFill,Alignment,Border,Side
from openpyxl.chart import BarChart,LineChart,Reference
from openpyxl.drawing.image import Image
r=json.load(sys.stdin);w=openpyxl.Workbook();w.remove(w.active)
if r['spec'].get('date1904'): w.epoch=openpyxl.utils.datetime.CALENDAR_MAC_1904
for spec in r['spec']['sheets']:
    s=w.create_sheet(spec['name'])
    def assign(address,value):
        c=s[address]
        if isinstance(value,dict):
            if 'formula' in value: c.value='='+value['formula'].lstrip('=')
            elif 'date' in value:
                c.value=datetime.datetime.fromisoformat(value['date'].replace('Z','+00:00'))
                if c.value.tzinfo is not None: c.value=c.value.astimezone(datetime.timezone.utc).replace(tzinfo=None)
            else: c.value=value['value']
            if 'numberFormat' in value: c.number_format=value['numberFormat']
        else:
            c.value=value
            if isinstance(value,str): c.data_type='s'
    for rownum,row in enumerate(spec.get('rows',[]),1):
        for colnum,value in enumerate(row,1): assign(openpyxl.utils.get_column_letter(colnum)+str(rownum),value)
    for a,v in spec.get('cells',{}).items(): assign(a,v)
    for merge in spec.get('merges',[]): s.merge_cells(merge)
    for i,col in enumerate(spec.get('columns',[]),1):
        if 'wch' in col: s.column_dimensions[openpyxl.utils.get_column_letter(i)].width=col['wch']
    for address,style in spec.get('styles',{}).items():
        c=s[address]
        if 'font' in style: c.font=Font(**style['font'])
        if 'fill' in style: c.fill=PatternFill(**style['fill'])
        if 'alignment' in style: c.alignment=Alignment(**style['alignment'])
        if 'numberFormat' in style: c.number_format=style['numberFormat']
    if 'freeze' in spec: s.freeze_panes=spec['freeze']
    if 'autoFilter' in spec: s.auto_filter.ref=spec['autoFilter']
    for config in spec.get('charts',[]):
        cls={'bar':BarChart,'line':LineChart}[config['type']];chart=cls();chart.title=config.get('title','')
        lo,hi=config['rows'];cols=config['columns'];chart.add_data(Reference(s,min_col=cols[0],max_col=cols[-1],min_row=lo,max_row=hi),titles_from_data=config.get('header',True));s.add_chart(chart,config['anchor'])
    for image in spec.get('images',[]): s.add_image(Image(image['path']),image['anchor'])
w.template=r.get('template',False);w.save(r['output']);print(json.dumps({'richWorkbookCreated':True}))

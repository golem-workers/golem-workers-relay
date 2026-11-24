# Commands and input specifications

All commands emit one JSON object. A failed operation exits nonzero, leaves the input unchanged and does not publish a new output. Existing output files require `--overwrite`; the input may never also be the output. Paths with spaces must be shell-quoted. Keep passwords out of command lines and logs; encrypted files require a separately authorized decryption workflow.

```sh
golem-spreadsheet inspect '/path/input.xls'
golem-spreadsheet read '/path/input.xls' --sheet Data --range A1:F50
golem-spreadsheet create '/path/new.xlsx' --spec '/path/spec.json'
golem-spreadsheet edit '/path/input.xlsx' '/path/edited.xlsx' --changes '/path/changes.json'
golem-spreadsheet convert '/path/input.xlsx' '/path/output.xls' --format biff8 --engine libreoffice --allow-lossy
golem-spreadsheet recalculate '/path/formulas.xlsx' '/path/calculated.xlsx' --allow-lossy
```

Creation specification:

```json
{"sheets":[{"name":"Data","rows":[["Name","Count","Total"],["Склад",13,{"formula":"B2*2","value":26}]],"cells":{"D2":{"date":"2026-11-24","numberFormat":"yyyy-mm-dd"}},"merges":["A4:C4"],"columns":[{"wch":25},{"wch":12}]}]}
```

Cells: strings, finite numbers, booleans, null, or `{ "formula": "SUM(B2:B5)", "value": 42 }`. An explicit cached formula value is optional and is not evidence of calculation. Creating new files also accepts `{ "date": "2026-11-24", "numberFormat": "yyyy-mm-dd" }` and `{ "value": 13, "numberFormat": "0.00" }`. `date1904:true` selects that workbook date system. For exact text IDs pass strings, not numbers. Excel numerical precision is not arbitrary-precision arithmetic.

Changes specification:

```json
[{"sheet":"Data","cell":"B2","value":20},{"sheet":"Data","cell":"C2","value":{"formula":"B2*2"}},{"sheet":"Data","cell":"A3","value":"00123"}]
```

The OOXML package editor accepts scalar/formula changes and preserves each edited cell's existing style index. It does not insert/delete sheets, rows or columns, add formatting, or modify non-anchor merged cells. For new XLSX/XLTX files choose `create OUTPUT --spec SPEC.json --engine openpyxl`. Each sheet can set `styles` (A1 address to font/fill/alignment/numberFormat), `freeze`, `autoFilter`, `charts` and `images`. Chart example: `{"type":"bar","rows":[1,10],"columns":[2],"anchor":"E2","title":"Sales"}`. Image example: `{"path":"/path/image.png","anchor":"H2"}`. Fonts/fills/alignments use openpyxl keyword names. Bar/line charts are supported; macros are not executed. Rich engine formulas have no newly calculated cache; recalculate explicitly if required. Data writer creation supports number formats, column widths and merges, not general visual formatting.

`read` returns both `formula` and cached `value`, `numberFormat`, `formatted` and the workbook date system. Reading a formula without a cache returns null for its cached value. Legacy text files can use explicit `--codepage 1251`; a write is still rejected if the selected writer cannot represent the text. Do not replace characters to make verification pass.

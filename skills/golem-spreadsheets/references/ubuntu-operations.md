# Ubuntu-only operation routing

Complete the user's operation with a suitable Linux engine, not only the common CLI. Check `golem-spreadsheet capabilities` and `/usr/bin/python3 -c 'import openpyxl, uno; from PIL import Image'`. The provisioned stack is SheetJS CE, system Python/openpyxl/Pillow and LibreOffice/UNO. Other Ubuntu-compatible libraries are optional, not preinstalled promises: verify availability, licensing, supported formats and a representative round trip before relying on one. No route requires a Windows machine, Excel/COM or a paid server engine.

## Choose the narrowest adequate route

| Requested operation | Ubuntu route | Required checks / limits |
| --- | --- | --- |
| Inspect, extract cells, formula text and cached results | CLI `inspect` / bounded `read`; Python `csv` for text | Real format, sheet/range, types, date system, leading zeros, missing caches |
| Small OOXML cell changes with valuable existing objects | CLI package editor | Unchanged ZIP parts byte-identical; no structural edits |
| New styled XLSX/XLTX with charts/images | CLI `create --engine openpyxl` | Reopen values/formulas/styles/objects; render if appearance matters |
| Existing OOXML formatting, sheets, rows/columns, merges, comments/hyperlinks, named ranges, print settings | Task-specific `/usr/bin/python3` script using openpyxl | Full rewrite; inventory unsupported objects first; dependency references must be maintained explicitly |
| Tables, filters, conditional formatting, validation, protection settings on authorized editable books | openpyxl APIs (`worksheet.table`, `formatting.rule`, `worksheet.datavalidation`) | Verify saved ranges, rule types and formulas; protection is not encryption |
| Charts/images beyond the CLI's bar/line subset | openpyxl chart/image APIs; UNO when its filters are suitable | Check installed-version API; chart source ranges and objects after save; inspect rendered result |
| Sort, join, clean, deduplicate, aggregate, pivot summaries, report generation | Python standard library; optional pandas/DuckDB for suitable workloads | Preserve identifiers/nulls/types and untouched formulas; check totals and row counts independently. A summary table is not a native Excel pivot object |
| Actual formula recalculation, legacy XLS formula export | CLI LibreOffice route | Calc-supported functions only; compare formula text, check recalculated errors and key expected results |
| Native Calc operations not exposed in CLI | Custom UNO script, based on installed `/opt/golem-spreadsheets/scripts/office.py` lifecycle | Dedicated profile and local pipe, timeouts, cleanup, `NEVER_EXECUTE` macros and `NO_UPDATE` external links; check full rewrite fidelity |
| PDF/print-ready export | Custom UNO script using `calc_pdf_Export` | Set print areas/orientation/scaling; render/inspect pages, counts, fonts, clipped cells and charts; retain source workbook |
| Password-protected/encrypted file with supplied password | Optional compatible Ubuntu decryption library or supported UNO password loading | Never put passwords in arguments/logs; preserve original and distinguish encryption from sheet protection; no universal scheme support |
| Large data extraction/reporting | Bounded CLI reads, openpyxl `read_only` / `write_only`, streaming CSV; optional data engine | CLI caps still apply; streaming paths have fewer object/style capabilities and need explicit resource bounds |

For renames/inserts/deletes/moves, openpyxl does **not** globally fix formula dependencies, charts, names, tables or validations. Work out affected references, update them, and verify them after saving; `move_range(..., translate=True)` is not a workbook-wide dependency repair. If preservation cannot be demonstrated, explain the limit and offer a compatible Ubuntu-produced result without silently discarding objects.

## Task-specific script workflow

1. Inspect the input and read [compatibility](compatibility.md). Record sheets/order/visibility, relevant values and formulas, date system, merges, names, tables, chart/image counts and macro/signature/external-object presence. Use package editing for object-sensitive cell-only changes. Never load `data_only=True` and save it as the formula-bearing replacement.
2. For a full rewrite, state the relevant fidelity trade-off. Use `load_workbook(..., data_only=False, keep_links=True)`; `keep_vba=True` is needed to retain VBA bytes in suitable macro-enabled files but is not a general object-preservation guarantee. Do not generate a new XLSM by merely renaming XLSX, or edit a signed container while claiming its signature remains valid. Follow the same protection policy as the CLI.
3. Write a task-specific script against the installed library version. Use a separate temporary output on the destination filesystem, never overwrite the input or an existing destination. Keep user data as data rather than executable Python, shell or formulas unless formulas were requested.
4. Reopen the temporary workbook and assert requested values, formula text, dimensions/structure/style properties and relevant unchanged data/features. For converted formats use a second suitable reader when feasible. If values depend on calculation, recalculate separately with the guarded LibreOffice route and check errors/expected totals. Rendering is required for claims about layout; data assertions alone are insufficient.
5. Publish only after checks pass, using an exclusive destination or an atomic no-clobber operation. Deliver the actual attachment and a concise report: engine/version, operation, validated facts, calculation status, losses/limits. A custom script's checks are not the CLI's `verified:true` and are not byte-identity proof.

### Executable example: format and extend a simple XLSX

This example applies only to a simple, unprotected, unsigned XLSX without advanced objects. Inspect first. Its assertions cover these specific edits, not arbitrary workbook fidelity. Adapt checks to the real task. Save the code as a script and run `/usr/bin/python3 SCRIPT.py INPUT.xlsx OUTPUT.xlsx`.

```python
from pathlib import Path
from tempfile import TemporaryDirectory
import os
import sys
from openpyxl import load_workbook
from openpyxl.styles import Font
from openpyxl.worksheet.table import Table, TableStyleInfo

source, target = [Path(arg).resolve() for arg in sys.argv[1:3]]
assert source != target and not target.exists(), 'Use a new output path'
book = load_workbook(source, data_only=False, keep_links=True)
assert not book.security.lockStructure
assert all(not sheet.protection.sheet for sheet in book)
assert 'Summary' not in book.sheetnames
before = {sheet.title: {cell.coordinate: cell.value
          for row in sheet for cell in row if cell.value is not None}
          for sheet in book}
original_names = book.sheetnames[:]
original_epoch = book.epoch
summary = book.create_sheet('Summary')
summary.append(['Item', 'Count'])
summary.append(['00123', 20])
summary['A1'].font = Font(bold=True)
summary['A2'].number_format = '@'
summary.freeze_panes = 'A2'
summary.column_dimensions['A'].width = 24
summary.merge_cells('D1:E1')
summary['D1'] = 'Report'
table = Table(displayName='UbuntuSummaryTable', ref='A1:B2')
assert all(table.displayName not in sheet.tables for sheet in book
           if sheet is not summary), 'Choose a unique table name'
table.tableStyleInfo = TableStyleInfo(name='TableStyleMedium2', showRowStripes=True)
summary.add_table(table)
with TemporaryDirectory(prefix='.sheet-', dir=target.parent) as work:
    staged = Path(work) / target.name
    book.save(staged)
    check = load_workbook(staged, data_only=False, keep_links=True)
    assert check.sheetnames == original_names + ['Summary']
    assert check.epoch == original_epoch
    for name, cells in before.items():
        assert {cell.coordinate: cell.value for row in check[name]
                for cell in row if cell.value is not None} == cells
    sheet = check['Summary']
    assert sheet['A2'].value == '00123' and sheet['B2'].value == 20
    assert sheet['A1'].font.bold and sheet['A2'].number_format == '@'
    assert sheet.freeze_panes == 'A2'
    assert 'D1:E1' in sheet.merged_cells
    assert sheet.tables['UbuntuSummaryTable'].ref == 'A1:B2'
    check.close()
    book.close()
    # Same filesystem, no existing-target replacement; unlinking staged is safe.
    os.link(staged, target)
print('Validated: unchanged original cells, date system, sheet order; new styled table')
```

For PDF, extend a custom UNO workflow with `doc.storeToURL(output_url, (prop('FilterName', 'calc_pdf_Export'), prop('Overwrite', False)))`; this is an engine API, not a `golem-spreadsheet` command. Keep the isolation/security/cleanup lifecycle in `office.py`, validate the produced PDF with available PDF tools and visually inspect relevant pages. Do not use a shared desktop profile or enable macros/link refresh for convenience.

## When the requested result is unsupported

Identify the exact boundary: requested format/version, operation, installed engine and observed failure. Offer an Ubuntu alternative that preserves the user's intent where possible (for example XLSX formulas instead of formula-bearing XLSB). Do not silently substitute formats or data-only values. Do not request Windows/Excel access. State limits in the final delivery as well as this skill; do not call the whole task impossible merely because one CLI command lacks the operation.

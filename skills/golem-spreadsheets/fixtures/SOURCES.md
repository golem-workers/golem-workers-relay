# Independent fixtures

Apache POI spreadsheet test-data, Apache License 2.0: https://github.com/apache/poi/tree/trunk/test-data/spreadsheet

- `poi-51519.xlsb`: https://raw.githubusercontent.com/apache/poi/trunk/test-data/spreadsheet/51519.xlsb — SHA-256 `53ebff181db309ae9b602780591836515678db7590aeb59942f9c3348fe61192`
- `poi-Simple.xlsb`: https://raw.githubusercontent.com/apache/poi/trunk/test-data/spreadsheet/Simple.xlsb — SHA-256 `41b0c82bfa682f968d69e05e23137232d6c89ea4f24439786f0b779be319929b`
- `poi-SimpleMacro.xlsm`: https://raw.githubusercontent.com/apache/poi/trunk/test-data/spreadsheet/SimpleMacro.xlsm — SHA-256 `f76c986f4ebc25c2cc57c088b2511a1269f4bd61d6223a2ab58db351da348ba6`
- `poi-SimpleStrict.xlsx`: https://raw.githubusercontent.com/apache/poi/trunk/test-data/spreadsheet/SimpleStrict.xlsx — SHA-256 `dd6d2142e4c440c5cfaa241aa48883bfc0a76742b4531102dd41aea2f7a4d2ad`
- `poi-date.xlsb`: https://raw.githubusercontent.com/apache/poi/trunk/test-data/spreadsheet/date.xlsb — SHA-256 `fbb969989aabed2e057b2ddfc4cfd10ef1f6ebe9b7697c3755283515158d5b09`

`Simple.xlsb` is the retained unsupported Excel 2007 Beta 2 dialect negative fixture. Other independent files exercise real VBA, stable BIFF12 and strict OOXML. Generated openpyxl/xlwt fixtures are separately labelled in tests/fixtures.py; the opaque macro fixture is not executable VBA.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  cp = require("node:child_process");
const { run, load, FORMATS } = require("../scripts/spreadsheet.cjs");
let dir;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-spreadsheet-test-"));
  cp.execFileSync("/usr/bin/python3", [
    path.join(__dirname, "fixtures.py"),
    dir,
  ]);
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = (n) => path.join(dir, n);
function json(n, x) {
  fs.writeFileSync(file(n), JSON.stringify(x));
  return file(n);
}
function create(name, spec, p = []) {
  return run(["create", file(name), "--spec", json("spec.json", spec), ...p]);
}
for (const f of Object.keys(FORMATS))
  test("value round trip: " + f, () => {
    const ext = ["biff2", "biff3", "biff4", "biff5", "biff8"].includes(f)
      ? "xls"
      : f;
    const result = create(
      "round-" + f + "." + ext,
      {
        sheets: [
          {
            name: "Data",
            rows: [
              ["Name", "Count"],
              ["Item", 13],
            ],
          },
        ],
      },
      ["--format", f],
    );
    assert.equal(result.verified, true);
    assert.equal(
      Object.values(run(["read", result.output]).cells).some(
        (x) => x.value === 13,
      ),
      true,
    );
  });
test("Cyrillic and leading-zero identifiers preserved in modern/biff8 files", () => {
  for (const f of ["xlsx", "xlsm", "xlsb", "biff8", "ods", "fods", "xlml"]) {
    const r = create(
      "utf-" + f + "." + (f === "biff8" ? "xls" : f),
      {
        sheets: [
          { name: "Данные", rows: [["Кириллица", "00123", true, 1.25]] },
        ],
      },
      ["--format", f],
    );
    const c = run(["read", r.output]).cells;
    assert.equal(c.A1.value, "Кириллица");
    assert.equal(c.B1.value, "00123");
    assert.equal(c.C1.value, true);
  }
});
test("identify independent BIFF8 by signature, ignoring extension", () => {
  fs.copyFileSync(file("independent.xls"), file("disguised.xlsx"));
  assert.equal(run(["inspect", file("disguised.xlsx")]).format, "biff8");
  assert.equal(
    run(["read", file("disguised.xlsx")]).cells.A1.value,
    "Кириллица",
  );
});
test("OOXML edit preserves untouched charts/styles/macros/hidden sheets and original", () => {
  for (const name of ["independent.xlsx", "opaque-macro.xlsm"]) {
    const original = fs.readFileSync(file(name)),
      output = file("edit-" + name);
    const r = run([
      "edit",
      file(name),
      output,
      "--changes",
      json("changes.json", [
        { sheet: "Данные", cell: "B2", value: 20 },
        { sheet: "Данные", cell: "D4", value: "  <новое> & текст  " },
        { sheet: "Данные", cell: "C2", value: { formula: "B2*3" } },
      ]),
    ]);
    assert.equal(r.untouchedPartsByteIdentical, true);
    assert.deepEqual(fs.readFileSync(file(name)), original);
    assert.equal(run(["read", output, "--sheet", "Данные"]).cells.B2.value, 20);
    assert.equal(run(["read", output]).cells.C2.formula, "B2*3");
    assert.equal(run(["read", output]).cells.D4.value, "  <новое> & текст  ");
    cp.execFileSync("/usr/bin/python3", [
      "-c",
      `import zipfile,sys,openpyxl\na,b=map(zipfile.ZipFile,sys.argv[1:]);\nfor p in a.namelist():\n if p not in ['xl/worksheets/sheet1.xml','xl/workbook.xml']: assert a.read(p)==b.read(p),p\nw=openpyxl.load_workbook(sys.argv[2],keep_vba=sys.argv[2].endswith('.xlsm'));s=w['Данные'];assert s['B2'].font.bold and s['B2'].number_format=='0.00';assert w['Hidden'].sheet_state=='hidden';assert len(s._charts)==1;assert s['C2'].value=='=B2*3'`,
      file(name),
      output,
    ]);
  }
});
test("round-trip failure does not publish corrupt/lossy files", () => {
  for (const f of ["biff2", "biff3", "biff4", "biff5"]) {
    const out = "rejected-" + f + ".xls";
    assert.throws(
      () =>
        create(out, { sheets: [{ name: "Data", rows: [["Кириллица"]] }] }, [
          "--format",
          f,
        ]),
      /Value changed/,
    );
    assert.equal(fs.existsSync(file(out)), false);
  }
  const spec = {
    sheets: [{ name: "Data", cells: { A1: { formula: "1+2", value: 3 } } }],
  };
  assert.throws(() => create("formula.xlsb", spec), /Formula changed/);
  assert.equal(fs.existsSync(file("formula.xlsb")), false);
});
test("refuse original overwrite, implicit binary rewrite, sheet truncation and row overflow", () => {
  const changes = json("change.json", [
    { sheet: "Data", cell: "B1", value: 22 },
  ]);
  assert.throws(
    () =>
      run([
        "edit",
        file("independent.xls"),
        file("independent.xls"),
        "--changes",
        changes,
      ]),
    /original/i,
  );
  assert.throws(
    () =>
      run([
        "edit",
        file("independent.xls"),
        file("refused.xls"),
        "--changes",
        changes,
      ]),
    /rewrites/i,
  );
  assert.throws(
    () =>
      create("overflow.xls", {
        sheets: [{ name: "Data", cells: { A65537: 1 } }],
      }),
    /cannot store/,
  );
  assert.throws(
    () =>
      create("multi.csv", {
        sheets: [
          { name: "One", rows: [[1]] },
          { name: "Two", rows: [[2]] },
        ],
      }),
    /one sheet/,
  );
});
test("bounded range reads and exact text/formula distinction", () => {
  create("bounded.xlsx", {
    sheets: [{ name: "Data", cells: { A1: "=1+2", A2000: 42 } }],
  });
  assert.throws(() => run(["read", file("bounded.xlsx")]), /smaller/);
  const r = run(["read", file("bounded.xlsx"), "--range", "A1:A1"]);
  assert.equal(r.cells.A1.value, "=1+2");
  assert.equal(r.cells.A1.formula, null);
});
test("reject protected and non-anchor merged edits", () => {
  cp.execFileSync("/usr/bin/python3", [
    "-c",
    `import openpyxl,sys\nw=openpyxl.load_workbook(sys.argv[1]);w.active.protection.sheet=True;w.save(sys.argv[2])`,
    file("independent.xlsx"),
    file("protected.xlsx"),
  ]);
  for (const [input, address] of [
    ["protected.xlsx", "B2"],
    ["independent.xlsx", "B5"],
  ]) {
    assert.throws(
      () =>
        run([
          "edit",
          file(input),
          file("no-" + input),
          "--changes",
          json("no.json", [{ sheet: "Данные", cell: address, value: 1 }]),
        ]),
      /Protected|merged/,
    );
  }
});
test("1904 date system preserved", () => {
  const r = create("dates.xlsx", {
    date1904: true,
    sheets: [{ name: "Data", cells: { A1: { date: "2026-11-24" } } }],
  });
  assert.equal(run(["inspect", r.output]).dateSystem, "1904");
  cp.execFileSync("/usr/bin/python3", [
    "-c",
    `import openpyxl,sys\nw=openpyxl.load_workbook(sys.argv[1]);assert w.active['A1'].value.year==2026 and w.active['A1'].value.day==24`,
    r.output,
  ]);
});
test("LibreOffice actually computes formulas and preserves BIFF8 formulas independently", () => {
  create("calc.xlsx", {
    sheets: [{ name: "Data", rows: [[13, { formula: "A1*3" }]] }],
  });
  const r = run([
    "recalculate",
    file("calc.xlsx"),
    file("computed.xlsx"),
    "--allow-lossy",
  ]);
  assert.equal(r.formulasRecalculated, true);
  assert.equal(run(["read", r.output]).cells.B1.value, 39);
  const q = run([
    "convert",
    file("calc.xlsx"),
    file("computed.xls"),
    "--format",
    "biff8",
    "--engine",
    "libreoffice",
    "--allow-lossy",
  ]);
  assert.equal(run(["read", q.output]).cells.B1.formula, "A1*3");
  cp.execFileSync("/usr/bin/python3", [
    "-c",
    `import xlrd,sys\nw=xlrd.open_workbook(sys.argv[1]);assert w.sheet_by_index(0).cell_value(0,1)==39`,
    q.output,
  ]);
});
test("invalid/truncated input returns failure without output", () => {
  fs.writeFileSync(file("bad.xlsx"), Buffer.from([0x50]));
  assert.throws(() => run(["inspect", file("bad.xlsx")]), /truncated/);
});
test("pre-standard XLSB Beta 2 is rejected instead of successful garbled/empty extraction", () => {
  const p = path.join(__dirname, "../fixtures/poi-Simple.xlsb");
  assert.throws(() => run(["inspect", p]), /Invalid decoded sheet/);
  assert.throws(
    () => run(["inspect", p, "--engine", "libreoffice"]),
    /sheet count/,
  );
});
test("stable XLSB fixtures retain exact sheet names and real cell values", () => {
  const p = path.join(__dirname, "../fixtures/poi-51519.xlsb");
  assert.deepEqual(
    run(["inspect", p]).sheets.map((x) => x.name),
    ["Sheet1", "Sheet2", "Sheet3"],
  );
  const data = run(["read", p, "--range", "A1:D18"]);
  assert.equal(Object.keys(data.cells).length, 72);
  const d = run(["read", path.join(__dirname, "../fixtures/poi-date.xlsb")]);
  assert.equal(d.cells.A1.type, "n");
  assert.ok(d.cells.A1.value > 40000);
});
test("independently authored strict OOXML reads exact sheet names", () => {
  const p = path.join(__dirname, "../fixtures/poi-SimpleStrict.xlsx");
  assert.deepEqual(
    run(["inspect", p]).sheets.map((x) => x.name),
    ["Sheet1", "Sheet Number 2"],
  );
});
test("real VBA package survives cell edit without byte changes", () => {
  const input = path.join(__dirname, "../fixtures/poi-SimpleMacro.xlsm");
  const sheet = run(["inspect", input]).sheets[0].name;
  const output = file("real-macro.xlsm");
  const r = run([
    "edit",
    input,
    output,
    "--changes",
    json("real.json", [{ sheet, cell: "A10", value: "Макрос сохранён" }]),
  ]);
  assert.equal(r.untouchedPartsByteIdentical, true);
  cp.execFileSync("/usr/bin/python3", [
    "-c",
    `import zipfile,sys\na,b=map(zipfile.ZipFile,sys.argv[1:]);assert a.read('xl/vbaProject.bin')==b.read('xl/vbaProject.bin')`,
    input,
    output,
  ]);
});

test("rich creation preserves font, number format, chart and literal formula-looking text", () => {
  const result = create(
    "rich.xlsx",
    {
      sheets: [
        {
          name: "Data",
          rows: [
            ["Name", "Qty"],
            ["=literal", 13],
          ],
          styles: {
            B2: { font: { bold: true, color: "FF0000" }, numberFormat: "0.00" },
          },
          images: [{ path: file("logo.png"), anchor: "H2" }],
          freeze: "B2",
          charts: [
            {
              type: "bar",
              rows: [1, 2],
              columns: [2],
              anchor: "E2",
              title: "Inventory",
            },
          ],
        },
      ],
    },
    ["--engine", "openpyxl"],
  );
  assert.equal(run(["read", result.output]).cells.A2.value, "=literal");
  cp.execFileSync("/usr/bin/python3", [
    "-c",
    `import openpyxl,sys
w=openpyxl.load_workbook(sys.argv[1]);s=w['Data'];assert s['B2'].font.bold and s['B2'].number_format=='0.00';assert len(s._charts)==1 and len(s._images)==1;assert s['A2'].data_type=='s'`,
    result.output,
  ]);
});

test("rich specifications cannot be silently downgraded by data writer", () => {
  assert.throws(
    () =>
      create("no-rich.xlsx", {
        sheets: [
          {
            name: "Data",
            rows: [[1]],
            styles: { A1: { font: { bold: true } } },
          },
        ],
      }),
    /openpyxl/,
  );
});
test("installer exposes a working tool and skill in isolated paths without touching the input", () => {
  const root = path.resolve(__dirname, "../../..");
  const runtime = file("runtime with spaces"),
    skills = file("installed skills"),
    bin = file("bin");
  cp.execFileSync(
    "bash",
    [
      path.join(root, "scripts/install-spreadsheet-tools.sh"),
      runtime,
      skills,
      bin,
    ],
    { env: process.env },
  );
  assert.ok(fs.lstatSync(runtime).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(skills, "golem-spreadsheets/SKILL.md")));
  const cli = path.join(bin, "golem-spreadsheet");
  const result = JSON.parse(
    cp.execFileSync(cli, ["inspect", file("independent.xls")], {
      encoding: "utf8",
    }),
  );
  assert.equal(result.format, "biff8");
  assert.equal(result.ok, true);
});
test("1904 numeric date serials are not shifted; timezone ISO dates use UTC", () => {
  const r = create(
    "date-edge.xlsx",
    {
      date1904: true,
      sheets: [
        {
          name: "Data",
          cells: {
            A1: { value: 42, numberFormat: "yyyy-mm-dd" },
            B1: { date: "2026-11-24T01:00:00+05:00" },
          },
        },
      ],
    },
    ["--engine", "openpyxl"],
  );
  const cells = run(["read", r.output]).cells;
  assert.equal(cells.A1.value, 42);
  cp.execFileSync("/usr/bin/python3", [
    "-c",
    `import openpyxl,sys\nw=openpyxl.load_workbook(sys.argv[1]);v=w.active['B1'].value;assert (v.year,v.month,v.day,v.hour)==(2026,11,23,20)`,
    r.output,
  ]);
});
test("shared/array formulas and signed packages cannot be silently modified", () => {
  for (const kind of ["array", "signature"]) {
    const output = file(kind + ".xlsx");
    cp.execFileSync("/usr/bin/python3", [
      "-c",
      `import zipfile,sys\na=zipfile.ZipFile(sys.argv[1]);b=zipfile.ZipFile(sys.argv[2],'w')\nfor item in a.infolist():\n d=a.read(item)\n if item.filename=='xl/worksheets/sheet1.xml' and sys.argv[3]=='array': d=d.replace(b'<f>B2*2</f>',b'<f t="array" ref="C2:C3">B2*2</f>')\n b.writestr(item,d)\nif sys.argv[3]=='signature': b.writestr('_xmlsignatures/sig1.xml',b'test-signature')\nb.close()`,
      file("independent.xlsx"),
      output,
      kind,
    ]);
    assert.throws(
      () =>
        run([
          "edit",
          output,
          file("rejected-" + kind + ".xlsx"),
          "--changes",
          json("guard.json", [
            { sheet: "Данные", cell: kind === "array" ? "C3" : "B2", value: 1 },
          ]),
        ]),
      /formula|Signed/,
    );
  }
});
test("ZIP expansion cap and same-file aliases are rejected before writing", () => {
  const bomb = file("expansion.xlsx");
  cp.execFileSync("/usr/bin/python3", [
    "-c",
    `import zipfile,struct,sys\np=sys.argv[1]\nwith zipfile.ZipFile(p,'w') as z:z.writestr('dummy',b'x')\nb=bytearray(open(p,'rb').read());i=b.index(b'PK\\x01\\x02');struct.pack_into('<I',b,i+24,300*1024*1024);open(p,'wb').write(b)`,
    bomb,
  ]);
  assert.throws(() => run(["inspect", bomb]), /expansion/);
  const alias = file("alias");
  fs.symlinkSync(dir, alias, "dir");
  assert.throws(
    () =>
      run([
        "edit",
        file("independent.xlsx"),
        path.join(alias, "independent.xlsx"),
        "--changes",
        json("alias.json", [{ sheet: "Данные", cell: "B2", value: 1 }]),
        "--overwrite",
      ]),
    /original/i,
  );
});

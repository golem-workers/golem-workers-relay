#!/usr/bin/env node
"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const crypto = require("node:crypto"),
  cp = require("node:child_process");
const X = require("xlsx");
X.set_cptable(require("xlsx/dist/cpexcel.js"));
const FORMATS = {
  xlsx: ["xlsx", 1048576, 16384],
  xlsm: ["xlsm", 1048576, 16384],
  xltx: ["xlsx", 1048576, 16384],
  xltm: ["xlsm", 1048576, 16384],
  xlsb: ["xlsb", 1048576, 16384],
  xls: ["biff8", 65536, 256],
  biff8: ["biff8", 65536, 256],
  biff5: ["biff5", 16384, 256],
  biff4: ["biff4", 16384, 256],
  biff3: ["biff3", 16384, 256],
  biff2: ["biff2", 16384, 256],
  ods: ["ods", 1048576, 16384],
  fods: ["fods", 1048576, 16384],
  xlml: ["xlml", 65536, 256],
  csv: ["csv", 1048576, 16384],
  tsv: ["csv", 1048576, 16384],
  txt: ["txt", 1048576, 16384],
  html: ["html", 1048576, 16384],
};
const SINGLE = new Set([
  "biff2",
  "biff3",
  "biff4",
  "csv",
  "tsv",
  "txt",
  "html",
]);
function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  throw e;
}
function args(argv) {
  const p = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) p._.push(a);
    else if (["--allow-lossy", "--overwrite"].includes(a)) p[a.slice(2)] = true;
    else {
      if (!argv[i + 1] || argv[i + 1].startsWith("--"))
        fail("ARGUMENT", "Missing value for " + a);
      p[a.slice(2)] = argv[++i];
    }
  }
  const allowed = [
    "sheet",
    "range",
    "max-rows",
    "format",
    "spec",
    "changes",
    "engine",
    "allow-lossy",
    "overwrite",
    "codepage",
  ];
  for (const k of Object.keys(p))
    if (k !== "_" && !allowed.includes(k))
      fail("ARGUMENT", "Unknown option --" + k);
  return p;
}
function load(file, p = {}) {
  const b = fs.readFileSync(file);
  if (b.length > 100 * 1024 * 1024) fail("SIZE_LIMIT", "Input exceeds 100 MiB");
  if (b.length < 2) fail("NOT_WORKBOOK", "Input is empty or truncated");
  let archiveInfo = null;
  if (b.subarray(0, 2).toString() === "PK")
    archiveInfo = python("archive-check.py", { input: path.resolve(file) });
  let w;
  try {
    w = X.read(b, {
      type: "buffer",
      cellFormula: true,
      sheetStubs: true,
      cellNF: true,
      cellStyles: true,
      bookVBA: true,
      bookFiles: true,
      codepage: Number(p.codepage || 1252),
    });
  } catch (e) {
    fail("READ_FAILED", e.message);
  }
  if (w.SheetNames?.some((n) => n.length > 31 || /[\x00-\x1f]/.test(n)))
    fail(
      "PARSER_FIDELITY",
      "Invalid decoded sheet names; unsupported binary dialect, not a successful read",
    );
  if (!w.SheetNames?.length) fail("NOT_WORKBOOK", "No worksheets found");
  let format = archiveInfo?.workbookFormat || w.bookType;
  if (b.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"))) {
    const c = X.CFB.read(b, { type: "buffer" });
    const entry = c.FileIndex.find((v) =>
      ["Workbook", "Book"].includes(v.name),
    );
    if (!entry)
      fail(
        "ENCRYPTED_OR_UNSUPPORTED",
        "No BIFF workbook stream; encrypted OOXML needs decryption first",
      );
    const ver = entry.content.readUInt16LE(4);
    format = ver === 0x500 ? "biff5" : "biff8";
  } else if ([9, 0x209, 0x409].includes(b.readUInt16LE(0)))
    format = { 9: "biff2", 521: "biff3", 1033: "biff4" }[b.readUInt16LE(0)];
  if (!format) format = "delimited-text";
  return { w, b, format };
}
function cells(ws) {
  return Object.keys(ws).filter((k) => /^[A-Z]+[1-9][0-9]*$/.test(k));
}
function details(w, format) {
  return {
    format,
    dateSystem: w.Workbook?.WBProps?.date1904 ? "1904" : "1900",
    macros: !!w.vbaraw,
    sheets: w.SheetNames.map((name) => ({
      name,
      range: w.Sheets[name]["!ref"] || null,
      cells: cells(w.Sheets[name]).length,
      formulas: cells(w.Sheets[name]).filter((a) => w.Sheets[name][a].f).length,
      merges: w.Sheets[name]["!merges"] || [],
      hidden: w.Workbook?.Sheets?.find((s) => s.name === name)?.Hidden || 0,
    })),
    fidelity:
      "Inspection is data-oriented. Use package editing for OOXML preservation; binary/data rewrites are not lossless.",
  };
}
function checkedFormat(output, p) {
  const f = (p.format || path.extname(output).slice(1)).toLowerCase();
  if (!FORMATS[f])
    fail("FORMAT", "Choose --format from " + Object.keys(FORMATS).join(", "));
  return f;
}
function limits(w, f) {
  if (SINGLE.has(f) && w.SheetNames.length !== 1)
    fail(
      "SHEET_LIMIT",
      f + " stores one sheet; select/export sheets explicitly",
    );
  const [, rows, cols] = FORMATS[f];
  for (const name of w.SheetNames)
    for (const a of cells(w.Sheets[name])) {
      const c = X.utils.decode_cell(a);
      if (c.r >= rows || c.c >= cols)
        fail("RANGE_LIMIT", f + " cannot store " + name + "!" + a);
    }
}
function verify(expected, actual, f) {
  if (expected.SheetNames.length !== actual.SheetNames.length)
    fail("VERIFY_FAILED", "Sheet count changed");
  for (let i = 0; i < expected.SheetNames.length; i++) {
    const name = expected.SheetNames[i],
      a = expected.Sheets[name],
      b = actual.Sheets[actual.SheetNames[i]];
    if (!SINGLE.has(f) && actual.SheetNames[i] !== name)
      fail("VERIFY_FAILED", "Sheet name changed");
    const addresses = new Set([...cells(a), ...cells(b)]);
    for (const addr of addresses) {
      const x = a[addr],
        y = b[addr];
      if (x?.v == null && !x?.f && y?.v == null && !y?.f) continue;
      if (x?.f !== y?.f)
        fail(
          "FORMULA_LOSS",
          "Formula changed at " +
            name +
            "!" +
            addr +
            "; choose an engine/format that preserves it",
        );
      if (x?.f) continue;
      const sameDate =
        typeof x?.v === "number" &&
        typeof y?.v === "number" &&
        X.SSF.is_date(x.z || "") &&
        Math.abs(x.v - y.v) <= 0.5 / 86400000;
      if (x?.v !== y?.v && !sameDate)
        fail(
          "VALUE_LOSS",
          "Value changed at " +
            name +
            "!" +
            addr +
            "; encoding/type not representable by selected writer",
        );
    }
  }
}
function publish(file, buffer, overwrite) {
  const dest = path.resolve(file);
  if (!fs.existsSync(path.dirname(dest)))
    fail("OUTPUT_DIRECTORY", "Output directory does not exist");
  const tmp = path.join(
    path.dirname(dest),
    "." + path.basename(dest) + "." + crypto.randomUUID() + ".tmp",
  );
  try {
    fs.writeFileSync(tmp, buffer, { flag: "wx", mode: 0o600 });
    if (overwrite) fs.renameSync(tmp, dest);
    else {
      fs.linkSync(tmp, dest);
      fs.unlinkSync(tmp);
    }
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
  return {
    output: dest,
    bytes: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    verified: true,
  };
}
function cell(value) {
  if (value === null) return { t: "z" };
  if (typeof value === "object" && !Array.isArray(value)) {
    if (value.formula != null) {
      if (
        typeof value.formula !== "string" ||
        !value.formula.replace(/^=/, "").trim()
      )
        fail("SPEC", "formula must be a string");
      return {
        t: "n",
        f: value.formula.replace(/^=/, ""),
        ...(value.value === undefined ? {} : { v: value.value }),
      };
    }
    if (value.date) {
      const d = new Date(value.date);
      if (!Number.isFinite(+d)) fail("SPEC", "Invalid ISO date");
      return {
        t: "n",
        v: (+d - Date.UTC(1899, 11, 30)) / 86400000,
        z: value.numberFormat || "yyyy-mm-dd",
        _gwDate: true,
      };
    }
    if ("value" in value) {
      const c = cell(value.value);
      if (value.numberFormat) c.z = value.numberFormat;
      return c;
    }
    fail("SPEC", "Unsupported cell object");
  }
  if (
    !["number", "string", "boolean"].includes(typeof value) ||
    (typeof value === "number" && !Number.isFinite(value))
  )
    fail(
      "SPEC",
      "Cells must be finite numbers, strings, booleans, null or typed objects",
    );
  return {
    t: typeof value === "number" ? "n" : typeof value === "boolean" ? "b" : "s",
    v: value,
  };
}
function set(ws, address, value) {
  if (!/^[A-Z]{1,3}[1-9][0-9]*$/.test(address))
    fail("CELL", "Invalid A1 address: " + address);
  const c = X.utils.decode_cell(address);
  if (c.r >= 1048576 || c.c >= 16384)
    fail("CELL", "Address exceeds Excel limits");
  ws[address] = cell(value);
  const r = ws["!ref"] ? X.utils.decode_range(ws["!ref"]) : { s: c, e: c };
  r.s.r = Math.min(r.s.r, c.r);
  r.s.c = Math.min(r.s.c, c.c);
  r.e.r = Math.max(r.e.r, c.r);
  r.e.c = Math.max(r.e.c, c.c);
  ws["!ref"] = X.utils.encode_range(r);
}
function make(spec) {
  if (!Array.isArray(spec.sheets) || !spec.sheets.length)
    fail("SPEC", "spec.sheets is required");
  const w = X.utils.book_new();
  for (const s of spec.sheets) {
    const ws = {};
    if (s.rows) {
      if (!Array.isArray(s.rows)) fail("SPEC", "rows must be arrays");
      s.rows.forEach((row, r) => {
        if (!Array.isArray(row)) fail("SPEC", "rows must be arrays");
        row.forEach((v, c) => set(ws, X.utils.encode_cell({ r, c }), v));
      });
    }
    for (const [a, v] of Object.entries(s.cells || {})) set(ws, a, v);
    if (s.merges) ws["!merges"] = s.merges.map(X.utils.decode_range);
    if (s.columns) ws["!cols"] = s.columns;
    X.utils.book_append_sheet(w, ws, s.name);
  }
  if (spec.date1904) {
    w.Workbook = { WBProps: { date1904: true } };
    for (const n of w.SheetNames)
      for (const a of cells(w.Sheets[n])) {
        const c = w.Sheets[n][a];
        if (c._gwDate) c.v -= 1462;
      }
  }
  return w;
}
function write(w, output, p) {
  const f = checkedFormat(output, p);
  limits(w, f);
  let b = X.write(w, {
    type: "buffer",
    bookType: FORMATS[f][0],
    bookSST: false,
    cellStyles: true,
    codepage: Number(p.codepage || 1252),
    FS: f === "tsv" ? "\t" : ",",
  });
  if (["xltx", "xltm"].includes(f)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-template-"));
    try {
      const input = path.join(dir, "input.zip"),
        output = path.join(dir, "output.zip");
      fs.writeFileSync(input, b);
      python("template.py", { input, output, format: f });
      b = fs.readFileSync(output);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const r = X.read(b, {
    type: "buffer",
    cellFormula: true,
    sheetStubs: true,
    codepage: Number(p.codepage || 1252),
  });
  verify(w, r, f);
  return {
    ...publish(output, b, p.overwrite),
    format: f,
    formulasRecalculated: false,
  };
}
function python(script, request) {
  const r = cp.spawnSync("/usr/bin/python3", [path.join(__dirname, script)], {
    input: JSON.stringify(request),
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0)
    fail(
      "ENGINE_FAILED",
      (
        r.stderr ||
        r.stdout ||
        r.error?.message ||
        "Python engine failed"
      ).trim(),
    );
  return JSON.parse(r.stdout);
}
function selfCheck() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-sheet-selfcheck-"));
  try {
    const spec = path.join(dir, "spec.json");
    fs.writeFileSync(spec, JSON.stringify({sheets: [{name: "Данные", rows: [["Код", "Количество", "Итого"], ["00123", 2, {formula: "B2*3"}]], styles: {A1: {font: {bold: true}}}}]}));
    const created = path.join(dir, "created.xlsx");
    run(["create", created, "--spec", spec, "--engine", "openpyxl"]);
    const changes = path.join(dir, "changes.json");
    fs.writeFileSync(changes, JSON.stringify([{sheet: "Данные", cell: "B2", value: 4}]));
    const edited = path.join(dir, "edited.xlsx");
    run(["edit", created, edited, "--changes", changes]);
    const calculated = path.join(dir, "calculated.xlsx");
    run(["recalculate", edited, calculated, "--allow-lossy"]);
    const cells = run(["read", calculated]).cells;
    if (cells.A2.value !== "00123" || cells.B2.value !== 4 || cells.C2.value !== 12 || cells.C2.formula !== "B2*3")
      fail("RUNTIME_SELF_CHECK", "Spreadsheet runtime round trip or recalculation failed");
    return {runtimeContract: 1, verified: true, checks: ["openpyxl-create", "ooxml-edit", "libreoffice-uno-recalculate", "sheetjs-read", "unicode-and-leading-zeros"], formulasRecalculated: true};
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}
function run(argv) {
  const p = args(argv),
    [cmd, input, output] = p._;
  if (cmd === "self-check") return selfCheck();
  if (cmd === "capabilities")
    return {
      runtimeContract: 1,
      engine: "SheetJS " + X.version,
      formats: FORMATS,
      packageEdit: ["xlsx", "xlsm", "xltx", "xltm"],
      libreOffice:
        cp
          .spawnSync("soffice", ["--version"], { encoding: "utf8" })
          .stdout?.trim() || null,
      formulaEvaluation:
        "LibreOffice only, explicit recalculate; SheetJS does not evaluate formulas",
      nativeExcel: null,
    };
  if (!input)
    fail(
      "USAGE",
      "Commands: self-check | capabilities | inspect FILE | read FILE [--sheet NAME --range A1:D10] | create OUTPUT --spec JSON | edit INPUT OUTPUT --changes JSON | convert INPUT OUTPUT --format FORMAT --allow-lossy | recalculate INPUT OUTPUT --allow-lossy",
    );
  if (cmd === "create") {
    if (!p.spec) fail("ARGUMENT", "--spec is required");
    const spec = JSON.parse(fs.readFileSync(p.spec, "utf8"));
    if (
      p.engine !== "openpyxl" &&
      spec.sheets?.some(
        (s) => s.styles || s.charts || s.images || s.freeze || s.autoFilter,
      )
    )
      fail(
        "RICH_ENGINE_REQUIRED",
        "Rich workbook specification requires --engine openpyxl",
      );
    if (p.engine === "openpyxl") {
      const f = checkedFormat(input, p);
      if (!["xlsx", "xltx"].includes(f))
        fail("ENGINE_FORMAT", "Rich creation supports xlsx/xltx");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-rich-"));
      try {
        const tmp = path.join(dir, "output." + f);
        python("rich.py", { output: tmp, spec, template: f === "xltx" });
        verify(make(spec), load(tmp).w, f);
        return {
          ...publish(input, fs.readFileSync(tmp), p.overwrite),
          engine: "openpyxl",
          formulasRecalculated: false,
        };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    return write(make(spec), input, p);
  }
  if (["read", "inspect"].includes(cmd) && p.engine === "libreoffice") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-sheet-read-"));
    try {
      const original = X.read(fs.readFileSync(input), {
        type: "buffer",
        bookSheets: true,
      });
      const converted = path.join(dir, "read.xlsx");
      python("office.py", {
        input: path.resolve(input),
        output: converted,
        format: "xlsx",
        changes: [],
        recalculate: false,
      });
      const projection = load(converted);
      if (projection.w.SheetNames.length !== original.SheetNames.length)
        fail("PROJECTION_LOSS", "LibreOffice read changed the sheet count");
      const next = argv.filter(
        (x, i) => x !== "--engine" && argv[i - 1] !== "--engine",
      );
      next[next.indexOf(input)] = converted;
      return {
        ...run(next),
        readEngine: "libreoffice",
        fidelity: "Read-only projection; original file unchanged",
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const { w, b, format } = load(input, p);
  if (cmd === "inspect") return details(w, format);
  if (cmd === "read") {
    const name = p.sheet || w.SheetNames[0];
    if (!w.Sheets[name]) fail("SHEET", "Unknown sheet " + name);
    const ws = w.Sheets[name],
      range = X.utils.decode_range(p.range || ws["!ref"] || "A1");
    const max = Number(p["max-rows"] || 1000);
    if (!Number.isSafeInteger(max) || max < 1 || max > 100000)
      fail("ARGUMENT", "max-rows must be 1..100000");
    if (range.e.r - range.s.r + 1 > max)
      fail("OUTPUT_LIMIT", "Select a smaller --range or raise --max-rows");
    const result = {};
    for (const a of cells(ws)) {
      const c = X.utils.decode_cell(a);
      if (
        c.r >= range.s.r &&
        c.r <= range.e.r &&
        c.c >= range.s.c &&
        c.c <= range.e.c
      ) {
        const v = ws[a];
        result[a] = {
          type: v.t,
          value: v.t === "z" ? null : (v.v ?? null),
          formula: v.f ?? null,
          numberFormat: v.z ?? null,
          formatted: v.w ?? null,
        };
      }
    }
    return {
      sheet: name,
      range: X.utils.encode_range(range),
      dateSystem: w.Workbook?.WBProps?.date1904 ? "1904" : "1900",
      cells: result,
    };
  }
  if (!output) fail("ARGUMENT", "An output path is required");
  if (
    fs.realpathSync(input) ===
    (fs.existsSync(output)
      ? fs.realpathSync(output)
      : path.join(
          fs.realpathSync(path.dirname(path.resolve(output))),
          path.basename(output),
        ))
  )
    fail(
      "ORIGINAL_PROTECTED",
      "Use a separate output file, never overwrite the original",
    );
  if (fs.existsSync(output) && !p.overwrite)
    fail(
      "OUTPUT_EXISTS",
      "Output exists; use a new name or explicit --overwrite",
    );
  if (cmd === "edit") {
    if (!p.changes) fail("ARGUMENT", "--changes is required");
    const changes = JSON.parse(fs.readFileSync(p.changes, "utf8"));
    if (!Array.isArray(changes) || !changes.length)
      fail("SPEC", "Changes must be a non-empty array");
    for (const c of changes) {
      if (!w.Sheets[c.sheet]) fail("SHEET", "Unknown sheet " + c.sheet);
      set(w.Sheets[c.sheet], c.cell, c.value);
    }
    if (
      ["xlsx", "xlsm", "xltx", "xltm"].includes(format) &&
      (!p.engine || p.engine === "package")
    ) {
      if ("." + format !== path.extname(output).toLowerCase())
        fail(
          "FORMAT",
          "Package editing preserves input format; keep the extension",
        );
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-sheet-"));
      try {
        const tmp = path.join(dir, "patched.xlsx");
        const evidence = python("ooxml.py", {
          input: path.resolve(input),
          output: tmp,
          changes,
        });
        const data = fs.readFileSync(tmp);
        verify(
          w,
          X.read(data, { type: "buffer", cellFormula: true, sheetStubs: true }),
          "xlsx",
        );
        return {
          ...publish(output, data, p.overwrite),
          engine: "ooxml-package",
          ...evidence,
          formulasRecalculated: false,
        };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    if (!p["allow-lossy"])
      fail(
        "FIDELITY_ACK_REQUIRED",
        "Binary/data rewrites may change formatting, charts or macros; use explicit --allow-lossy or OOXML package editing",
      );
    if (p.engine === "libreoffice") return office(input, output, p, changes);
    if (p.engine && p.engine !== "data")
      fail("ENGINE", "Engine must be package, data or libreoffice");
    return {
      ...write(w, output, { ...p, format: p.format || format }),
      fidelity: "data-only rewrite; unsupported workbook features may be lost",
    };
  }
  if (cmd === "convert") {
    if (!p["allow-lossy"])
      fail(
        "FIDELITY_ACK_REQUIRED",
        "Conversion can change unsupported workbook features; require --allow-lossy after inspecting input",
      );
    if (p.engine === "libreoffice") return office(input, output, p, []);
    return {
      ...write(w, output, p),
      fidelity: "data conversion; unsupported workbook features may be lost",
    };
  }
  if (cmd === "recalculate") {
    if (!p["allow-lossy"])
      fail(
        "FIDELITY_ACK_REQUIRED",
        "LibreOffice rewrites the workbook; explicit --allow-lossy required",
      );
    return office(input, output, p, []);
  }
  fail("USAGE", "Unknown command " + cmd);
}
function office(input, output, p, changes) {
  const format = checkedFormat(output, p);
  if (!["xlsx", "xls", "biff8", "ods", "xlsm", "xltx", "xltm"].includes(format))
    fail(
      "ENGINE_FORMAT",
      "LibreOffice output supports xlsx/xls/biff8/ods/xlsm/xltx/xltm, not " +
        format,
    );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-office-"));
  try {
    const file = path.join(
      dir,
      "output." + (format === "biff8" ? "xls" : format),
    );
    const result = python("office.py", {
      input: path.resolve(input),
      output: file,
      format,
      changes,
    });
    const before = load(input, p).w;
    for (const c of changes) set(before.Sheets[c.sheet], c.cell, c.value);
    verify(before, load(file, p).w, format);
    return {
      ...publish(output, fs.readFileSync(file), p.overwrite),
      ...result,
      fidelity:
        "LibreOffice rewrite; visual/advanced feature fidelity requires separate review",
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
if (require.main === module) {
  try {
    console.log(JSON.stringify({ ok: true, ...run(process.argv.slice(2)) }));
  } catch (e) {
    console.error(
      JSON.stringify({ ok: false, code: e.code || "ERROR", error: e.message }),
    );
    process.exitCode = 1;
  }
}
module.exports = { run, make, write, load, verify, FORMATS };



/**
 * Tests du chantier « documents pro » : src/office.ts écrit de vrais
 * fichiers ZIP/XML (docx, xlsx, pptx) et PDF, sans aucune dépendance.
 * Le mini-lecteur ZIP ci-dessous vérifie les octets réels : EOCD,
 * répertoire central, en-têtes locaux, puis inflate de chaque partie.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const { writeDocx, writePdf, writePptx, writeXlsx, colName } = require("../dist/office");
const { documentTool, runDocument } = require("../dist/tools/office");
const { buildToolSpecs } = require("../dist/tools");

function tmpWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "smol-office-"));
}

function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, "end of central directory present");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const files = {};
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, "central directory header signature");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    assert.equal(buf.readUInt32LE(localOffset), 0x04034b50, "local header signature for " + name);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    files[name] = method === 0 ? raw : zlib.inflateRawSync(raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function text(zip, name) {
  assert.ok(zip[name], "part present: " + name);
  return zip[name].toString("utf8");
}

test("xlsx: real workbook with bold header row, inline strings and numbers", () => {
  const root = tmpWorkspace();
  writeXlsx(path.join(root, "budget.xlsx"), [
    { name: "2026", rows: [["Date", "Montant"], ["01/01", 120], ["02/01", 80.5]] },
  ]);
  const zip = readZip(fs.readFileSync(path.join(root, "budget.xlsx")));
  assert.ok(zip["[Content_Types].xml"], "[Content_Types].xml present");
  assert.ok(zip["_rels/.rels"], "_rels/.rels present");
  const sheet = text(zip, "xl/worksheets/sheet1.xml");
  assert.match(sheet, /inlineStr/);
  assert.match(sheet, /<t[^>]*>Date<\/t>/);
  assert.match(sheet, /<v>120<\/v>/);
  assert.match(sheet, /s="1"/, "first row styled bold via s=1");
  const styles = text(zip, "xl/styles.xml");
  assert.match(styles, /<b\/>/);
  const workbook = text(zip, "xl/workbook.xml");
  assert.match(workbook, /name="2026"/);
});

test("docx: title, headings, bullets and a bordered table", () => {
  const root = tmpWorkspace();
  writeDocx(path.join(root, "rapport.docx"), "Rapport annuel", [
    { heading: "Contexte", text: "Première ligne.", bullets: ["un", "deux"] },
    { subheading: "Détails", table: [["A", "B"], [1, 2]] },
  ]);
  const zip = readZip(fs.readFileSync(path.join(root, "rapport.docx")));
  const doc = text(zip, "word/document.xml");
  assert.match(doc, /Rapport annuel/);
  assert.match(doc, /Contexte/);
  assert.match(doc, /• un/);
  assert.match(doc, /tblBorders/);
  assert.match(doc, /sectPr/);
  assert.match(text(zip, "word/styles.xml"), /Heading1/);
});

test("pptx: one slide per entry with a real theme", () => {
  const root = tmpWorkspace();
  writePptx(path.join(root, "pitch.pptx"), [
    { title: "Idée", bullets: ["rapide", "simple"] },
    { title: "Plan" },
  ]);
  const zip = readZip(fs.readFileSync(path.join(root, "pitch.pptx")));
  assert.ok(zip["ppt/slides/slide1.xml"] && zip["ppt/slides/slide2.xml"]);
  assert.match(text(zip, "ppt/slides/slide1.xml"), /Idée/);
  assert.match(text(zip, "ppt/slides/slide1.xml"), /rapide/);
  const presentation = text(zip, "ppt/presentation.xml");
  assert.match(presentation, /9144000/);
  const types = text(zip, "[Content_Types].xml");
  assert.match(types, /slide2\.xml/);
});

test("pdf: minimal valid file with xref and EOF", () => {
  const root = tmpWorkspace();
  writePdf(path.join(root, "notes.pdf"), "Notes", ["Première ligne", "Deuxième ligne"]);
  const raw = fs.readFileSync(path.join(root, "notes.pdf")).toString("latin1");
  assert.match(raw, /^%PDF-1\.4/);
  assert.match(raw, /\(Notes\)/);
  assert.match(raw, /xref/);
  assert.match(raw, /%%EOF\n?$/);
  assert.match(raw, /startxref/);
});

test("runDocument writes the file, adds the extension and summarizes", () => {
  const root = tmpWorkspace();
  const ok = runDocument(root, {
    format: "xlsx",
    path: "budget",
    sheets: [{ name: "2026", rows: [["Date", "Montant"], ["01/01", 120]] }],
  });
  assert.match(ok, /Document créé : budget\.xlsx/);
  assert.match(ok, /1 feuille\(s\), 2 ligne\(s\)/);
  assert.ok(fs.existsSync(path.join(root, "budget.xlsx")));

  const docx = runDocument(root, { format: "docx", path: "lettre.docx", title: "Lettre", blocks: [{ text: "Bonjour" }] });
  assert.match(docx, /Document créé : lettre\.docx/);
  assert.match(docx, /1 bloc\(s\)/);

  const pptx = runDocument(root, { format: "pptx", path: "pitch.pptx", slides: [{ title: "Un" }, { title: "Deux" }] });
  assert.match(pptx, /2 diapositive\(s\)/);

  const pdf = runDocument(root, { format: "pdf", path: "notes.pdf", lines: ["une", "deux", "trois"] });
  assert.match(pdf, /3 ligne\(s\)/);
});

test("runDocument refuses bad input and stays inside the workspace", () => {
  const root = tmpWorkspace();
  assert.match(runDocument(root, { format: "odt", path: "x.odt" }), /format requis/);
  assert.match(runDocument(root, { format: "xlsx" }), /path requis/);
  assert.match(runDocument(root, { format: "xlsx", path: "vide.xlsx" }), /sheets requis/);
  assert.match(runDocument(root, { format: "docx", path: "vide.docx" }), /blocks \(ou title\) requis/);
  assert.match(runDocument(root, { format: "pptx", path: "vide.pptx" }), /slides requis/);
  assert.match(runDocument(root, { format: "pdf", path: "vide.pdf" }), /lines \(ou title\) requis/);
  assert.match(runDocument(root, { format: "pdf", path: "../evade.pdf", title: "X" }), /^Error: /);
  assert.match(
    runDocument(root, { format: "xlsx", path: "gros.xlsx", sheets: [{ rows: Array.from({ length: 5001 }, () => ["x"]) }] }),
    /trop de lignes/
  );
});

test("the document tool is offered in editing modes and hidden in read-only", () => {
  const spec = documentTool();
  assert.equal(spec.name, "document");
  const ro = buildToolSpecs("ro").map((s) => s.name);
  const edit = buildToolSpecs("edit").map((s) => s.name);
  assert.ok(!ro.includes("document"), "hidden in read-only");
  assert.ok(edit.includes("document"), "offered in edit mode");
  assert.equal(colName(0), "A");
  assert.equal(colName(25), "Z");
  assert.equal(colName(26), "AA");
});

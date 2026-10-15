/**
 * Générateurs de documents sans dépendance : .xlsx, .docx et .pptx sont des
 * archives ZIP de XML — un écrivain ZIP minimal (deflate via zlib) suffit —
 * et un PDF texte se construit directement en écrivant les objets PDF 1.4.
 * Aucune installation, aucun paquet npm : les fichiers s'ouvrent dans Word,
 * Excel, PowerPoint et n'importe quel lecteur PDF.
 */

import * as fs from "node:fs";
import * as zlib from "node:zlib";

/* ------------------------------------------------------------------ ZIP -- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** Horodatage DOS fixe (2026-01-01 00:00) : des archives reproductibles. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

interface ZipEntry {
  name: string;
  data: Buffer;
  compressed: Buffer;
  crc: number;
  offset: number;
}

class ZipWriter {
  private entries: ZipEntry[] = [];

  add(name: string, content: string | Buffer): void {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const compressed = zlib.deflateRawSync(data);
    this.entries.push({ name, data, compressed, crc: crc32(data), offset: 0 });
  }

  build(): Buffer {
    const parts: Buffer[] = [];
    let offset = 0;
    for (const entry of this.entries) {
      entry.offset = offset;
      const name = Buffer.from(entry.name, "utf8");
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x0800, 6);
      header.writeUInt16LE(8, 8);
      header.writeUInt16LE(DOS_TIME, 10);
      header.writeUInt16LE(DOS_DATE, 12);
      header.writeUInt32LE(entry.crc, 14);
      header.writeUInt32LE(entry.compressed.length, 18);
      header.writeUInt32LE(entry.data.length, 22);
      header.writeUInt16LE(name.length, 26);
      header.writeUInt16LE(0, 28);
      parts.push(header, name, entry.compressed);
      offset += 30 + name.length + entry.compressed.length;
    }
    const centralStart = offset;
    for (const entry of this.entries) {
      const name = Buffer.from(entry.name, "utf8");
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt16LE(0x0800, 8);
      central.writeUInt16LE(8, 10);
      central.writeUInt16LE(DOS_TIME, 12);
      central.writeUInt16LE(DOS_DATE, 14);
      central.writeUInt32LE(entry.crc, 16);
      central.writeUInt32LE(entry.compressed.length, 20);
      central.writeUInt32LE(entry.data.length, 24);
      central.writeUInt16LE(name.length, 28);
      central.writeUInt32LE(entry.offset, 42);
      parts.push(central, name);
      offset += 46 + name.length;
    }
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(offset - centralStart, 12);
    eocd.writeUInt32LE(centralStart, 16);
    parts.push(eocd);
    return Buffer.concat(parts);
  }
}

/* ------------------------------------------------------------------ XML -- */

function xml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function colName(index: number): string {
  let name = "";
  let n = index;
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

const WORD_HEADER =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/* ----------------------------------------------------------------- XLSX -- */

export interface XlsxSheet {
  name?: string;
  rows: (string | number | null | undefined)[][];
}

function xlsxSheetXml(sheet: XlsxSheet): string {
  const lines: string[] = [];
  sheet.rows.forEach((row, r) => {
    const cells: string[] = [];
    row.forEach((value, c) => {
      if (value === null || value === undefined || value === "") return;
      const ref = `${colName(c)}${r + 1}`;
      const style = r === 0 ? ' s="1"' : "";
      if (typeof value === "number" && Number.isFinite(value)) {
        cells.push(`<c r="${ref}"${style}><v>${value}</v></c>`);
      } else {
        cells.push(`<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(String(value))}</t></is></c>`);
      }
    });
    lines.push(`<row r="${r + 1}">${cells.join("")}</row>`);
  });
  return `${WORD_HEADER}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${lines.join("")}</sheetData></worksheet>`;
}

const XLSX_STYLES = `${WORD_HEADER}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;

/** Écrit un classeur .xlsx (une feuille par entrée, première ligne en gras). */
export function writeXlsx(absPath: string, sheets: XlsxSheet[]): void {
  const zip = new ZipWriter();
  const count = sheets.length;
  const overrides = sheets
    .map(
      (_sheet, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
    .join("");
  zip.add(
    "[Content_Types].xml",
    `${WORD_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides}</Types>`
  );
  zip.add(
    "_rels/.rels",
    `${WORD_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
  );
  const sheetTags = sheets
    .map((sheet, i) => `<sheet name="${xml((sheet.name ?? `Feuille${i + 1}`).slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("");
  zip.add(
    "xl/workbook.xml",
    `${WORD_HEADER}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetTags}</sheets></workbook>`
  );
  const rels = sheets
    .map(
      (_sheet, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
    )
    .join("");
  zip.add(
    "xl/_rels/workbook.xml.rels",
    `${WORD_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}<Relationship Id="rId${count + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
  );
  zip.add("xl/styles.xml", XLSX_STYLES);
  sheets.forEach((sheet, i) => {
    zip.add(`xl/worksheets/sheet${i + 1}.xml`, xlsxSheetXml(sheet));
  });
  fs.writeFileSync(absPath, zip.build());
}

/* ----------------------------------------------------------------- DOCX -- */

export interface DocBlock {
  /** Titre de section (Heading1). */
  heading?: string;
  /** Titre secondaire (Heading2). */
  subheading?: string;
  /** Paragraphe de texte. */
  text?: string;
  /** Liste à puces. */
  bullets?: string[];
  /** Tableau (première ligne en gras). */
  table?: (string | number)[][];
}

const DOCX_STYLES = `${WORD_HEADER}<w:styles ${W_NS}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="52"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="280" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:spacing w:before="200" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:pPr><w:ind w:left="420"/></w:pPr></w:style></w:styles>`;

function docxParagraph(style: string | null, text: string, bold = false): string {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : "";
  const rPr = bold ? "<w:rPr><w:b/></w:rPr>" : "";
  return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
}

function docxTable(rows: (string | number)[][]): string {
  const body = rows
    .map(
      (row, r) =>
        `<w:tr>${row
          .map((cell) => `<w:tc>${docxParagraph(null, String(cell), r === 0)}</w:tc>`)
          .join("")}</w:tr>`
    )
    .join("");
  return `<w:tbl><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="999999"/><w:left w:val="single" w:sz="4" w:color="999999"/><w:bottom w:val="single" w:sz="4" w:color="999999"/><w:right w:val="single" w:sz="4" w:color="999999"/><w:insideH w:val="single" w:sz="4" w:color="999999"/><w:insideV w:val="single" w:sz="4" w:color="999999"/></w:tblBorders></w:tblPr>${body}</w:tbl>`;
}

/** Écrit un document .docx (titres, paragraphes, puces, tableaux). */
export function writeDocx(absPath: string, title: string | undefined, blocks: DocBlock[]): void {
  const body: string[] = [];
  if (title) body.push(docxParagraph("Title", title));
  for (const block of blocks) {
    if (block.heading) body.push(docxParagraph("Heading1", block.heading));
    if (block.subheading) body.push(docxParagraph("Heading2", block.subheading));
    if (block.text?.trim()) {
      for (const line of block.text.split(/\n+/)) {
        if (line.trim()) body.push(docxParagraph(null, line));
      }
    }
    for (const bullet of block.bullets ?? []) {
      body.push(docxParagraph("ListParagraph", `• ${bullet}`));
    }
    if (block.table?.length) body.push(docxTable(block.table));
  }
  const zip = new ZipWriter();
  zip.add(
    "[Content_Types].xml",
    `${WORD_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`
  );
  zip.add(
    "_rels/.rels",
    `${WORD_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`
  );
  zip.add(
    "word/_rels/document.xml.rels",
    `${WORD_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
  );
  zip.add("word/styles.xml", DOCX_STYLES);
  zip.add(
    "word/document.xml",
    `${WORD_HEADER}<w:document ${W_NS}><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418"/></w:sectPr></w:body></w:document>`
  );
  fs.writeFileSync(absPath, zip.build());
}

/* ----------------------------------------------------------------- PPTX -- */

export interface PptxSlide {
  title: string;
  bullets?: string[];
}

const PPTX_THEME = `${WORD_HEADER}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Smolcoder"><a:themeElements><a:clrScheme name="Smolcoder"><a:dk1><a:srgbClr val="1A1A1A"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="2E2E2E"/></a:dk2><a:lt2><a:srgbClr val="F2F2F2"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="16A34A"/></a:accent2><a:accent3><a:srgbClr val="D97706"/></a:accent3><a:accent4><a:srgbClr val="DC2626"/></a:accent4><a:accent5><a:srgbClr val="7C3AED"/></a:accent5><a:accent6><a:srgbClr val="0891B2"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Smolcoder"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Smolcoder"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="103000"/><a:tint val="73000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="109000"/><a:tint val="81000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:satMod val="110000"/><a:lumMod val="100000"/><a:shade val="100000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="99000"/><a:satMod val="120000"/><a:shade val="78000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:tint val="98000"/><a:satMod val="130000"/><a:shade val="90000"/><a:lumMod val="103000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="63000"/><a:satMod val="120000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

const PPTX_LAYOUT = `${WORD_HEADER}<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="obj" preserve="1"><p:cSld name="Titre et contenu"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Titre 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></a:xfrm></p:spPr><p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:endParaRPr lang="fr-FR"/></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Contenu 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="1600200"/><a:ext cx="8229600" cy="4525963"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="fr-FR"/></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const PPTX_MASTER = `${WORD_HEADER}<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4000" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900"><a:defRPr sz="2400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr><a:buChar char="•"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="fr-FR"/></a:defPPr></p:otherStyle></p:txStyles></p:sldMaster>`;

function pptxTextBody(lines: string[], isTitle: boolean): string {
  const paragraphs = lines.map(
    (line, i) =>
      `<a:p><a:r><a:rPr lang="fr-FR"${isTitle && i === 0 ? ' sz="4000" b="1"' : isTitle ? "" : ""}/><a:t>${xml(line)}</a:t></a:r></a:p>`
  );
  return `<a:txBody><a:bodyPr/><a:lstStyle/>${paragraphs.join("") || `<a:p><a:endParaRPr lang="fr-FR"/></a:p>`}</a:txBody>`;
}

function pptxSlideXml(slide: PptxSlide): string {
  const title = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Titre 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></a:xfrm></p:spPr>${pptxTextBody([slide.title], true)}</p:sp>`;
  const body = slide.bullets?.length
    ? `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Contenu 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="1600200"/><a:ext cx="8229600" cy="4525963"/></a:xfrm></p:spPr>${pptxTextBody(slide.bullets, false)}</p:sp>`
    : "";
  return `${WORD_HEADER}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${title}${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

/** Écrit une présentation .pptx (une diapositive par entrée). */
export function writePptx(absPath: string, slides: PptxSlide[]): void {
  const zip = new ZipWriter();
  const slideOverrides = slides
    .map(
      (_slide, i) =>
        `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`
    )
    .join("");
  zip.add(
    "[Content_Types].xml",
    `${WORD_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${slideOverrides}</Types>`
  );
  zip.add(
    "_rels/.rels",
    `${WORD_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`
  );
  const slideIds = slides.map((_slide, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("");
  zip.add(
    "ppt/presentation.xml",
    `${WORD_HEADER}<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId${slides.length + 1}"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
  );
  const slideRels = slides
    .map(
      (_slide, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`
    )
    .join("");
  zip.add(
    "ppt/_rels/presentation.xml.rels",
    `${WORD_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slideRels}<Relationship Id="rId${slides.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId${slides.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>`
  );
  zip.add("ppt/theme/theme1.xml", PPTX_THEME);
  zip.add(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    `${WORD_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`
  );
  zip.add("ppt/slideMasters/slideMaster1.xml", PPTX_MASTER);
  zip.add(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    `${WORD_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`
  );
  zip.add("ppt/slideLayouts/slideLayout1.xml", PPTX_LAYOUT);
  slides.forEach((slide, i) => {
    zip.add(`ppt/slides/slide${i + 1}.xml`, pptxSlideXml(slide));
  });
  fs.writeFileSync(absPath, zip.build());
}

/* ------------------------------------------------------------------ PDF -- */

/** Encode en WinAnsi-ish : tout ce qui dépasse le latin-1 devient "?". */
function pdfText(text: string): string {
  return text
    .replace(/[\\]/g, "\\\\")
    .replace(/[()]/g, (m) => `\\${m}`)
    .replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
}

/** Écrit un PDF 1.4 texte (Helvetica 12, retour à la ligne automatique). */
export function writePdf(absPath: string, title: string | undefined, lines: string[]): void {
  const PAGE_W = 595.28;
  const PAGE_H = 841.89;
  const MARGIN = 56.69;
  const LINE_H = 15.6;
  const MAX_CHARS = 92;
  const wrapped: string[] = [];
  if (title) {
    wrapped.push(title);
    wrapped.push("");
  }
  for (const raw of lines) {
    const text = raw.replace(/\t/g, "  ");
    if (!text.trim()) {
      wrapped.push("");
      continue;
    }
    let rest = text;
    while (rest.length > MAX_CHARS) {
      let cut = rest.lastIndexOf(" ", MAX_CHARS);
      if (cut <= 0) cut = MAX_CHARS;
      wrapped.push(rest.slice(0, cut));
      rest = rest.slice(cut).replace(/^ /, "");
    }
    wrapped.push(rest);
  }
  const rowsPerPage = Math.floor((PAGE_H - 2 * MARGIN - (title ? 34 : 0)) / LINE_H);
  const pages: string[][] = [];
  for (let i = 0; i < wrapped.length; i += rowsPerPage) pages.push(wrapped.slice(i, i + rowsPerPage));
  if (!pages.length) pages.push([""]);
  const objects: string[] = [];
  const pageIds: number[] = [];
  // 1 catalog, 2 pages, 3 font, 4.. : contenu et pages.
  let nextId = 4;
  const pageRecords: { id: number; contentId: number; content: string }[] = [];
  for (const page of pages) {
    const contentId = nextId++;
    const pageId = nextId++;
    pageIds.push(pageId);
    const body: string[] = ["BT", "/F1 12 Tf", `1 0 0 1 ${MARGIN} ${(PAGE_H - MARGIN).toFixed(2)} Tm`, `14.5 TL`];
    let first = true;
    for (const line of page) {
      const encoded = pdfText(line);
      if (first) {
        body.push(`(${encoded}) Tj`);
        first = false;
      } else {
        body.push(`T* (${encoded}) Tj`);
      }
    }
    body.push("ET");
    const stream = body.join("\n");
    pageRecords.push({ id: pageId, contentId, content: stream });
  }
  objects.push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  const kids = pageIds.map((id) => `${id} 0 R`).join(" ");
  objects.push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageIds.length} >>\nendobj\n`);
  objects.push("3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n");
  for (const page of pageRecords) {
    objects.push(`${page.contentId} 0 obj\n<< /Length ${Buffer.byteLength(page.content, "latin1")} >>\nstream\n${page.content}\nendstream\nendobj\n`);
    objects.push(
      `${page.id} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page.contentId} 0 R >>\nendobj\n`
    );
  }
  const chunks: Buffer[] = [];
  let offset = 0;
  const push = (text: string) => {
    const buf = Buffer.from(text, "latin1");
    chunks.push(buf);
    offset += buf.length;
  };
  push("%PDF-1.4\n");
  const xref: number[] = [];
  for (const object of objects) {
    xref.push(offset);
    push(object);
  }
  const xrefStart = offset;
  let xrefText = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const pos of xref) xrefText += `${String(pos).padStart(10, "0")} 00000 n \n`;
  xrefText += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  push(xrefText);
  fs.writeFileSync(absPath, Buffer.concat(chunks));
}

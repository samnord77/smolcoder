/**
 * Outil `document` : écrire un vrai fichier Word (.docx), Excel (.xlsx),
 * PowerPoint (.pptx) ou PDF dans le projet. Contenu structuré en JSON,
 * généré sans aucune dépendance (src/office.ts) — le fichier s'ouvre
 * directement dans Word, Excel, PowerPoint ou un lecteur PDF.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { DocBlock, PptxSlide, XlsxSheet } from "../office";
import { writeDocx, writePdf, writePptx, writeXlsx } from "../office";
import type { ToolSpec } from "../providers/types";
import { resolveInWorkspace, SandboxError } from "../sandbox";

const MAX_SHEETS = 20;
const MAX_ROWS = 5000;
const MAX_BLOCKS = 400;
const MAX_SLIDES = 100;
const MAX_LINES = 4000;

export function documentTool(): ToolSpec {
  return {
    name: "document",
    description:
      'Create a real .xlsx (Excel), .docx (Word), .pptx (PowerPoint) or .pdf file in the project from structured JSON — it opens directly in Excel/Word/PowerPoint or any PDF reader. Examples: xlsx {"sheets":[{"name":"2026","rows":[["Date","Montant"],["01/01",120]]}]} · docx {"title":"Rapport","blocks":[{"heading":"Contexte","text":"…","bullets":["un"],"table":[["A","B"]]}]} · pptx {"slides":[{"title":"Idée","bullets":["rapide"]}]} · pdf {"title":"Notes","lines":["Première ligne"]}.',
    parameters: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["xlsx", "docx", "pptx", "pdf"], description: "Document type" },
        path: { type: "string", description: "File path inside the project (extension added when missing)" },
        title: { type: "string", description: "docx/pdf title" },
        sheets: {
          type: "array",
          description: "xlsx: one entry per sheet (first row bolded)",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              rows: { type: "array", items: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } } },
            },
          },
        },
        blocks: {
          type: "array",
          description: "docx: heading/subheading/text/bullets/table blocks",
          items: {
            type: "object",
            properties: {
              heading: { type: "string" },
              subheading: { type: "string" },
              text: { type: "string" },
              bullets: { type: "array", items: { type: "string" } },
              table: { type: "array", items: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } } },
            },
          },
        },
        slides: {
          type: "array",
          description: "pptx: one entry per slide",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              bullets: { type: "array", items: { type: "string" } },
            },
            required: ["title"],
          },
        },
        lines: { type: "array", items: { type: "string" }, description: "pdf: wrapped automatically" },
      },
      required: ["format", "path"],
    },
  };
}

function rowsOf(value: unknown): (string | number)[][] | null {
  if (!Array.isArray(value) || !value.length) return null;
  return value.map((row) =>
    Array.isArray(row)
      ? row.map((cell) => (typeof cell === "number" && Number.isFinite(cell) ? cell : String(cell ?? "")))
      : [String(row ?? "")]
  );
}

export function runDocument(root: string, args: any): string {
  try {
    const format = String(args?.format ?? "")
      .toLowerCase()
      .trim();
    if (!["xlsx", "docx", "pptx", "pdf"].includes(format)) {
      return 'Error: format requis — "xlsx" (Excel), "docx" (Word), "pptx" (PowerPoint) ou "pdf".';
    }
    let userPath = String(args?.path ?? "").trim();
    if (!userPath) return 'Error: path requis (ex. "budget.xlsx").';
    if (!/\.[a-z0-9]+$/i.test(userPath)) userPath += `.${format}`;
    const abs = resolveInWorkspace(root, userPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const title = typeof args?.title === "string" && args.title.trim() ? args.title.trim().slice(0, 300) : undefined;

    let summary = "";
    if (format === "xlsx") {
      const rawSheets = Array.isArray(args?.sheets) ? args.sheets : [];
      if (!rawSheets.length) return 'Error: sheets requis pour un .xlsx — {"sheets": [{"name": "2026", "rows": [["Date", "Montant"], ["01/01", 120]]}]}.';
      if (rawSheets.length > MAX_SHEETS) return `Error: trop de feuilles (max ${MAX_SHEETS}).`;
      const sheets: XlsxSheet[] = [];
      let totalRows = 0;
      for (const entry of rawSheets) {
        const rows = rowsOf(entry?.rows);
        if (!rows) return "Error: chaque feuille a besoin de rows non vides.";
        if (rows.length > MAX_ROWS) return `Error: trop de lignes dans une feuille (max ${MAX_ROWS}).`;
        totalRows += rows.length;
        sheets.push({ name: typeof entry?.name === "string" ? entry.name : undefined, rows });
      }
      writeXlsx(abs, sheets);
      summary = `${sheets.length} feuille(s), ${totalRows} ligne(s)`;
    } else if (format === "docx") {
      const rawBlocks = Array.isArray(args?.blocks) ? args.blocks : [];
      if (!rawBlocks.length && !title) return 'Error: blocks (ou title) requis pour un .docx — {"blocks": [{"heading": "Titre", "text": "…"}]}.';
      if (rawBlocks.length > MAX_BLOCKS) return `Error: trop de blocs (max ${MAX_BLOCKS}).`;
      const blocks: DocBlock[] = [];
      for (const entry of rawBlocks) {
        if (!entry || typeof entry !== "object") continue;
        blocks.push({
          heading: typeof entry.heading === "string" ? entry.heading.slice(0, 300) : undefined,
          subheading: typeof entry.subheading === "string" ? entry.subheading.slice(0, 300) : undefined,
          text: typeof entry.text === "string" ? entry.text.slice(0, 20000) : undefined,
          bullets: Array.isArray(entry.bullets) ? entry.bullets.filter((b: unknown) => typeof b === "string").slice(0, 200) : undefined,
          table: rowsOf(entry.table) ?? undefined,
        });
      }
      writeDocx(abs, title, blocks);
      summary = `${blocks.length} bloc(s)`;
    } else if (format === "pptx") {
      const rawSlides = Array.isArray(args?.slides) ? args.slides : [];
      if (!rawSlides.length) return 'Error: slides requis pour un .pptx — {"slides": [{"title": "Idée", "bullets": ["un", "deux"]}]}.';
      if (rawSlides.length > MAX_SLIDES) return `Error: trop de diapositives (max ${MAX_SLIDES}).`;
      const slides: PptxSlide[] = [];
      for (const entry of rawSlides) {
        const slideTitle = typeof entry?.title === "string" && entry.title.trim() ? entry.title.trim().slice(0, 300) : "Diapositive";
        slides.push({
          title: slideTitle,
          bullets: Array.isArray(entry?.bullets) ? entry.bullets.filter((b: unknown) => typeof b === "string").slice(0, 100) : undefined,
        });
      }
      writePptx(abs, slides);
      summary = `${slides.length} diapositive(s)`;
    } else {
      const lines = Array.isArray(args?.lines) ? args.lines.filter((l: unknown) => typeof l === "string") : [];
      if (!lines.length && !title) return 'Error: lines (ou title) requis pour un .pdf — {"lines": ["Première ligne"]}.';
      if (lines.length > MAX_LINES) return `Error: trop de lignes (max ${MAX_LINES}).`;
      writePdf(abs, title, lines.slice(0, MAX_LINES));
      summary = `${lines.length} ligne(s)`;
    }

    const size = fs.statSync(abs).size;
    return `Document créé : ${userPath} (${Math.max(1, Math.round(size / 1024))} Ko) — ${summary}.`;
  } catch (err: any) {
    if (err instanceof SandboxError) return `Error: ${err.message}`;
    return `Error: ${err?.message ?? err}`;
  }
}

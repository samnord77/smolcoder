import * as fs from "node:fs";
import * as path from "node:path";
import { resolveInWorkspace } from "./sandbox";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".playwright-mcp", ".c3"]);
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_MATCHES = 200;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_QUERY_LENGTH = 200;
const MAX_LINE_LENGTH = 500;

export interface WorkspaceSearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

export interface WorkspaceSearchResult {
  matches: WorkspaceSearchMatch[];
  scannedFiles: number;
  truncated: boolean;
}

/** Literal, case-insensitive search that never follows symlinks or reads large/binary files. */
export function searchWorkspace(
  workspace: string,
  query: string,
  options: { path?: string; maxMatches?: number; maxFiles?: number; maxBytes?: number } = {}
): WorkspaceSearchResult {
  if (typeof query !== "string" || !query.trim()) throw new Error("La requête de recherche est requise.");
  const needle = query.trim();
  if (needle.length > MAX_QUERY_LENGTH) throw new Error(`La requête de recherche doit faire ${MAX_QUERY_LENGTH} caractères au maximum.`);
  const maxMatches = boundedInteger(options.maxMatches, DEFAULT_MAX_MATCHES, 1, 1000);
  const maxFiles = boundedInteger(options.maxFiles, DEFAULT_MAX_FILES, 1, 20_000);
  const maxBytes = boundedInteger(options.maxBytes, DEFAULT_MAX_BYTES, 1, 512 * 1024 * 1024);
  const start = resolveInWorkspace(workspace, options.path?.trim() || ".");
  const matches: WorkspaceSearchMatch[] = [];
  let scannedFiles = 0;
  let scannedBytes = 0;
  let truncated = false;
  const lowerNeedle = needle.toLocaleLowerCase();

  const walk = (dir: string): void => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) return;
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) walk(abs);
        continue;
      }
      if (!entry.isFile() || entry.name.startsWith(".")) continue;
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) continue;
      if (scannedBytes + stat.size > maxBytes) {
        truncated = true;
        return;
      }
      if (scannedFiles >= maxFiles) {
        truncated = true;
        return;
      }
      scannedFiles++;
      scannedBytes += stat.size;
      let data: Buffer;
      try {
        data = fs.readFileSync(abs);
      } catch {
        continue;
      }
      if (data.includes(0)) continue;
      const text = data.toString("utf8");
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const lineText = lines[index];
        const column = lineText.toLocaleLowerCase().indexOf(lowerNeedle);
        if (column < 0) continue;
        if (matches.length >= maxMatches) {
          truncated = true;
          return;
        }
        matches.push({
          path: path.relative(workspace, abs).split(path.sep).join("/"),
          line: index + 1,
          column: column + 1,
          text: lineText.length > MAX_LINE_LENGTH ? `${lineText.slice(0, MAX_LINE_LENGTH)}…` : lineText,
        });
      }
    }
  };

  let startStat: fs.Stats;
  try {
    startStat = fs.lstatSync(start);
  } catch {
    throw new Error("Le chemin de recherche n'existe pas.");
  }
  if (startStat.isSymbolicLink()) throw new Error("Le chemin de recherche ne peut pas être un lien symbolique.");
  if (startStat.isDirectory()) walk(start);
  else if (startStat.isFile()) {
    const parent = path.dirname(start);
    const name = path.basename(start);
    // Reuse the bounded traversal rules while searching just the requested file.
    if (!name.startsWith(".")) {
      if (startStat.size > MAX_FILE_BYTES) return { matches, scannedFiles, truncated: false };
      if (startStat.size > maxBytes) return { matches, scannedFiles, truncated: true };
      const contents = fs.readFileSync(start);
      if (contents.length <= MAX_FILE_BYTES && !contents.includes(0)) {
        scannedFiles = 1;
        const lines = contents.toString("utf8").split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
          const lineText = lines[index];
          const column = lineText.toLocaleLowerCase().indexOf(lowerNeedle);
          if (column < 0) continue;
          if (matches.length >= maxMatches) {
            truncated = true;
            break;
          }
          matches.push({
            path: path.relative(workspace, path.join(parent, name)).split(path.sep).join("/"),
            line: index + 1,
            column: column + 1,
            text: lineText.length > MAX_LINE_LENGTH ? `${lineText.slice(0, MAX_LINE_LENGTH)}…` : lineText,
          });
        }
      }
    }
  } else throw new Error("Le chemin de recherche n'est ni un fichier ni un dossier.");
  return { matches, scannedFiles, truncated };
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

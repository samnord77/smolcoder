// The five file tools: read_file, write_file, edit_file, list_files, search.
// Design rules for small models: flat string params, generous coaching in every
// error message (an error IS a prompt — write it like one), and hard output
// caps so a single result can't flood a small context window.

import * as fs from "node:fs";
import * as path from "node:path";
import { isHistoryPlaceholder } from "../history";
import { relPath, resolveInWorkspace, SandboxError } from "../sandbox";
import { secretsWarning } from "../secrets";
import { truncateEnd } from "../util";

const READ_LINE_LIMIT = 250;
// Must stay under TOOL_RESULT_CAP (10000) so the registry's outer truncateMiddle
// never silently middle-cuts a read chunk while the trailer claims lines X-Y
// were shown contiguously.
const READ_CHAR_LIMIT = 9000;
const LIST_ENTRY_LIMIT = 200;
const SEARCH_MATCH_LIMIT = 50;
const SEARCH_FILE_SIZE_LIMIT = 512 * 1024;

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  ".next",
  ".nuxt",
  ".cache",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".idea",
  ".vscode",
  "target",
  ".svelte-kit",
  ".turbo",
  "vendor",
]);

const BINARY_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".7z",
  ".rar",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".mov",
  ".avi",
  ".wasm",
  ".db",
  ".sqlite",
  ".jar",
  ".class",
  ".pyc",
]);

function isProbablyBinary(filePath: string): boolean {
  if (BINARY_EXTS.has(path.extname(filePath).toLowerCase())) return true;
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(1024);
    const n = fs.readSync(fd, buf, 0, 1024, 0);
    fs.closeSync(fd);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  } catch {
    return true;
  }
  return false;
}

/** Re-vérifie après le premier contrôle : si le fichier final est un lien
 * qui pointe hors dossier, on refuse. Ça ferme le piège du lien créé
 * entre la vérification et la lecture. */
function assertFinalInside(root: string, abs: string, userPath: string): void {
  try {
    fs.lstatSync(abs);
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(abs);
    const rel = path.relative(realRoot, realTarget);
    const norm = process.platform === "win32" ? rel.toLowerCase() : rel;
    if (norm.startsWith("..") || path.isAbsolute(norm)) {
      throw new SandboxError(`"${userPath}" pointe hors du dossier de travail. Lecture refusée.`);
    }
  } catch (err: any) {
    if (err instanceof SandboxError) throw err;
    /* fichier absent entre-temps : le contrôle initial suffit */
  }
}

export function readFile(root: string, args: any, maxChars = READ_CHAR_LIMIT): string {
  const charLimit = Math.max(128, Math.min(READ_CHAR_LIMIT, Math.floor(maxChars)));
  const abs = resolveInWorkspace(root, args.path);
  assertFinalInside(root, abs, String(args.path));
  if (!fs.existsSync(abs)) {
    const dir = path.dirname(abs);
    let hint = "";
    if (fs.existsSync(dir)) {
      const near = fs.readdirSync(dir).slice(0, 15).join(", ");
      if (near) hint = ` Fichiers qui existent dans ${relPath(root, dir)} : ${near}`;
    }
    return `Error: le fichier « ${args.path} » n’existe pas.${hint}`;
  }
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    return `Error: « ${args.path} » est un dossier, pas un fichier. Utilisez list_files avec {"path": "${args.path}"} pour voir ce qu’il contient.`;
  }
  if (stat.size > 8 * 1024 * 1024)
    return `Error: « ${args.path} » dépasse la limite de 8 Mo pour un fichier texte. Lancez une commande pour extraire une petite section pertinente dans un fichier de l’espace de travail, puis lisez ce fichier.`;
  if (isProbablyBinary(abs)) {
    return `Error: « ${args.path} » ressemble à un fichier binaire (${stat.size} octets) et ne peut pas être lu comme du texte.`;
  }

  const content = fs.readFileSync(abs, "utf8");
  const lines = content.split(/\r?\n/);
  const total = lines.length;
  const offset = Math.max(1, Number(args.offset) || 1);
  if (offset > total) {
    return `Le fichier « ${args.path} » n’a que ${total} ligne${total === 1 ? "" : "s"} ; vous avez déjà lu tout son contenu.`;
  }
  const limit = Math.min(Math.max(1, Number(args.limit) || READ_LINE_LIMIT), 1000);
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  let body = slice.join("\n");
  let end = offset - 1 + slice.length;
  let charCut = false;
  if (body.length > charLimit) {
    const kept = body.slice(0, charLimit).split("\n");
    if (kept.length > 1) {
      // Cut on a line boundary so the trailer never claims a partially-shown
      // line was read.
      kept.pop();
      body = kept.join("\n");
      end = offset - 1 + kept.length;
      charCut = true;
    } else {
      // A single line longer than the limit: there is no line boundary to
      // advance to, so a line-based "continue" would loop forever. Serve the
      // head and say so, without a continuation offset.
      body = body.slice(0, charLimit);
      return `${body}\n\n[la ligne ${offset} sur ${total} est très longue ; seuls ses ${charLimit} premiers caractères sont affichés.]`;
    }
  }
  if (offset === 1 && end >= total && !charCut) return body;
  return `${body}\n\n[lignes ${offset}-${end} sur ${total}. Appelez read_file avec {"path": "${args.path}", "offset": ${end + 1}} pour continuer.]`;
}

export function writeFile(root: string, args: any): string {
  const abs = resolveInWorkspace(root, args.path);
  assertFinalInside(root, abs, String(args.path));
  if (typeof args.content !== "string") {
    return 'Error: le contenu est requis et doit être une chaîne. Exemple : {"path": "notes.txt", "content": "hello"}';
  }
  if (isHistoryPlaceholder(args.content)) {
    return "Error: ceci est un marqueur d'historique, pas du code source. Aucun fichier n'a été modifié. Lisez le fichier actuel et fournissez le contenu complet réel.";
  }
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    return `Error: « ${args.path} » est un dossier existant ; impossible d'y écrire un fichier.`;
  }
  const existed = fs.existsSync(abs);
  const prevLines = existed ? fs.readFileSync(abs, "utf8").split("\n").length : 0;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, args.content, "utf8");
  const newLines = args.content.split("\n").length;
  const base = existed
    ? `${args.path} écrasé (était ${prevLines} lignes, maintenant ${newLines} lignes).`
    : `${args.path} créé (${newLines} lignes).`;
  return base + secretsWarning(args.content);
}

// ---------------------------------------------------------------------------
// move / delete / folder: the file-shape operations an agent needs to
// reorganize a project. Every path runs the same sandbox checks as read and
// write, nothing is ever overwritten silently, and the workspace root itself
// is never a delete target.
// ---------------------------------------------------------------------------

export function movePath(root: string, args: any): string {
  const from = typeof args.from === "string" ? args.from : "";
  const to = typeof args.to === "string" ? args.to : "";
  if (!from.trim() || !to.trim()) {
    return 'Error: « from » et « to » sont tous deux requis. Exemple : {"from": "notes/draft.ts", "to": "src/draft.ts"}.';
  }
  const absFrom = resolveInWorkspace(root, from);
  const absTo = resolveInWorkspace(root, to);
  assertFinalInside(root, absFrom, from);
  if (path.resolve(absFrom) === path.resolve(absTo)) return `Rien à faire : « ${from} » est déjà à ce chemin.`;
  if (!fs.existsSync(absFrom)) {
    return `Error: « ${from} » n'existe pas — rien à déplacer. Utilisez list_files pour vérifier le chemin.`;
  }
  if (fs.existsSync(absTo)) {
    const what = fs.statSync(absTo).isDirectory() ? "un dossier" : "un fichier";
    return `Error: « ${to} » existe déjà (${what}) — rien n'est écrasé silencieusement. Supprimez-le d'abord avec delete_path, puis déplacez.`;
  }
  try {
    fs.mkdirSync(path.dirname(absTo), { recursive: true });
    fs.renameSync(absFrom, absTo);
  } catch (err: any) {
    return `Error: impossible de déplacer « ${from} » vers « ${to} » (${err?.code || err?.message || "raison inconnue"}).`;
  }
  const kind = fs.statSync(absTo).isDirectory() ? "dossier" : "fichier";
  return `${kind.charAt(0).toUpperCase() + kind.slice(1)} « ${from} » → « ${to} » déplacé. (Annulable par /rewind — pas par /undo.)`;
}

export function deletePath(root: string, args: any): string {
  const rel = typeof args.path === "string" ? args.path : "";
  if (!rel.trim()) return 'Error: le chemin est requis. Exemple : {"path": "src/old.ts"}.';
  const abs = resolveInWorkspace(root, rel);
  assertFinalInside(root, abs, rel);
  if (path.resolve(abs) === path.resolve(root)) {
    return "Error: la racine de l'espace de travail elle-même ne peut pas être supprimée. Supprimez plutôt ce qu'elle contient.";
  }
  if (!fs.existsSync(abs)) return `Error: « ${rel} » n'existe pas — rien à supprimer.`;
  const recursive = args.recursive === true || args.recursive === "true";
  let isDir = false;
  try {
    isDir = fs.statSync(abs).isDirectory();
  } catch (err: any) {
    return `Error: impossible d'inspecter « ${rel} » (${err?.code || err?.message || "raison inconnue"}).`;
  }
  if (isDir) {
    const entries = fs.readdirSync(abs);
    if (entries.length && !recursive) {
      return `Error: « ${rel} » est un dossier avec ${entries.length} élément(s). Renvoyez avec {"path": "${rel}", "recursive": true} pour confirmer — une suppression de dossier ne peut pas être annulée ici.`;
    }
    try {
      fs.rmSync(abs, { recursive: true, force: true });
    } catch (err: any) {
      return `Error: impossible de supprimer « ${rel} » (${err?.code || err?.message || "raison inconnue"}).`;
    }
    return `Dossier « ${rel} » supprimé (${entries.length} élément(s)). Celui-ci ne peut pas être annulé ici — git est la récupération.`;
  }
  try {
    fs.unlinkSync(abs);
  } catch (err: any) {
    return `Error: impossible de supprimer « ${rel} » (${err?.code || err?.message || "raison inconnue"}).`;
  }
  return `Fichier « ${rel} » supprimé. ( /undo remet un petit fichier texte. )`;
}

export function createFolder(root: string, args: any): string {
  const rel = typeof args.path === "string" ? args.path : "";
  if (!rel.trim()) return 'Error: le chemin est requis. Exemple : {"path": "src/components"}.';
  const abs = resolveInWorkspace(root, rel);
  assertFinalInside(root, abs, rel);
  if (path.resolve(abs) === path.resolve(root)) return `« ${rel} » est la racine de l'espace de travail — il existe déjà.`;
  if (fs.existsSync(abs)) {
    if (fs.statSync(abs).isDirectory()) return `Le dossier « ${rel} » existe déjà — rien à faire.`;
    return `Error: « ${rel} » existe en tant que fichier, pas un dossier. Déplacez-le d'abord si vous avez besoin du nom.`;
  }
  try {
    fs.mkdirSync(abs, { recursive: true });
  } catch (err: any) {
    return `Error: impossible de créer « ${rel} » (${err?.code || err?.message || "raison inconnue"}).`;
  }
  return `Dossier « ${rel} » créé.`;
}

// ---------------------------------------------------------------------------
// edit_file: exact match first, then a line-trimmed (whitespace-forgiving)
// fallback, then a "closest match" coaching error. Small models paraphrase
// whitespace constantly; forgiving matching is the difference between a usable
// and unusable local edit tool.
// ---------------------------------------------------------------------------

function findTrimmedMatch(fileLines: string[], oldLines: string[]): number[] {
  const targets = oldLines.map((l) => l.trim());
  const matches: number[] = [];
  outer: for (let i = 0; i + targets.length <= fileLines.length; i++) {
    for (let j = 0; j < targets.length; j++) {
      if (fileLines[i + j].trim() !== targets[j]) continue outer;
    }
    matches.push(i);
  }
  return matches;
}

function closestSnippet(fileLines: string[], oldText: string): { text: string; offset: number; limit: number } | null {
  const candidates = oldText.split("\n").map((l) => l.trim());
  // A bare closing brace is not a useful anchor for a failed method edit.
  const firstLine = candidates.find((l) => /[a-zA-Z_$]/.test(l) && l.length > 6) ?? "";
  if (!firstLine) return null;
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const target = norm(firstLine);
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < fileLines.length; i++) {
    const line = norm(fileLines[i]);
    if (!line) continue;
    let score = 0;
    if (line === target) score = 1000;
    else if (line.includes(target) || target.includes(line)) score = 500;
    else {
      const words = target.split(" ").filter((w) => w.length > 2);
      for (const w of words) if (line.includes(w)) score += w.length;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestIdx < 0 || bestScore < 6) return null;
  const start = Math.max(0, bestIdx - 2);
  const end = Math.min(fileLines.length, start + Math.min(20, Math.max(8, candidates.length + 4)));
  return { text: fileLines.slice(start, end).join("\n"), offset: start + 1, limit: end - start };
}

export function editFile(root: string, args: any): string {
  const abs = resolveInWorkspace(root, args.path);
  assertFinalInside(root, abs, String(args.path));
  if (!fs.existsSync(abs)) {
    return `Error: le fichier « ${args.path} » n'existe pas. Utilisez write_file pour créer un nouveau fichier.`;
  }
  const oldText = args.old_text;
  const newText = args.new_text ?? "";
  if (typeof oldText !== "string" || oldText.length === 0) {
    return "Error: old_text est requis — copiez le texte exact du fichier que vous voulez remplacer. Pour créer un nouveau fichier, utilisez write_file à la place.";
  }
  if (typeof newText !== "string") {
    return "Error: new_text doit être une chaîne (utilisez une chaîne vide pour supprimer l'ancien texte).";
  }
  if (isHistoryPlaceholder(newText)) {
    return "Error: ceci est un marqueur d'historique, pas du code source. Aucun fichier n'a été modifié. Lisez le fichier actuel et fournissez le texte de remplacement réel.";
  }

  const rawContent = fs.readFileSync(abs, "utf8");
  // Normalize to LF for all matching, re-serialize with the file's dominant EOL.
  // Otherwise a model that sends "\n"-separated old_text can never exact-match a
  // CRLF file, and the fallback rebuild leaves the file with mixed line endings.
  const crlf = rawContent.includes("\r\n");
  const content = crlf ? rawContent.replace(/\r\n/g, "\n") : rawContent;
  const oldNorm = oldText.replace(/\r\n/g, "\n");
  const newNorm = newText.replace(/\r\n/g, "\n");
  const serialize = (s: string) => (crlf ? s.replace(/\n/g, "\r\n") : s);

  // Tier 1: exact match.
  const occurrences = content.split(oldNorm).length - 1;
  if (occurrences === 1) {
    fs.writeFileSync(abs, serialize(content.replace(oldNorm, newNorm)), "utf8");
    return `${args.path} modifié : 1 occurrence remplacée.` + secretsWarning(newNorm);
  }
  if (occurrences > 1) {
    return `Error: old_text apparaît ${occurrences} fois dans ${args.path}. Ajoutez quelques lignes de contexte dans old_text pour qu'il corresponde à un seul endroit.`;
  }

  // Tier 2: line-trimmed match (forgives leading/trailing whitespace per line).
  const fileLines = content.split("\n");
  const oldLines = oldNorm.split("\n");
  const matches = findTrimmedMatch(fileLines, oldLines);
  if (matches.length === 1) {
    const start = matches[0];
    const replaced = [...fileLines.slice(0, start), ...newNorm.split("\n"), ...fileLines.slice(start + oldLines.length)].join("\n");
    fs.writeFileSync(abs, serialize(replaced), "utf8");
    return (
      `${args.path} modifié : 1 occurrence remplacée (les différences d'espacement dans old_text ont été ignorées).` +
      secretsWarning(newNorm)
    );
  }
  if (matches.length > 1) {
    return `Error: old_text correspond à ${matches.length} endroits dans ${args.path} (espacement ignoré). Ajoutez plus de lignes de contexte pour le rendre unique.`;
  }

  // Tier 3: coach with the closest real snippet.
  const snippet = closestSnippet(fileLines, oldText);
  if (snippet) {
    return `Error: old_text introuvable dans ${args.path}. Le code le plus proche commence à la ligne ${snippet.offset}. Lisez cette plage : ${JSON.stringify({ path: args.path, offset: snippet.offset, limit: snippet.limit })}. Utilisez un petit remplacement exact ; cet extrait n'est qu'un indice d'emplacement, pas le bloc entier que vous essayiez de remplacer.\n---\n${truncateEnd(snippet.text, 1500)}\n---`;
  }
  return `Error: old_text introuvable dans ${args.path}. Lancez read_file dessus d'abord et copiez le texte exact que vous voulez modifier.`;
}

export function listFiles(root: string, args: any): string {
  const startRel = typeof args.path === "string" && args.path.trim() ? args.path : ".";
  const start = resolveInWorkspace(root, startRel);
  if (!fs.existsSync(start)) return `Error: le dossier « ${startRel} » n'existe pas.`;
  if (!fs.statSync(start).isDirectory()) {
    return `Error: « ${startRel} » est un fichier, pas un dossier. Utilisez read_file pour le lire.`;
  }

  const entries: string[] = [];
  let truncated = false;
  const walk = (dir: string, depth: number) => {
    if (truncated || depth > 6) return;
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    names.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of names) {
      if (truncated) return;
      if (e.name.startsWith(".") && e.isDirectory()) continue;
      if (IGNORED_DIRS.has(e.name)) continue;
      if (e.isSymbolicLink()) continue; // never follow links out of the workspace
      const abs = path.join(dir, e.name);
      const rel = relPath(root, abs);
      if (e.isDirectory()) {
        entries.push(`${rel}/`);
        if (entries.length >= LIST_ENTRY_LIMIT) {
          truncated = true;
          return;
        }
        walk(abs, depth + 1);
      } else {
        entries.push(rel);
        if (entries.length >= LIST_ENTRY_LIMIT) {
          truncated = true;
          return;
        }
      }
    }
  };
  walk(start, 0);

  if (entries.length === 0) return `Le dossier « ${startRel} » est vide.`;
  let out = entries.join("\n");
  if (truncated) {
    out += `\n\n[liste plafonnée à ${LIST_ENTRY_LIMIT} entrées. Appelez list_files avec {"path": "<sous-dossier>"} pour explorer plus en profondeur.]`;
  }
  return out;
}

export function searchFiles(root: string, args: any): string {
  const pattern = args.pattern;
  if (typeof pattern !== "string" || !pattern) {
    return 'Error: le motif est requis. Exemple : {"pattern": "function main"}';
  }
  const startRel = typeof args.path === "string" && args.path.trim() ? args.path : ".";
  const start = resolveInWorkspace(root, startRel);
  if (!fs.existsSync(start)) return `Error: le dossier « ${startRel} » n'existe pas.`;

  const startIsFile = fs.statSync(start).isFile();

  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }

  const matches: string[] = [];
  let filesScanned = 0;
  let done = false;

  const walk = (dir: string, depth: number) => {
    if (done || depth > 8) return;
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      if (done) return;
      if (e.name.startsWith(".") && e.isDirectory()) continue;
      if (IGNORED_DIRS.has(e.name)) continue;
      // A symlink's Dirent.isDirectory() is false, so a file symlink would
      // otherwise fall straight into readFileSync and leak its target's
      // contents (e.g. creds -> ~/.ssh/id_rsa) into model context. Skip all.
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      if (startIsFile && abs !== start) continue;
      if (e.isDirectory()) {
        walk(abs, depth + 1);
        continue;
      }
      if (filesScanned++ > 5000) {
        done = true;
        return;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      if (stat.size > SEARCH_FILE_SIZE_LIMIT || isProbablyBinary(abs)) continue;
      let text: string;
      try {
        text = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push(`${relPath(root, abs)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (matches.length >= SEARCH_MATCH_LIMIT) {
            done = true;
            break;
          }
        }
      }
    }
  };

  if (startIsFile) {
    // Scan only that single file: walking its whole parent folder would leak
    // neighboring files into model context and waste time.
    try {
      const stat = fs.statSync(start);
      if (stat.size <= SEARCH_FILE_SIZE_LIMIT && !isProbablyBinary(start)) {
        filesScanned++;
        const text = fs.readFileSync(start, "utf8");
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            matches.push(`${relPath(root, start)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
            if (matches.length >= SEARCH_MATCH_LIMIT) break;
          }
        }
      }
    } catch {
      /* unreadable file counts as no match */
    }
  } else {
    walk(start, 0);
  }

  if (matches.length === 0) {
    return `Aucune correspondance pour « ${pattern} » dans ${startRel}. (${filesScanned} fichiers examinés. Astuce : essayez un motif plus court ou plus simple.)`;
  }
  let out = matches.join("\n");
  if (matches.length >= SEARCH_MATCH_LIMIT) {
    out += `\n\n[arrêté à ${SEARCH_MATCH_LIMIT} correspondances — précisez le motif ou cherchez dans un sous-dossier avec {"path": "..."}]`;
  }
  return out;
}

export { SandboxError };

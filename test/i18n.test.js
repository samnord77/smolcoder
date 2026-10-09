// Garde-fou i18n : aucun texte anglais visible ne doit réapparaître dans
// l'interface — web (src/web/*.ts : attributs title/placeholder/aria-label,
// littéraux de tous les fichiers, backticks compris) ET pages desktop
// (desktop/*.html : texte visible + attributs + littéraux des <script>,
// desktop/*.js : littéraux hors scripts utilitaires de dev).
// Exécution automatique via scripts/test.cjs.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const WEB_DIR = path.join(__dirname, "..", "src", "web");
const DESKTOP_DIR = path.join(__dirname, "..", "desktop");
const webTs = fs
  .readdirSync(WEB_DIR)
  .filter((f) => f.endsWith(".ts"))
  .sort();
const FILES = webTs;
// Scan littéral complet de tous les modules web (régression Lot B :
// client.ts, page.ts, hub.ts, store.ts, terminal.ts, channel.ts, ...).
const LITERAL_FILES = webTs;
// Pages et services desktop réellement affichés (les *.bak et scripts de
// dev — smoke/check-hub/hl-check/sse-check — sont volontairement exclus).
const DESKTOP_HTML = ["editor.html", "git.html", "mcp.html"];
const DESKTOP_JS = [
  "main.js",
  "hub-client.js",
  "git-service.js",
  "mcp-status.js",
  "editor-file-service.js",
  "preload.js",
  "preload-git.js",
  "preload-panel.js",
];

// Littéraux uniquement : les concaténations dynamiques s'arrêtent au
// premier guillemet fermant et ne sont donc jamais faussement analysées.
const LITERAL_ATTR = /(title|placeholder|aria-label|textContent|innerText|alt)\s*=\s*(["'`])((?:(?!\2).)*)\2/g;

// Sous-chaînes anglaises historiquement traduites (rèression directe).
const BLACKLIST = [
  "Previous change",
  "Next change",
  "Previous file",
  "Next file",
  "show staged changes",
  "Stage file",
  "Stage ✓",
  "Working tree",
  "side-by-side view",
  "unified view",
  "Page error",
  "thought for",
  "Moved to background",
  "It finished before",
  "Loading review",
  "Review action failed",
  "Working tree clean",
  "Write a commit message",
  "Commit failed",
  "no changes",
  "select a file",
  "No file selected",
  "commit staged changes",
  "stage the whole file",
  "revert the whole file",
  "take the file back",
  "Stage failed",
  "Filter hunks",
  "Filter files and hunks",
  "send",
  "Spaces: ",
  "reconnecting",
  "new session in",
  "close tab",
  "new browser tab",
  "project files",
  "split: second files panel",
  "review uncommitted changes",
  "new terminal",
  "hide panel",
  "open in a new browser tab",
  "search workspace",
  "new file in this folder",
  "new folder here",
  "rename the open file",
  "delete the open file",
  "refresh review",
  "refresh task list",
  "stage this hunk",
  "stage checked lines",
  "take this hunk",
  "revert this hunk",
  "stage this line",
  "Unstage",
  "Revert ",
  "Reload",
  "remove",
  // --- régressions du lot 5 (textes traduits, en arguments ou textContent) ---
  "always allow this program",
  "interrupt the agent",
  "Context usage",
  "reserved for reply",
  "Paused",
  "Stopped",
  "Turn cancelled",
  "close session",
  "delete session",
  "Delete this session",
  "Rename session",
  "new session",
  "saved — click",
  "Close the open sessions",
  "no subfolders",
  "dev servers",
  "Preview inactive",
  "Enter a URL",
  "Enter a valid",
  "Preview a separate",
  "Search failed",
  "Review view",
  "No task list",
  "mark step",
  "Plan update failed",
  "Loading task list",
  "uploading…",
  "model can't see",
  "upload failed",
  "Share failed",
  "Read-only live",
  "Permission mode",
  "New line",
  "task list",
  "new tab",
  "Open ",
  "Close ",
  // --- hub.ts (messages serveur affichés dans l'UI) ---
  "no such session",
  "no such session or workspace",
  "no such terminal",
  "not a folder",
  "not a file",
  "unknown session",
  "session is not ready",
  "no plan in this session",
  "instruction is required",
  "unknown edit job",
  "edit job expired",
  "edit failed",
  "path is required",
  "path and to are required",
  "unknown endpoint",
  "bad request",
  "forbidden",
  "close its open sessions first",
  "session resumed",
  "Session could not be saved",
  "already exists",
  "does not exist",
  "is a folder, not a file",
  "workspace is read-only",
  "invalid file version",
  "file was removed from disk",
  "file changed on disk",
  "could not read",
  "select the code to replace first",
  "selection too large",
  "read-only session",
  "the model did not",
  "no longer running",
  "unknown language",
  "action must be",
  "ops must be",
  "invalid JSON body",
  "request body too large",
  "upload limit",
  "unknown or expired share",
  "no longer available",
  "Cowork work item",
  "only HTML files",
  "preview file must",
  "mcp: missing server name",
  "mcp: no MCP bridge",
  "lang is required",
  "creating or changing work items",
  "image must be",
  "cannot see images",
  "cannot read ",
  // --- régressions desktop + labels de mode (traduits cette session) ---
  "Read-only",
  "YOLO bypass",
  "Switch model or find models",
  "Invalid session id",
  "could not start",
  "Git command failed",
  "Enter a commit message",
  "Commit message exceeds",
  "Choose a file to commit",
  "Choose a changed file",
  "no longer configured",
  "configuration file was not found",
  "Invalid MCP server",
];

// Motifs anglais généraux (phrases et mots caractéristiques) pour les
// futurs ajouts. Les mots techniques (git, HEAD, file, commit…) sont
// volontairement exclus : ils restent en anglais par convention.
const ENGLISH_PATTERNS = [
  /\bthe\b/i,
  /\byour\b/i,
  /\bplease\b/i,
  /\bcannot\b/i,
  /\bdoes not\b/i,
  /\bwill be\b/i,
  /\bclicking\b/i,
  /\bprevious\b/i,
  /\bno file\b/i,
  /\bloading\b/i,
  /\bside-by-side\b/i,
  /\bunified view\b/i,
  /\bworking tree\b/i,
  /\breconnecting\b/i,
  /\bpage error\b/i,
  /\bmoved to background\b/i,
  /\breview action\b/i,
  /\bstage file\b/i,
  /\bunstage\b/i,
  // --- motifs élargis (appliqués aux littéraux qui contiennent un espace) ---
  /\bclose\b/i,
  /\bopen\b/i,
  /\bcancel\b/i,
  /\bcopy\b/i,
  /\bpaste\b/i,
  /\bfailed\b/i,
  /\bclick\b/i,
];

// Toutes les chaînes littérales simples (arguments de el(), prompt(),
// confirm(), alert(), textContent, throw new Error(...), etc.), backticks
// compris, pas seulement celles affectées à un attribut connu.
const ANY_STRING = /(["'`])((?:\\.|(?!\1).)*)\1/g;

// Littéraux volontairement anglais : prompts envoyés aux modèles (leur
// language est un protocole, pas une interface) — hub.ts.
const EXCEPTIONS = [
  /Reply with ONLY one fenced/,
  // Valeurs protocolaires (stées dans l'API git/hook) : les mots anglais
  // sont des identifiants comparés côté serveur, pas des textes affichés.
  /action doit être "stage"/,
  /l\\?'action doit être "extend"/,
];

// Un littéral qui sert de valeur comparée (=== "running"), qui vit dans un
// commentaire // ou /* */, ou dont l'apostrophe est au milieu d'un texte
// français ("l'instruction…") n'est jamais un littéral à traduire.
function isVisibleLiteral(src, index) {
  const quote = src[index];
  const before = src[index - 1] ?? "";
  if (quote === "'" && /[A-Za-zÀ-ÿ'’]/.test(before)) return false;
  const lineStart = src.lastIndexOf("\n", index) + 1;
  const beforeLine = src.slice(lineStart, index);
  if (/(===|!==)\s*$/.test(beforeLine) || /\bcase\s+$/.test(beforeLine)) return false;
  if (beforeLine.includes("//") || beforeLine.includes("/*")) return false;
  return true;
}

test("i18n: l'interface web ne contient plus de texte anglais visible", () => {
  const violations = [];
  const check = (file, attr, value, index, src) => {
    if (!/[A-Za-z]{3,}/.test(value)) return;
    // Suffixe de classe CSS (" open", " hidden") : jamais du texte affiché.
    if (/\s/.test(value) && /^\s*[a-z][a-z-]*\s*$/.test(value)) return;
    const line = src.slice(0, index).split("\n").length;
    // Dans un template literal, ${...} est du code (classes CSS
    // conditionnelles…) : on n'analyse que les fragments affichés.
    for (const part of value.split(/\$\{[^{}]*\}/g)) {
      if (!/[A-Za-z]{3,}/.test(part)) continue;
      for (const banned of BLACKLIST) {
        // Les phrases (avec espace) sont cherchées en sous-chaîne ; les mots
        // courts ne doivent égaliser la chaîne entière (évite "remove" dans
        // les routes API, "send" dans une phrase déjà française...).
        const match = banned.includes(" ") ? part.includes(banned) : part === banned;
        if (match) {
          violations.push(`${file}:${line} ${attr} contient "${banned}" → "${part}"`);
        }
      }
      if (/\s/.test(part) && !/^\/[a-z]/.test(part)) {
        for (const pattern of ENGLISH_PATTERNS) {
          if (pattern.test(part)) {
            violations.push(`${file}:${line} ${attr} matche ${pattern} → "${part}"`);
          }
        }
      }
    }
  };
  const scanLiterals = (file, src, label) => {
    ANY_STRING.lastIndex = 0;
    let s = ANY_STRING.exec(src);
    while (s !== null) {
      const value = s[2];
      const exempt = EXCEPTIONS.some((e) => e.test(value));
      if (!exempt && isVisibleLiteral(src, s.index) && !value.includes("://") && !value.includes("\\n")) {
        check(file, label, value, s.index, src);
      }
      s = ANY_STRING.exec(src);
    }
  };
  for (const file of FILES) {
    const full = path.join(WEB_DIR, file);
    if (!fs.existsSync(full)) continue;
    const src = fs.readFileSync(full, "utf8");
    LITERAL_ATTR.lastIndex = 0;
    let m = LITERAL_ATTR.exec(src);
    while (m !== null) {
      check(file, m[1], m[3], m.index, src);
      m = LITERAL_ATTR.exec(src);
    }
  }
  for (const file of LITERAL_FILES) {
    const full = path.join(WEB_DIR, file);
    if (!fs.existsSync(full)) continue;
    scanLiterals(file, fs.readFileSync(full, "utf8"), "chaîne");
  }
  // --- Pages desktop : attributs, texte visible entre balises et littéraux
  // des <script> inline (commentaires HTML blanchis pour ne pas les lire) ---
  for (const file of DESKTOP_HTML) {
    const full = path.join(DESKTOP_DIR, file);
    if (!fs.existsSync(full)) continue;
    const src = fs.readFileSync(full, "utf8");
    LITERAL_ATTR.lastIndex = 0;
    let m = LITERAL_ATTR.exec(src);
    while (m !== null) {
      check(file, m[1], m[3], m.index, src);
      m = LITERAL_ATTR.exec(src);
    }
    const clean = src
      .replace(/<!--[\s\S]*?-->/g, (c) => " ".repeat(c.length))
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (c) => " ".repeat(c.length))
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (c) => " ".repeat(c.length));
    const textRe = />([^<>{}\n]{4,160})</g;
    let t = textRe.exec(clean);
    while (t !== null) {
      const value = t[1].trim();
      if (/[A-Za-z]{4,}/.test(value)) check(file, "texte", value, t.index + 1, src);
      t = textRe.exec(clean);
    }
    const scriptRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
    let b = scriptRe.exec(src);
    while (b !== null) {
      scanLiterals(file, b[1], "script");
      b = scriptRe.exec(src);
    }
  }
  // --- Services desktop (messages d'erreur remontés dans l'UI) ---
  for (const file of DESKTOP_JS) {
    const full = path.join(DESKTOP_DIR, file);
    if (!fs.existsSync(full)) continue;
    scanLiterals(file, fs.readFileSync(full, "utf8"), "chaîne");
  }
  assert.deepEqual(violations, [], `Textes anglais détectés dans l'UI (traduire en français) :\n${violations.join("\n")}`);
});

test("i18n: les libellés de mode (MODE_LABELS) restent en français", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "tools", "index.ts"), "utf8");
  const m = src.match(/export const MODE_LABELS[\s\S]{0,300}?\};/);
  assert.ok(m, "MODE_LABELS introuvable dans src/tools/index.ts");
  assert.ok(!/read-only|YOLO bypass|"edit"|"ro"/i.test(m[0]), `MODE_LABELS contient un libellé anglais à traduire : ${m[0]}`);
});

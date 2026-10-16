// Détection LOCALE de secrets (clés d'API, jetons, mots de passe, clés
// privées) dans du texte ou dans les fichiers d'un dossier de travail.
// 100 % hors-ligne : rien ne sort de la machine. Les secrets détectés ne
// sont JAMAIS affichés en entier — les aperçus sont masqués.

import * as fs from "node:fs";
import * as path from "node:path";

export interface SecretFinding {
  rule: string;
  line: number;
  preview: string;
}

export interface SecretFileFinding extends SecretFinding {
  file: string;
}

export interface WorkspaceScanResult {
  scanned: number;
  skipped: number;
  findings: SecretFileFinding[];
  truncated: boolean;
}

const SCAN_MAX_FILES = 2000;
const SCAN_MAX_FILE_BYTES = 512 * 1024;
const SCAN_MAX_FINDINGS = 500;

const SKIP_DIRS = new Set([
  ".git",
  ".c3",
  "node_modules",
  "dist",
  ".smol",
  "build",
  "out",
  "target",
  "vendor",
  ".next",
  ".cache",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
]);

const BINARY_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".tiff",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".7z",
  ".rar",
  ".xz",
  ".bz2",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".class",
  ".jar",
  ".war",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
  ".mkv",
  ".wav",
  ".ogg",
  ".webm",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".db",
  ".sqlite",
  ".sqlite3",
  ".lock",
]);

// Valeurs manifestement factices : documentation, exemples, variables
// d'environnement — on ne veut pas noyer l'utilisateur sous les fausses
// alertes.
const PLACEHOLDER_RE =
  /^(?:changeme|change-me|your(?:[-_].*)?|example(?:[-_].*)?|sample(?:[-_].*)?|placeholder(?:[-_].*)?|redacted(?:[-_].*)?|dummy(?:[-_].*)?|fake(?:[-_].*)?|todo(?:[-_].*)?|fixme(?:[-_].*)?|none|null|undefined|true|false|x{3,}|\*+|\.{3,}|(?:test|secret|password|pass|abc|123|token|key)\d*)$/i;

function isPlaceholder(value: string): boolean {
  const v = value.trim().replace(/^["']|["'],?$/g, "");
  // Ponctuation de code collée à la valeur capturée (virgule, parenthèse…).
  const t = v.replace(/^[,;[{]+/, "").replace(/[,;)\]}>]+$/, "");
  if (t.length < 8) return true;
  // Expression de code (appel, indexation, tableau, accolade) : pas un secret.
  if (/[()[\]{},;]/.test(t)) return true;
  if (PLACEHOLDER_RE.test(t)) return true;
  if (/[$<>{}%]/.test(t)) return true; // ${ENV}, <token>, %VAR%, {{...}}
  if (/^process\.env|^env\.|^import\.meta/i.test(t)) return true;
  if (/^(.)\1+$/.test(t)) return true; // une seule lettre répétée
  // Référence de code sans chiffre (config.authToken, settings.token…) :
  // un identifiant pur, pas un secret. Avec un chiffre, on signale quand
  // même (mot de passe court typique).
  if (/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(t) && !/[0-9]/.test(t)) return true;
  return false;
}

interface SecretRule {
  name: string;
  pattern: RegExp;
  keep?: number; // caractères visibles dans l'aperçu
  valueGroup?: number; // pour les règles "attribution" : le groupe à filtrer
  label?: string; // aperçu sans valeur (attribution)
}

const RULES: SecretRule[] = [
  { name: "clé privée", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: "clé AWS", pattern: /\bAKIA[0-9A-Z]{16}\b/, keep: 4 },
  { name: "clé Google API", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, keep: 4 },
  { name: "jeton GitHub", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/, keep: 4 },
  { name: "jeton GitHub", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/, keep: 11 },
  { name: "clé sk- (OpenAI/Anthropic)", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/, keep: 3 },
  { name: "jeton Slack", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, keep: 4 },
  { name: "clé Stripe live", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/, keep: 3 },
  {
    name: "jeton JWT",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    keep: 3,
  },
  {
    name: "secret en clair",
    pattern: /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*["']?([^\s"']{8,})/i,
    valueGroup: 2,
    label: "••••",
  },
];

function previewFor(rule: SecretRule, match: RegExpExecArray): string {
  if (rule.label !== undefined) return rule.label;
  const raw = match[0];
  const keep = rule.keep ?? 0;
  return keep > 0 ? `${raw.slice(0, keep)}••••` : "••••";
}

/** Scanne un texte (borné à 512 KiB) : une entrée par ligne et par règle. */
export function scanForSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  if (!text) return findings;
  const bounded = text.length > SCAN_MAX_FILE_BYTES ? text.slice(0, SCAN_MAX_FILE_BYTES) : text;
  const lines = bounded.split(/\r?\n/);
  for (let i = 0; i < lines.length && findings.length < SCAN_MAX_FINDINGS; i++) {
    const line = lines[i];
    for (const rule of RULES) {
      const m = rule.pattern.exec(line);
      if (m === null) continue;
      if (rule.valueGroup !== undefined && isPlaceholder(m[rule.valueGroup] ?? "")) continue;
      findings.push({ rule: rule.name, line: i + 1, preview: previewFor(rule, m) });
    }
  }
  return findings;
}

function looksBinary(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTS.has(ext)) return true;
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return true; // illisible : compté comme ignoré
  }
  return false;
}

/** Parcourt un dossier (borné) et retourne les secrets potentiels trouvés. */
export function scanWorkspaceFiles(root: string, opts: { maxFiles?: number } = {}): WorkspaceScanResult {
  const maxFiles = opts.maxFiles ?? SCAN_MAX_FILES;
  const result: WorkspaceScanResult = { scanned: 0, skipped: 0, findings: [], truncated: false };
  const queue: string[] = [root];
  while (queue.length > 0) {
    const dir = queue.shift() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (result.scanned >= maxFiles || result.findings.length >= SCAN_MAX_FINDINGS) {
        result.truncated = true;
        return result;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        queue.push(abs);
        continue;
      }
      if (!entry.isFile()) continue; // symlinks : jamais suivis
      if (looksBinary(abs)) {
        result.skipped++;
        continue;
      }
      let text: string;
      try {
        const stat = fs.statSync(abs);
        if (stat.size > SCAN_MAX_FILE_BYTES) {
          result.skipped++;
          continue;
        }
        text = fs.readFileSync(abs, "utf8");
      } catch {
        result.skipped++;
        continue;
      }
      result.scanned++;
      for (const f of scanForSecrets(text)) {
        result.findings.push({ ...f, file: path.relative(root, abs) || entry.name });
        if (result.findings.length >= SCAN_MAX_FINDINGS) {
          result.truncated = true;
          break;
        }
      }
    }
  }
  return result;
}

export function formatSecretsReport(scan: WorkspaceScanResult, root: string): string {
  const lines: string[] = [];
  lines.push("Analyse de secrets — 100 % locale, aucun envoi sur le réseau.");
  lines.push(`Dossier : ${root}`);
  lines.push(`Fichiers analysés : ${scan.scanned} (ignorés : ${scan.skipped}${scan.truncated ? ", analyse tronquée" : ""}).`);
  if (scan.findings.length === 0) {
    lines.push("Aucun secret potentiel détecté.");
    return lines.join("\n");
  }
  lines.push(`${scan.findings.length} secret(s) potentiel(s) :`);
  for (const f of scan.findings) {
    lines.push(`  ${f.file}:${f.line} — ${f.rule} (${f.preview})`);
  }
  lines.push("Valeurs masquées volontairement : elles ne sont jamais affichées en entier.");
  return lines.join("\n");
}

/** Ligne d'avertissement à ajouter aux résultats d'écriture (ou ""). */
export function secretsWarning(text: string): string {
  const findings = scanForSecrets(text);
  if (findings.length === 0) return "";
  const shown = findings
    .slice(0, 5)
    .map((f) => `${f.rule} (ligne ${f.line}, ${f.preview})`)
    .join(" ; ");
  const more = findings.length > 5 ? ` (+${findings.length - 5} autre(s))` : "";
  return ` ⚠️ secret potentiel dans le contenu écrit : ${shown}${more} — vérifiez avant de committer.`;
}

// La machine à remonter le temps. Chaque tour d'agent (« tour » = un message
// utilisateur traité) enregistre, AVANT toute modification, l'état d'avant-tour
// des fichiers touchés par les outils ; /rewind restaure ensuite les fichiers
// tels qu'ils étaient au début du tour choisi.
//
// Stockage par session : ~/.smolcoder/file-history/<sessionId>/
//   index.json          — { version, turns: [{ turn, prompt, at, files }] }
//   blobs/<sha256>      — contenus d'avant modification, dédupliqués par hash
//
// Il est strictement best effort : une capture qui échoue ne doit JAMAIS
// interrompre une écriture d'outil, et un index illisible repart à vide.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type HistoryKind = "write" | "edit" | "delete" | "move" | "mkdir";

export interface HistoryFile {
  /** Chemin relatif normalisé (séparateurs « / », jamais hors workspace). */
  rel: string;
  kind: HistoryKind;
  /** Hash sha256 du contenu d'avant modification ; null = n'existait pas. */
  blob: string | null;
  /** Taille d'avant modification en octets (0 quand inconnue). */
  size: number;
  /** Raison pour laquelle aucun contenu n'a été conservé. */
  skipped?: "too-large" | "directory" | "unreadable";
}

export interface HistoryTurn {
  turn: number;
  prompt: string;
  at: string;
  files: HistoryFile[];
}

export interface RestoreOutcome {
  turn: number;
  restored: string[];
  deleted: string[];
  unchanged: string[];
  failed: { rel: string; reason: string }[];
}

const MAX_TURNS = 100;
const MAX_BLOB_BYTES = 2 * 1024 * 1024;
const PROMPT_CHARS = 120;

export function defaultHistoryRoot(): string {
  return path.join(os.homedir(), ".smolcoder", "file-history");
}

/** « src/app.ts », « ./a\\b » → « src/app.ts », « a/b » ; "" si suspect. */
function normalizeRel(rel: string): string {
  const raw = String(rel ?? "")
    .replace(/\\/g, "/")
    .trim();
  if (!raw || raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) return "";
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return "";
    parts.push(part);
  }
  return parts.join("/");
}

function clampPrompt(prompt: string): string {
  const flat = String(prompt ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > PROMPT_CHARS ? `${flat.slice(0, PROMPT_CHARS - 1)}…` : flat;
}

export class FileHistory {
  constructor(private root: string = defaultHistoryRoot()) {}

  private dirFor(sid: string): string {
    // L'identifiant vient du programme, mais on le nettoie quand même : un id
    // extérieur ne doit jamais pouvoir remonter hors de la racine.
    const safe = String(sid ?? "")
      .replace(/[^a-zA-Z0-9_.-]/g, "_")
      .slice(0, 64);
    return path.join(this.root, safe || "default");
  }

  private indexFile(sid: string): string {
    return path.join(this.dirFor(sid), "index.json");
  }

  /** Tolérant : index absent ou corrompu → aucun tour (jamais d'exception). */
  readIndex(sid: string): HistoryTurn[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexFile(sid), "utf8"));
      const turns = parsed?.turns;
      if (!Array.isArray(turns)) return [];
      return turns.filter((t: any) => t && Number.isInteger(t?.turn) && Array.isArray(t?.files)) as HistoryTurn[];
    } catch {
      return [];
    }
  }

  /** Écriture atomique (tmp + rename) ; silencieuse en cas d'échec disque. */
  private writeIndex(sid: string, turns: HistoryTurn[]): void {
    const dir = this.dirFor(sid);
    fs.mkdirSync(dir, { recursive: true });
    const file = this.indexFile(sid);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, turns }, null, 1), "utf8");
    fs.renameSync(tmp, file);
  }

  /** Ouvre un nouveau tour et retourne son numéro (persistant, croissant). */
  beginTurn(sid: string, prompt: string): number {
    try {
      const turns = this.readIndex(sid);
      const turn = (turns[turns.length - 1]?.turn ?? 0) + 1;
      turns.push({ turn, prompt: clampPrompt(prompt), at: new Date().toISOString(), files: [] });
      let trimmed = false;
      while (turns.length > MAX_TURNS) {
        turns.shift();
        trimmed = true;
      }
      this.writeIndex(sid, turns);
      if (trimmed) this.purgeBlobs(sid, turns);
      return turn;
    } catch {
      return 0;
    }
  }

  /** Enregistre l'état ACTUEL d'un fichier (donc d'avant l'écriture en cours).
   * Un seul enregistrement par fichier et par tour : c'est l'état au début du
   * tour qui compte pour /rewind. Ne lève jamais. */
  capture(sid: string, workspace: string, rel: unknown, kind: HistoryKind): void {
    try {
      const turns = this.readIndex(sid);
      const current = turns[turns.length - 1];
      if (!current) return;
      const norm = normalizeRel(String(rel ?? ""));
      if (!norm || current.files.some((f) => f.rel === norm)) return;

      const abs = path.resolve(workspace, norm);
      const entry: HistoryFile = { rel: norm, kind, blob: null, size: 0 };
      try {
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) {
          entry.skipped = "directory";
        } else if (stat.size > MAX_BLOB_BYTES) {
          entry.skipped = "too-large";
          entry.size = stat.size;
        } else {
          const buf = fs.readFileSync(abs);
          entry.size = buf.length;
          entry.blob = this.storeBlob(sid, buf);
        }
      } catch (err: any) {
        // ENOENT = le fichier n'existait pas encore : blob null, aucune raison
        // de s'en plaindre (c'est le cas normal d'une création).
        if (err?.code !== "ENOENT") entry.skipped = "unreadable";
      }
      current.files.push(entry);
      this.writeIndex(sid, turns);
    } catch {
      /* l'historique ne doit jamais casser une écriture */
    }
  }

  private storeBlob(sid: string, buf: Buffer): string {
    const hash = crypto.createHash("sha256").update(buf).digest("hex");
    const dir = path.join(this.dirFor(sid), "blobs");
    const file = path.join(dir, hash);
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
    } catch {
      /* blob non stocké : le hash reste, le restore signalera l'échec */
    }
    return hash;
  }

  private blobPath(sid: string, hash: string): string {
    return path.join(this.dirFor(sid), "blobs", hash);
  }

  /** Supprime les blobs non référencés (après élagage de vieux tours). */
  private purgeBlobs(sid: string, turns: HistoryTurn[]): void {
    try {
      const referenced = new Set<string>();
      for (const t of turns) for (const f of t.files) if (f.blob) referenced.add(f.blob);
      const dir = path.join(this.dirFor(sid), "blobs");
      for (const name of fs.readdirSync(dir)) {
        if (!referenced.has(name)) {
          try {
            fs.unlinkSync(path.join(dir, name));
          } catch {
            /* tant pis */
          }
        }
      }
    } catch {
      /* purge best effort */
    }
  }

  /** Les tours les plus récents d'abord, bornés à `limit`. */
  list(sid: string, limit = 20): HistoryTurn[] {
    const turns = this.readIndex(sid);
    const start = Math.max(0, turns.length - Math.max(1, limit));
    return turns.slice(start).reverse();
  }

  /** Restaure les fichiers tels qu'ils étaient AU DÉBUT du tour `since` :
   * tout ce qui a été touché par les tours >= since revient à sa première
   * capture d'avant-tour. Les créations de ces tours sont supprimées. */
  restore(sid: string, since: number, workspace: string): RestoreOutcome {
    const outcome: RestoreOutcome = {
      turn: since,
      restored: [],
      deleted: [],
      unchanged: [],
      failed: [],
    };
    const target = new Map<string, HistoryFile>();
    for (const t of this.readIndex(sid)) {
      if (t.turn < since) continue;
      for (const f of t.files) if (!target.has(f.rel)) target.set(f.rel, f);
    }
    for (const [rel, f] of target) {
      const abs = path.resolve(workspace, rel);
      try {
        if (f.skipped === "directory") {
          // Un dossier supprimé en bloc n'a pas de contenu conservé : on ne
          // peut pas le recréer, on le dit clairement. Une création de
          // dossier (mkdir), elle, se retire si elle est restée vide.
          if (f.kind === "mkdir") {
            try {
              fs.rmdirSync(abs);
              outcome.deleted.push(rel);
            } catch {
              outcome.unchanged.push(rel);
            }
          } else {
            outcome.failed.push({ rel, reason: "dossier modifié en bloc (restaure-le avec git)" });
          }
          continue;
        }
        if (f.skipped === "too-large" || f.skipped === "unreadable") {
          // Le contenu d'avant n'a pas été conservé : ne surtout pas toucher
          // au fichier actuel (le supprimer détruirait du travail).
          outcome.failed.push({
            rel,
            reason:
              f.skipped === "too-large" ? "trop volumineux pour l'historique (2 Mo max)" : "contenu illisible au moment du checkpoint",
          });
          continue;
        }
        if (f.blob === null) {
          if (!fs.existsSync(abs)) {
            outcome.unchanged.push(rel);
          } else {
            fs.rmSync(abs, { force: true, recursive: true });
            outcome.deleted.push(rel);
          }
          continue;
        }
        const buf = fs.readFileSync(this.blobPath(sid, f.blob));
        let current: Buffer | null = null;
        try {
          current = fs.readFileSync(abs);
        } catch {
          current = null;
        }
        if (current && current.equals(buf)) {
          outcome.unchanged.push(rel);
          continue;
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, buf);
        outcome.restored.push(rel);
      } catch (err: any) {
        outcome.failed.push({ rel, reason: String(err?.message ?? err) });
      }
    }
    return outcome;
  }
}

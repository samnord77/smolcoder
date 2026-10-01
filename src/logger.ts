import * as fs from "node:fs";
import * as path from "node:path";
import { DATA_DIR } from "./config";

export interface LogEntry {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  message: string;
}

const GLOBAL_LOG_FILE = path.join(DATA_DIR, "smolcoder.log");

/** Écrit une ligne de log horodatée dans ~/.smolcoder/smolcoder.log et optionnellement dans le workspace. */
export function appendSmolLog(level: "info" | "warn" | "error" | "debug", message: string, workspace?: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${message}\n`;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(GLOBAL_LOG_FILE, line, "utf8");
  } catch {
    /* Écriture en mode best-effort */
  }

  if (workspace) {
    try {
      const wsLogDir = path.join(workspace, ".smol");
      fs.mkdirSync(wsLogDir, { recursive: true });
      fs.appendFileSync(path.join(wsLogDir, "smolcoder.log"), line, "utf8");
    } catch {
      /* Écriture en mode best-effort */
    }
  }
}

/** Lit les N dernières lignes de logs pour l'affichage dans l'interface ou le CLI. */
export function readRecentLogs(maxLines = 200, workspace?: string): string[] {
  let target = GLOBAL_LOG_FILE;
  if (workspace) {
    const wsLog = path.join(workspace, ".smol", "smolcoder.log");
    if (fs.existsSync(wsLog)) target = wsLog;
  }
  if (!fs.existsSync(target)) return [];
  try {
    const content = fs.readFileSync(target, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

// User config (~/.smolcoder.json) and the data directory (~/.smolcoder/) that
// holds saved web sessions and the workspace list. Shared by the CLI entry
// point, the session loop and the web hub.

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Effort } from "./providers/types";
import { Mode } from "./tools/index";

// SMOLCODER_CONFIG points tests at a scratch file so they never touch the
// real one.
export const CONFIG_PATH = process.env.SMOLCODER_CONFIG || path.join(os.homedir(), ".smolcoder.json");
export const DATA_DIR = path.join(os.homedir(), ".smolcoder");

/** Another machine that serves models, added from the model picker. */
export interface SavedHost {
  /** What to connect to: a bare host ("192.168.1.50", "gpu-box.local") means
   * "look for Ollama and LM Studio on their usual ports"; a full URL or
   * host:port names one server exactly. */
  address: string;
  /** Display name; defaults to the host part of the address. */
  name?: string;
}

export interface Config {
  lastModel?: string;
  /** Server the last model ran on — the same model id can exist on several machines. */
  lastModelUrl?: string;
  lastMode?: Mode;
  effort?: Effort | null;
  /** Backend-specific reasoning defaults, with legacy `effort` as fallback. */
  effortByBackend?: Partial<Record<"ollama" | "lmstudio", Effort | null>>;
  hosts?: SavedHost[];
}

export function effortForBackend(cfg: Config, backend: "ollama" | "lmstudio", override?: Effort | null): Effort | null {
  if (override !== undefined) return override;
  const saved = cfg.effortByBackend;
  if (saved && Object.prototype.hasOwnProperty.call(saved, backend)) return saved[backend] ?? null;
  return cfg.effort ?? null;
}

export function loadConfig(): Config {
  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch {
    return { hosts: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    try {
      const backup = `${CONFIG_PATH}.corrupt-${Date.now()}.bak`;
      fs.copyFileSync(CONFIG_PATH, backup);
    } catch {
      /* best effort */
    }
    return { hosts: [] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { hosts: [] };
  }
  const cfg = parsed as Config;
  // Never let bypass be inherited implicitly from a past session — a single
  // shift+tab into it would otherwise silently persist unattended, unchecked
  // command execution into every later run, including headless -p in CI.
  // Requires an explicit flag (-m bypass / --bypass) each time. Old configs
  // saved "write"/"yolo" under the previous mode names.
  if ((cfg as { lastMode?: string }).lastMode === "write") cfg.lastMode = "edit";
  if ((cfg as { lastMode?: string }).lastMode === "yolo" || (cfg as { lastMode?: string }).lastMode === "bypass") cfg.lastMode = "edit";
  if (cfg.lastMode !== undefined && cfg.lastMode !== "ro" && cfg.lastMode !== "edit") {
    delete cfg.lastMode;
  }
  if (cfg.effort !== undefined && cfg.effort !== null && !["off", "low", "medium", "high"].includes(cfg.effort)) {
    delete cfg.effort;
  }
  if (cfg.effortByBackend && typeof cfg.effortByBackend === "object" && !Array.isArray(cfg.effortByBackend)) {
    const saved: Config["effortByBackend"] = {};
    for (const backend of ["ollama", "lmstudio"] as const) {
      if (!Object.prototype.hasOwnProperty.call(cfg.effortByBackend, backend)) continue;
      const value = cfg.effortByBackend[backend];
      if (value === null || (typeof value === "string" && ["off", "low", "medium", "high"].includes(value))) {
        saved[backend] = value as Effort | null;
      }
    }
    if (Object.keys(saved).length) cfg.effortByBackend = saved;
    else delete cfg.effortByBackend;
  } else {
    delete cfg.effortByBackend;
  }
  if (typeof cfg.lastModel !== "string" || !cfg.lastModel.trim()) {
    delete cfg.lastModel;
  }
  if (typeof cfg.lastModelUrl !== "string" || !cfg.lastModelUrl.trim()) {
    delete cfg.lastModelUrl;
  }
  cfg.hosts = Array.isArray(cfg.hosts)
    ? cfg.hosts
        .filter((h: any) => h && typeof h.address === "string" && h.address.trim())
        .map((h: any) => ({ address: h.address.trim(), ...(typeof h.name === "string" && h.name.trim() ? { name: h.name.trim() } : {}) }))
    : [];
  return cfg;
}

export function saveConfig(cfg: Config): void {
  try {
    const dir = path.dirname(CONFIG_PATH);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* best effort */
    }
    const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, CONFIG_PATH);
  } catch {
    /* non-fatal */
  }
}

/** Change some settings and keep the rest. Re-reads the file first: several
 * web sessions share it, and each one only knows about its own fields. */
export function updateConfig(patch: Partial<Config>): Config {
  const next = { ...loadConfig(), ...patch };
  saveConfig(next);
  return next;
}

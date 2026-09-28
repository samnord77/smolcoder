// Self-healing delivery: dist/ is git-ignored, so a synced repo without a
// fresh build silently runs old code (or nothing). Every entry point
// (CLI, TUI, web, desktop, packaged app) calls ensureBuilt() first:
// missing/stale dist triggers one synchronous rebuild, never interactive.
// Pure stdio + fs: safe to require from anywhere, including Electron main.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export function repoRoot(fromDir = __dirname): string {
  return path.resolve(fromDir, "..");
}

export function distIndex(root: string): string {
  return path.join(root, "dist", "index.js");
}

/** "missing" = nothing to run, "stale" = source newer than build,
 * "ok"/"unknown" = run as-is. Never throws. */
export function distState(root: string): "missing" | "stale" | "ok" | "unknown" {
  try {
    const index = distIndex(root);
    if (!fs.existsSync(index)) return "missing";
    const built = fs.statSync(index).mtimeMs;
    let newest = 0;
    const stack = [path.join(root, "src")];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!e.name.startsWith(".")) stack.push(abs);
          continue;
        }
        if (!e.name.endsWith(".ts")) continue;
        try {
          const m = fs.statSync(abs).mtimeMs;
          if (m > newest) newest = m;
        } catch {
          /* ignore */
        }
      }
    }
    return newest > built + 2000 ? "stale" : "ok";
  } catch {
    return "unknown";
  }
}

function npmCandidates(): string[] {
  const out = ["npm", "npm.cmd"];
  try {
    const bases = [process.env.ProgramFiles, "C:\\Program Files", "C:\\Program Files (x86)"];
    for (const base of bases) {
      if (base) out.push(path.join(base, "nodejs", "npm.cmd"));
    }
  } catch {
    /* env unreadable */
  }
  return out;
}

/** Rebuild synchronously. Returns true when dist/index.js exists after.
 * Logs progress through `log`. Never throws. */
export function runBuild(root: string, log: (s: string) => void = () => {}): boolean {
  for (const cmd of npmCandidates()) {
    try {
      log(`building (${cmd} run build)…`);
      const r = spawnSync(cmd, ["run", "build"], {
        cwd: root,
        shell: true,
        timeout: 300000,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      });
      if (!r.error && r.status === 0 && fs.existsSync(distIndex(root))) return true;
    } catch {
      /* next candidate */
    }
  }
  return false;
}

/** Guarantee runnable code, or explain why not. Returns true when dist is
 * usable. Prints what it does (never silent when it builds). */
export function ensureBuilt(root: string, log: (s: string) => void = () => {}): boolean {
  const st = distState(root);
  if (st === "ok" || st === "unknown") return true;
  log(st === "missing" ? "first build (dist/ is git-ignored)…" : "sources changed since last build — rebuilding…");
  if (runBuild(root, log) && fs.existsSync(distIndex(root))) {
    log("build OK.");
    return true;
  }
  return false;
}

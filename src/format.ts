// Pro formatter: one-click code formatting through the toolchain the
// project already uses (prettier, black/ruff, rustfmt, gofmt). Never
// reformats with guesses — if no formatter is installed, the answer is the
// exact install command, not a half-formatted file. Never throws.
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { resolveInWorkspace } from "./sandbox";
import { resolveCommand } from "./mcp";

const FORMAT_TIMEOUT_MS = 30_000;
const MAX_FILE_BYTES = 1024 * 1024;

export interface FormatAttempt {
  cmd: string[];
  installHint: string;
}

function attemptsFor(ext: string): FormatAttempt[] {
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
    case ".mts":
    case ".cts":
    case ".json":
      return [
        { cmd: ["npx", "--no-install", "prettier", "--write"], installHint: "npm i -D prettier" },
        { cmd: ["prettier", "--write"], installHint: "npm i -g prettier (or npm i -D prettier)" },
      ];
    case ".py":
      return [
        { cmd: ["black", "--quiet"], installHint: "pip install black" },
        { cmd: ["ruff", "format"], installHint: "pip install ruff" },
      ];
    case ".rs":
      return [{ cmd: ["rustfmt"], installHint: "rustup component add rustfmt" }];
    case ".go":
      return [{ cmd: ["gofmt", "-w"], installHint: "install the Go toolchain (https://go.dev)" }];
    default:
      return [];
  }
}

function runFormatter(root: string, cmd: string[], abs: string): { code: number; out: string } {
  const exe = resolveCommand(cmd[0]);
  const res = spawnSync(exe, [...cmd.slice(1), abs], {
    cwd: root,
    encoding: "utf8",
    timeout: FORMAT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  if (res.error) throw res.error;
  return { code: res.status ?? 1, out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() };
}

export interface FormatResult {
  ok: boolean;
  message: string;
}

/** Format one workspace file in place. Returns success or a coaching
 * message with the install command. Reads the file back so callers can
 * record undo. */
export function formatFile(root: string, relPath: string): FormatResult {
  let abs: string;
  try {
    abs = resolveInWorkspace(root, relPath);
  } catch (err: any) {
    return { ok: false, message: `Error: ${err?.message ?? err}` };
  }
  const ext = path.extname(abs).toLowerCase();
  const attempts = attemptsFor(ext);
  if (!attempts.length) {
    return {
      ok: false,
      message: `Error: no formatter supported for "${ext}" — format works on .ts, .tsx, .js, .jsx, .py, .rs, .go, .json.`,
    };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { ok: false, message: `Error: file "${relPath}" does not exist.` };
  }
  if (!stat.isFile()) return { ok: false, message: `Error: "${relPath}" is a folder, not a file.` };
  if (stat.size > MAX_FILE_BYTES) return { ok: false, message: `Error: "${relPath}" is too large to format (1 MB limit).` };

  let before = "";
  try {
    before = fs.readFileSync(abs, "utf8");
  } catch {
    return { ok: false, message: `Error: could not read "${relPath}".` };
  }
  let missing = "";
  for (const attempt of attempts) {
    let r: { code: number; out: string };
    try {
      r = runFormatter(root, attempt.cmd, abs);
    } catch (err: any) {
      if ((err as any)?.code === "ENOENT") {
        missing = attempt.installHint;
        continue;
      }
      return { ok: false, message: `Error: formatter crashed (${String(err?.message ?? err).slice(0, 200)}).` };
    }
    if (r.code !== 0) {
      const first = r.out.split("\n").filter(Boolean).slice(0, 3).join("\n");
      return { ok: false, message: `Error: the formatter refused "${relPath}" (syntax error?).\n${first.slice(0, 400)}` };
    }
    let after = before;
    try {
      after = fs.readFileSync(abs, "utf8");
    } catch {
      /* keep before */
    }
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (after === before) return { ok: true, message: `"${rel}" is already perfectly formatted — nothing changed.` };
    return { ok: true, message: `"${rel}" formatted with ${attempt.cmd[0]}. Re-read it before continuing.` };
  }
  return {
    ok: false,
    message: `Error: no formatter installed for "${ext}". Install once with: ${missing || attempts[0].installHint}`,
  };
}

export function formattersStatus(): string {
  const probes: Array<[string, string[]]> = [
    ["prettier (JS/TS/JSON)", ["prettier", "--version"]],
    ["black (Python)", ["black", "--version"]],
    ["ruff (Python)", ["ruff", "--version"]],
    ["rustfmt (Rust)", ["rustfmt", "--version"]],
    ["gofmt (Go)", ["gofmt", "--help"]],
  ];
  return probes
    .map(([name, cmd]) => {
      try {
        const exe = resolveCommand(cmd[0]);
        const r = spawnSync(exe, cmd.slice(1), { encoding: "utf8", timeout: 10_000, windowsHide: true });
        if (r.status === 0 || (name.startsWith("gofmt") && (r.status ?? 1) <= 2)) return `✓ ${name}`;
        return `✗ ${name} (failed to run)`;
      } catch {
        return `✗ ${name} (not installed)`;
      }
    })
    .join("\n");
}

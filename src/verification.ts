import * as fs from "fs";
import { resolveInWorkspace } from "./sandbox";

/** A repeat hint only: timings, coordinates and stack line numbers may vary.
 * The original output remains the evidence presented to the model. */
export function failureSignature(output: string): string {
  return output.replace(/\x1b\[[0-9;]*m/g, "").replace(/\d+(?:\.\d+)?/g, "#").replace(/\s+/g, " ").trim();
}

/** Conventional project checks, without executing or interpolating package data.
 * Caller-owned acceptance commands take precedence in the final gate. */
export function projectVerification(workspace: string): string | undefined {
  let file: string;
  try { file = resolveInWorkspace(workspace, "package.json"); } catch { return; }
  if (!fs.existsSync(file)) return;
  try {
    if (fs.statSync(file).size > 1024 * 1024) return "npm run build --if-present";
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return;
    const scripts = (data as { scripts?: unknown }).scripts;
    if (!scripts || typeof scripts !== "object") return;
    const commands = ["build", "test", "test:e2e"].filter(name => typeof (scripts as Record<string, unknown>)[name] === "string" && String((scripts as Record<string, unknown>)[name]).trim())
      .map(name => `npm run ${name}`);
    return commands.length ? commands.join(" && ") : undefined;
  } catch {
    // npm reports malformed package metadata precisely; never silently bless it.
    return "npm run build --if-present";
  }
}

/** Split a `cmd1 && cmd2` chain without breaking quoted `&&` (ex: `node -e "a && b"`).
 * Only `&&` outside single, double and backtick quotes separates commands. */
export function splitVerification(command: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      cur += ch;
      if (ch === "\\" && i + 1 < command.length) {
        cur += command[++i];
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "&" && command[i + 1] === "&") {
      parts.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts.filter(Boolean);
}

/** Merge several verification chains, keeping each step once, in order. */
export function mergeVerificationCommands(...cmds: (string | undefined)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of cmds) {
    if (!c) continue;
    for (const p of splitVerification(c)) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
  }
  return out.join(" && ");
}

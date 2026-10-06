// Custom slash commands: plain .md files in <workspace>/.smol/commands/
// (yours) or .smol/ecc-commands/ (installed by scripts/ecc-smol-install.cjs).
// Any "/name" the built-in switch does not handle resolves here and is sent
// to the model as a prompt, so the terminal, the web hub and Electron get
// the behaviour from one place.

import * as fs from "node:fs";
import * as path from "node:path";
import type { SlashCommand } from "./ui";

const NAME_RE = /^[A-Za-z0-9_-]{1,60}$/;
const DIRS = [".smol/commands", ".smol/ecc-commands"] as const;
const DESC_CAP = 100;
const HEAD_BYTES = 4096;

/** Frontmatter + body of a command file. `desc` falls back to the first
 * meaningful line so a hand-written file with no frontmatter still gets a
 * readable menu entry. */
export function split(raw: string): { desc: string; body: string } {
  const text = raw.replace(/^\uFEFF/, "");
  let desc = "";
  let body = text;
  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (fm) {
    body = text.slice(fm[0].length);
    const d = /^[ \t]*description:[ \t]*(.+)$/m.exec(fm[1]);
    if (d) desc = d[1].trim().replace(/^["']|["']$/g, "");
  }
  if (!desc) {
    const line = body.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
    desc = line.replace(/^#+\s*/, "").trim();
  }
  return { desc: desc.slice(0, DESC_CAP), body: body.trim() };
}

/** First bytes only: the menu reads 94+ files once per session start. */
function readHead(file: string): string {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.toString("utf8", 0, n);
  } finally {
    fs.closeSync(fd);
  }
}

/** Every custom command in the workspace, sorted, no duplicates
 * (`.smol/commands` wins over `.smol/ecc-commands`). */
export function listCustomCommands(workspace: string): SlashCommand[] {
  const seen = new Map<string, SlashCommand>();
  for (const dir of DIRS) {
    let entries: string[];
    try {
      entries = fs.readdirSync(path.join(workspace, dir));
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".md")) continue;
      const name = entry.slice(0, -3);
      if (!NAME_RE.test(name) || seen.has(name)) continue;
      try {
        const { desc } = split(readHead(path.join(workspace, dir, entry)));
        seen.set(name, { name, desc });
      } catch {
        /* unreadable file: leave it out of the menu */
      }
    }
  }
  return [...seen.values()];
}

/** Body of one command, arguments appended; null when the name is invalid
 * or no file matches (the caller then reports an unknown command). */
export function loadCustomCommand(workspace: string, name: string, args = ""): string | null {
  if (!NAME_RE.test(name)) return null;
  for (const dir of DIRS) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(workspace, dir, `${name}.md`), "utf8");
    } catch {
      continue;
    }
    const { body } = split(raw);
    if (!body) return null;
    const extra = args.trim();
    return extra ? `${body}\n\nArguments de l'utilisateur : ${extra}` : body;
  }
  return null;
}

/** Resolve one raw user line for the headless `-p` path: a "/name ..." the
 * built-in loop would route becomes the command body, anything else passes
 * through untouched. */
export function resolveSlashPrompt(workspace: string, input: string): string {
  if (!input.startsWith("/")) return input;
  const [cmd, ...rest] = input.slice(1).split(/\s+/);
  return loadCustomCommand(workspace, cmd, rest.join(" ")) ?? input;
}

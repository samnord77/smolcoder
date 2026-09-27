// Pro Git integration for the agent: status, diff, log, blame, branch
// (read-only) plus stage and commit (edit modes only). Everything runs the
// real `git` CLI in the workspace with tight timeouts and output caps, so
// results are always truthful — never guessed. Failures are coaching
// strings, never throws.
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { resolveInWorkspace } from "./sandbox";

const GIT_TIMEOUT_MS = 30_000;
const OUTPUT_CAP = 8000;

export interface GitRun {
  code: number;
  out: string;
}

function cap(s: string): string {
  if (s.length <= OUTPUT_CAP) return s;
  return s.slice(0, OUTPUT_CAP) + `\n… (truncated, ${s.length - OUTPUT_CAP} more chars)`;
}

/** Exported for tests: run git with args in root, capture output. */
export function runGit(root: string, args: string[]): GitRun {
  let res: ReturnType<typeof spawnSync>;
  try {
    res = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err: any) {
    return { code: 1, out: `Error: could not run git (${err?.message ?? err}). Install git and put it on PATH.` };
  }
  const err = res.error as any;
  if (err) {
    if (err.code === "ENOENT") {
      return { code: 1, out: "Error: git is not installed or not on PATH. Install git first (https://git-scm.com)." };
    }
    return { code: 1, out: `Error: git failed to run (${err?.message ?? err}).` };
  }
  const text = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  return { code: res.status ?? 1, out: cap(text) };
}

export function isGitRepo(root: string): boolean {
  try {
    if (!fs.statSync(root).isDirectory()) return false;
  } catch {
    return false;
  }
  const r = runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.out.trim() === "true";
}

function needRepo(root: string): string | null {
  if (!isGitRepo(root)) {
    return 'Error: this workspace is not a git repository. Start one with run_command {"command": "git init"} (or open a folder that already is one).';
  }
  return null;
}

export function gitStatus(root: string): string {
  const blocked = needRepo(root);
  if (blocked) return blocked;
  const branch = runGit(root, ["branch", "--show-current"]);
  const short = runGit(root, ["status", "--short", "--branch"]);
  if (short.code !== 0) return `Error: git status failed (${short.out.slice(0, 200)}).`;
  const head = branch.code === 0 && branch.out ? `On branch ${branch.out}` : "Detached HEAD";
  const body = short.out.trim();
  if (!body || body === `## ${branch.out}`) return `${head}\nWorking tree clean — nothing to commit.`;
  return `${head}\n${body}`;
}

export function gitDiff(root: string, opts?: { staged?: boolean; path?: string; stat?: boolean }): string {
  const blocked = needRepo(root);
  if (blocked) return blocked;
  const args = ["diff", "--no-color", "--no-ext-diff"];
  if (opts?.stat) args.push("--stat");
  if (opts?.staged) args.push("--cached");
  if (opts?.path) {
    try {
      const abs = resolveInWorkspace(root, opts.path);
      args.push("--", path.relative(root, abs) || ".");
    } catch (err: any) {
      return `Error: ${err?.message ?? err}`;
    }
  }
  const r = runGit(root, args);
  if (r.code !== 0) return `Error: git diff failed (${r.out.slice(0, 200)}).`;
  if (!r.out.trim()) return opts?.staged ? "Nothing staged — the staging area is empty." : "No uncommitted changes — working tree matches HEAD.";
  return r.out;
}

export function gitLog(root: string, count = 10): string {
  const blocked = needRepo(root);
  if (blocked) return blocked;
  const n = Math.min(Math.max(1, Math.floor(count) || 10), 50);
  const r = runGit(root, ["log", `--max-count=${n}`, "--pretty=format:%h %ad %an %s", "--date=short"]);
  if (r.code !== 0) return `Error: git log failed (${r.out.slice(0, 200)}).`;
  return r.out.trim() || "No commits yet.";
}

export function gitBlame(root: string, relPath: string, line?: number): string {
  const blocked = needRepo(root);
  if (blocked) return blocked;
  let abs: string;
  try {
    abs = resolveInWorkspace(root, relPath);
  } catch (err: any) {
    return `Error: ${err?.message ?? err}`;
  }
  const rel = path.relative(root, abs) || ".";
  const args = ["blame", "--line-porcelain", "-L", line ? `${line},${line}` : "1,+15", "--", rel];
  const r = runGit(root, args);
  if (r.code !== 0) return `Error: git blame failed (${r.out.slice(0, 300)}). The file may be untracked — commit it first.`;
  // Porcelain is verbose: compress to "commit author date | line".
  const out: string[] = [];
  let hash = "";
  let author = "";
  let date = "";
  let content = "";
  for (const ln of r.out.split("\n")) {
    if (/^[0-9a-f]{40} /.test(ln)) {
      if (content) out.push(`${hash.slice(0, 7)} ${author} ${date} | ${content}`);
      hash = ln.slice(0, 40);
      author = "";
      date = "";
      content = "";
    } else if (ln.startsWith("author ")) author = ln.slice(7, 27);
    else if (ln.startsWith("author-time ")) {
      const t = Number(ln.slice(12)) * 1000;
      date = Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
    } else if (ln.startsWith("\t")) content = ln.slice(1, 160);
  }
  if (content) out.push(`${hash.slice(0, 7)} ${author} ${date} | ${content}`);
  return out.slice(0, 15).join("\n") || "No blame info.";
}

export function gitBranch(root: string): string {
  const blocked = needRepo(root);
  if (blocked) return blocked;
  const r = runGit(root, ["branch", "-vv"]);
  if (r.code !== 0) return `Error: git branch failed (${r.out.slice(0, 200)}).`;
  return r.out.trim() || "No branches.";
}

export function gitStage(root: string, paths: string[]): string {
  const blocked = needRepo(root);
  if (blocked) return blocked;
  if (!paths.length) return 'Error: stage needs at least one path. Example: {"action": "stage", "path": "src/agent.ts"} (use "." for everything).';
  const safe: string[] = [];
  for (const p of paths) {
    try {
      const abs = resolveInWorkspace(root, p);
      safe.push(path.relative(root, abs) || ".");
    } catch (err: any) {
      return `Error: ${err?.message ?? err}`;
    }
  }
  const r = runGit(root, ["add", "--", ...safe]);
  if (r.code !== 0) return `Error: git add failed (${r.out.slice(0, 300)}).`;
  return `Staged: ${safe.join(", ")}. Review with {"action": "diff", "staged": true} before committing.`;
}

export function gitCommit(root: string, message: string): string {
  const blocked = needRepo(root);
  if (blocked) return blocked;
  const msg = message.trim().slice(0, 500);
  if (!msg) return 'Error: commit needs a message. Example: {"action": "commit", "message": "Fix login retry loop"}';
  const staged = runGit(root, ["diff", "--cached", "--name-only"]);
  if (staged.code !== 0) return `Error: could not inspect the staging area (${staged.out.slice(0, 200)}).`;
  if (!staged.out.trim()) {
    return 'Error: nothing staged — stage files first with {"action": "stage", "path": "."}. Never commit blind.';
  }
  const r = runGit(root, ["commit", "-m", msg]);
  if (r.code !== 0) return `Error: git commit failed (${r.out.slice(0, 400)}).`;
  return r.out.split("\n").slice(0, 4).join("\n");
}

// ---------------------------------------------------------------------------
// Hunk-level review: stage or revert one hunk without touching the rest.
// Powers the web review tab and any agent flow that must not commit blind.
// ---------------------------------------------------------------------------

export interface DiffHunk {
  index: number;
  header: string;
  lines: string[];
}

export interface FileDiff {
  file: string;
  hunks: DiffHunk[];
}

const MAX_DIFF_FILES = 20;
const MAX_HUNKS_PER_FILE = 50;

/** Split `git diff -U3` output into per-file hunks. Pure (exported for tests). */
export function parseDiffHunks(diffText: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let curHunk: DiffHunk | null = null;
  const pushHunk = () => {
    if (cur && curHunk) {
      if (cur.hunks.length < MAX_HUNKS_PER_FILE) cur.hunks.push(curHunk);
      curHunk = null;
    }
  };
  for (const line of String(diffText ?? "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      pushHunk();
      const m = / b\/(.+)$/.exec(line);
      const file = m ? m[1] : line.slice(0, 80);
      cur = { file, hunks: [] };
      if (files.length < MAX_DIFF_FILES) files.push(cur);
      else cur = null; // cap reached: keep parsing cheaply, keep nothing
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("@@ ")) {
      pushHunk();
      curHunk = { index: cur.hunks.length, header: line.slice(0, 120), lines: [] };
      continue;
    }
    if (curHunk && curHunk.lines.length < 200) curHunk.lines.push(line.slice(0, 300));
  }
  pushHunk();
  return files.filter((f) => f.hunks.length > 0);
}

/** Rebuild the "diff --git / index / --- / +++" header of one file so a
 * single-hunk patch applies cleanly. Pure (exported for tests). */
export function fileHeaderFor(diffText: string, file: string): string[] {
  const out: string[] = [];
  let inFile = false;
  for (const line of String(diffText ?? "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = / b\/(.+)$/.exec(line);
      inFile = !!m && m[1] === file;
      if (inFile) out.push(line);
      continue;
    }
    if (!inFile) continue;
    if (line.startsWith("@@ ")) break;
    out.push(line);
  }
  return out;
}

function applyPatch(root: string, args: string[], patch: string): GitRun {
  try {
    const res = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      input: patch,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    const err = res.error as any;
    if (err) {
      if (err.code === "ENOENT") return { code: 1, out: "Error: git is not installed or not on PATH." };
      return { code: 1, out: `Error: git apply failed to run (${err?.message ?? err}).` };
    }
    return { code: res.status ?? 1, out: cap(`${res.stdout ?? ""}${res.stderr ?? ""}`.trim()) };
  } catch (err: any) {
    return { code: 1, out: `Error: git apply crashed (${err?.message ?? err}).` };
  }
}

export interface DiffFilesResult {
  files: FileDiff[];
  note: string;
}

/** Uncommitted changes, file by file with hunks, plus untracked files called
 * out separately (git diff cannot show them). Never throws. */
export function gitDiffFiles(root: string, staged = false): DiffFilesResult {
  const empty = (note: string): DiffFilesResult => ({ files: [], note });
  if (!isGitRepo(root)) return empty("Not a git repository — start one to review changes hunk by hunk.");
  const args = ["diff", "--no-color", "--no-ext-diff", "-U3"];
  if (staged) args.push("--cached");
  const r = runGit(root, args);
  if (r.code !== 0) return empty(`Error: git diff failed (${r.out.slice(0, 200)}).`);
  const files = parseDiffHunks(r.out);
  let note = "";
  if (!staged) {
    const st = runGit(root, ["status", "--short"]);
    if (st.code === 0) {
      const untracked = st.out
        .split("\n")
        .filter((l) => l.startsWith("??"))
        .map((l) => l.slice(3).trim())
        .filter(Boolean)
        .slice(0, 10);
      if (untracked.length) {
        note = `Untracked (not in the diff — stage the file to review it): ${untracked.join(", ")}`;
      }
    }
  }
  if (!files.length && !note) {
    return empty(staged ? "Nothing staged." : "No uncommitted changes — working tree matches HEAD.");
  }
  return { files, note };
}

/** Stage or revert exactly one hunk. The patch is rebuilt from a fresh diff
 * so a changed file fails loudly instead of applying the wrong hunk. Never
 * throws. */
export function gitApplyHunk(root: string, file: string, index: number, action: "stage" | "revert"): string {
  if (!isGitRepo(root)) return "Error: this workspace is not a git repository.";
  if (typeof file !== "string" || !file || file.includes("..")) {
    return "Error: a file path inside the repository is required.";
  }
  const idx = Math.floor(Number(index));
  if (!Number.isSafeInteger(idx) || idx < 0) {
    return "Error: hunk must be the hunk number from the review (starting at 0).";
  }
  if (action !== "stage" && action !== "revert") {
    return 'Error: action must be "stage" or "revert".';
  }
  const full = runGit(root, ["diff", "--no-color", "--no-ext-diff", "-U3", "--", file]);
  if (full.code !== 0) return `Error: git diff failed (${full.out.slice(0, 200)}).`;
  const parsed = parseDiffHunks(full.out).find((f) => f.file === file);
  const hunk = parsed?.hunks[idx];
  if (!hunk) return `Error: hunk ${idx} no longer exists for "${file}" — refresh the review, the file changed.`;
  const patch = [...fileHeaderFor(full.out, file), hunk.header, ...hunk.lines].join("\n") + "\n";
  const args = action === "stage" ? ["apply", "--cached", "-"] : ["apply", "-R", "-"];
  const r = applyPatch(root, args, patch);
  if (r.code !== 0) {
    return `Error: git could not ${action} that hunk (${r.out.slice(0, 300)}). The file probably changed — refresh the review.`;
  }
  return action === "stage" ? `Staged hunk ${idx} of "${file}".` : `Reverted hunk ${idx} of "${file}".`;
}

export interface GitQuery {
  action?: unknown;
  path?: unknown;
  message?: unknown;
  count?: unknown;
  line?: unknown;
  staged?: unknown;
  stat?: unknown;
  hunk?: unknown;
}

const READ_ACTIONS = new Set(["status", "diff", "log", "blame", "branch", "review"]);

export const GIT_ACTIONS = ["status", "diff", "log", "blame", "branch", "stage", "commit", "review", "stage_hunk", "revert_hunk"];

/** Render hunk review as capped text for the agent. */
export function formatReview(root: string, staged = false): string {
  const { files, note } = gitDiffFiles(root, staged);
  const out: string[] = [];
  if (note) out.push(note);
  for (const f of files) {
    out.push(`--- ${f.file} (${f.hunks.length} hunk(s)) ---`);
    for (const h of f.hunks) {
      out.push(`hunk ${h.index}: ${h.header}`);
      for (const l of h.lines.slice(0, 40)) out.push(l);
    }
  }
  const text = out.join("\n");
  if (text.length > 6000) return text.slice(0, 6000) + "\n… (truncated — review one file at a time)";
  return text;
}

/** Answer one git question. stage/commit/stage_hunk/revert_hunk need
 * canWrite (edit modes); the rest read. Never throws. */
export function queryGit(root: string, args: GitQuery, opts?: { canWrite?: boolean }): string {
  const action = String(args.action ?? "");
  if (!GIT_ACTIONS.includes(action)) {
    return `Error: action must be one of ${GIT_ACTIONS.map((a) => `"${a}"`).join(", ")}. Example: {"action": "status"}`;
  }
  if (!READ_ACTIONS.has(action) && opts?.canWrite === false) {
    return `Error: "${action}" changes the repository — unavailable in read-only mode. Switch to edit mode first.`;
  }
  switch (action) {
    case "status":
      return gitStatus(root);
    case "diff":
      return gitDiff(root, {
        staged: args.staged === true,
        stat: args.stat === true,
        path: typeof args.path === "string" ? args.path : undefined,
      });
    case "log":
      return gitLog(root, Number(args.count) || 10);
    case "blame": {
      const rel = typeof args.path === "string" ? args.path : "";
      if (!rel) return 'Error: blame needs a path. Example: {"action": "blame", "path": "src/agent.ts", "line": 42}';
      const ln = Number(args.line);
      return gitBlame(root, rel, Number.isSafeInteger(ln) && ln >= 1 ? ln : undefined);
    }
    case "branch":
      return gitBranch(root);
    case "stage": {
      const raw = typeof args.path === "string" ? args.path : "";
      const paths = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return gitStage(root, paths);
    }
    case "commit":
      return gitCommit(root, typeof args.message === "string" ? args.message : "");
    case "review":
      return formatReview(root, args.staged === true);
    case "stage_hunk":
      return gitApplyHunk(root, typeof args.path === "string" ? args.path : "", Number(args.hunk), "stage");
    case "revert_hunk":
      return gitApplyHunk(root, typeof args.path === "string" ? args.path : "", Number(args.hunk), "revert");
    default:
      return `Error: action must be one of ${GIT_ACTIONS.map((a) => `"${a}"`).join(", ")}.`;
  }
}

// Pro Git integration for the agent: status, diff, log, blame, branch
// (read-only) plus stage and commit (edit modes only). Everything runs the
// real `git` CLI in the workspace with tight timeouts and output caps, so
// results are always truthful — never guessed. Failures are coaching
// strings, never throws.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveInWorkspace } from "./sandbox";

const GIT_TIMEOUT_MS = 30_000;
const OUTPUT_CAP = 8000;

export interface GitRun {
  code: number;
  out: string;
}

function cap(s: string): string {
  if (s.length <= OUTPUT_CAP) return s;
  return `${s.slice(0, OUTPUT_CAP)}\n… (truncated, ${s.length - OUTPUT_CAP} more chars)`;
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
  if (!r.out.trim())
    return opts?.staged ? "Nothing staged — the staging area is empty." : "No uncommitted changes — working tree matches HEAD.";
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
  if (!paths.length)
    return 'Error: stage needs at least one path. Example: {"action": "stage", "path": "src/agent.ts"} (use "." for everything).';
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

/** Take paths back out of the staging area. The index is reset to HEAD; the
 * working tree is never touched, so nothing the user wrote is lost. On a repo
 * with no commit yet there is no HEAD to reset to — those paths are dropped
 * from the empty index instead. */
export function gitUnstage(root: string, paths: string[]): string {
  const blocked = needRepo(root);
  if (blocked) return blocked;
  if (!paths.length)
    return 'Error: unstage needs at least one path. Example: {"action": "unstage", "path": "src/agent.ts"} (use "." for everything).';
  const safe: string[] = [];
  for (const p of paths) {
    try {
      const abs = resolveInWorkspace(root, p);
      safe.push(path.relative(root, abs) || ".");
    } catch (err: any) {
      return `Error: ${err?.message ?? err}`;
    }
  }
  const staged = runGit(root, ["diff", "--cached", "--name-only", "--", ...safe]);
  if (staged.code !== 0) return `Error: could not inspect the staging area (${staged.out.slice(0, 200)}).`;
  if (!staged.out.trim()) return `Nothing staged for ${safe.join(", ")} — the index already matches HEAD there.`;
  let r = runGit(root, ["reset", "-q", "HEAD", "--", ...safe]);
  if (r.code !== 0) {
    // No commit yet: reset has no HEAD to point at. Drop the paths from the
    // empty index instead (git rm --cached leaves the working tree alone).
    r = runGit(root, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...safe]);
  }
  if (r.code !== 0) return `Error: git could not unstage (${r.out.slice(0, 300)}).`;
  return `Unstaged: ${safe.join(", ")}. The working tree keeps every change.`;
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
  status?: "A" | "D" | "M" | "R";
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
    // Unified-diff bodies hold only " ", "+", "-", "\\" lines (a blank
    // context line arrives as " ", never ""). Anything else — a bare ""
    // from splitting, or git's CRLF warning glued from stderr — is not
    // diff content; keeping it corrupts counts and patches alike.
    if (curHunk && curHunk.lines.length < 200) {
      const c = line[0];
      if (c === " " || c === "+" || c === "-" || c === "\\") curHunk.lines.push(line.slice(0, 300));
    }
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

/** git stdout WITHOUT runGit's trim and 8 KB cap — staging needs
 * byte-exact file content — and stderr kept out so a warning can never
 * corrupt a patch. Never throws. */
function gitStdout(root: string, args: string[]): GitRun {
  try {
    const res = spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    const err = res.error as any;
    if (err) {
      if (err.code === "ENOENT") return { code: 1, out: "Error: git is not installed or not on PATH." };
      return { code: 1, out: `Error: git failed to run (${err?.message ?? err}).` };
    }
    const code = res.status ?? 1;
    const stdout = res.stdout ?? "";
    if (code !== 0 && !stdout) return { code, out: (res.stderr ?? "").trim() || `git exited with code ${code}.` };
    return { code, out: stdout };
  } catch (err: any) {
    return { code: 1, out: `Error: git failed (${err?.message ?? err}).` };
  }
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
        // Include untracked files as 'A' (added) with full content as additions
        for (const u of untracked) {
          try {
            const content = fs.readFileSync(path.join(root, u), "utf8");
            const lines = content.split("\n").filter(l => l.length > 0);
            const hunkLines = lines.map((l) => `+${l}`);
            files.push({
              file: u,
              status: "A",
              hunks: [{
                index: 0,
                header: `new file mode 100644`,
                lines: hunkLines
              }]
            });
          } catch {
            // If file can't be read, add entry without hunks
            files.push({ file: u, status: "A", hunks: [] });
          }
        }
        note = `Untracked (shown as A — stage to review): ${untracked.join(", ")}`;
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
export function gitApplyHunk(root: string, file: string, index: number, action: "stage" | "revert" | "unstage"): string {
  if (!isGitRepo(root)) return "Error: this workspace is not a git repository.";
  if (typeof file !== "string" || !file || file.includes("..")) {
    return "Error: a file path inside the repository is required.";
  }
  const idx = Math.floor(Number(index));
  if (!Number.isSafeInteger(idx) || idx < 0) {
    return "Error: hunk must be the hunk number from the review (starting at 0).";
  }
  if (action !== "stage" && action !== "revert" && action !== "unstage") {
    return 'Error: action must be "stage", "unstage" or "revert".';
  }
  // Unstaging reads what the index holds; staging and reverting read the
  // working tree — the two diffs git keeps side by side.
  const head = action === "unstage" ? ["diff", "--cached"] : ["diff"];
  const full = runGit(root, [...head, "--no-color", "--no-ext-diff", "-U3", "--", file]);
  if (full.code !== 0) return `Error: git diff failed (${full.out.slice(0, 200)}).`;
  const parsed = parseDiffHunks(full.out).find((f) => f.file === file);
  const hunk = parsed?.hunks[idx];
  if (!hunk) {
    return action === "unstage"
      ? `Error: hunk ${idx} is not staged for "${file}" — refresh the review.`
      : `Error: hunk ${idx} no longer exists for "${file}" — refresh the review, the file changed.`;
  }
  const patch = `${[...fileHeaderFor(full.out, file), hunk.header, ...hunk.lines].join("\n")}\n`;
  const args =
    action === "stage" ? ["apply", "--cached", "-"] : action === "unstage" ? ["apply", "-R", "--cached", "-"] : ["apply", "-R", "-"];
  const r = applyPatch(root, args, patch);
  if (r.code !== 0) {
    return `Error: git could not ${action} that hunk (${r.out.slice(0, 300)}). The file probably changed — refresh the review.`;
  }
  if (action === "stage") return `Staged hunk ${idx} of "${file}".`;
  if (action === "unstage") return `Unstaged hunk ${idx} of "${file}". The working tree keeps the change.`;
  return `Reverted hunk ${idx} of "${file}".`;
}

/** Rewrite a hunk header with recounts after filtering lines (git apply
 * verifies counts, so a filtered patch must be honest). Pure. */
export function rewriteHunkHeader(header: string, keptDel: number, keptAdd: number, keptCtx: number): string {
  const m = /^(@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@)(.*)$/.exec(header);
  if (!m) return header;
  return `@@ -${m[2]},${keptCtx + keptDel} +${m[4]},${keptCtx + keptAdd} @@${m[6]}`;
}

/** Rebuild what the index should hold after staging only `sel` change
 * lines of hunk `targetIdx` (indices into each hunk's `lines`). Within one
 * change block: staged additions land first, then deletions that are NOT
 * staged (they stay put). Hunks outside the selection keep the index as-is.
 * Pure (exported for tests). */
export function stagedContentFrom(base: string, hunks: DiffHunk[], targetIdx: number, sel: Set<number>): string {
  const src = base.split("\n");
  const out: string[] = [];
  let o = 0;
  for (let hi = 0; hi < hunks.length; hi++) {
    const h = hunks[hi];
    const m = /^@@ -(\d+)/.exec(h.header);
    const start = m ? Math.max(0, Number(m[1]) - 1) : o;
    while (o < start && o < src.length) out.push(src[o++]);
    const active = hi === targetIdx ? sel : null;
    const lines = h.lines;
    let i = 0;
    while (i < lines.length) {
      const c = lines[i][0];
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === "-") {
        const minus: number[] = [];
        const plus: number[] = [];
        while (i < lines.length && (lines[i][0] === "-" || lines[i][0] === "+")) {
          (lines[i][0] === "-" ? minus : plus).push(i);
          i++;
        }
        const added: string[] = [];
        const kept: string[] = [];
        for (const j of minus) {
          if (active?.has(j)) o++;
          else kept.push(src[o++] ?? "");
        }
        for (const j of plus) if (active?.has(j)) added.push(lines[j].slice(1));
        out.push(...added, ...kept);
        continue;
      }
      if (c === "+") {
        if (active?.has(i)) out.push(lines[i].slice(1));
        i++;
        continue;
      }
      out.push(src[o++] ?? "");
      i++;
    }
  }
  while (o < src.length) out.push(src[o++]);
  return out.join("\n");
}

/** Diff two exact strings via git (temp files) and return only the hunk
 * body — git computes positions and counts itself, nothing is hand-counted.
 * code 0 = body in out, code 1 + empty out = strings are identical,
 * code 2 = error message in out. Never throws. */
function stagedPatchBody(root: string, from: string, to: string): GitRun {
  let tmp = "";
  try {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smol-stage-"));
    const a = path.join(tmp, "index");
    const b = path.join(tmp, "staged");
    fs.writeFileSync(a, from, "utf8");
    fs.writeFileSync(b, to, "utf8");
    const d = gitStdout(root, ["diff", "--no-color", "--no-ext-diff", "-U3", "--no-index", "--", a, b]);
    if (d.code > 1) return { code: 2, out: `Error: could not build the staged patch (${d.out.slice(0, 200)}).` };
    const lines = d.out.split("\n");
    const at = lines.findIndex((l) => l.startsWith("@@"));
    if (at < 0) return { code: 1, out: "" };
    return { code: 0, out: lines.slice(at).join("\n").replace(/\n+$/, "") };
  } catch (err: any) {
    return { code: 2, out: `Error: could not compute the staged patch (${err?.message ?? err}).` };
  } finally {
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

/** Stage only the selected change lines of one hunk (indices into
 * hunk.lines). The index content is rebuilt from the selection first, then
 * git computes the patch itself — positions are always honest, never
 * hand-counted. Never throws. */
export function gitStageLines(root: string, file: string, index: number, selected: number[]): string {
  if (!isGitRepo(root)) return "Error: this workspace is not a git repository.";
  if (typeof file !== "string" || !file || file.includes("..")) {
    return "Error: a file path inside the repository is required.";
  }
  const idx = Math.floor(Number(index));
  if (!Number.isSafeInteger(idx) || idx < 0) {
    return "Error: hunk must be the hunk number from the review (starting at 0).";
  }
  const sel = new Set((Array.isArray(selected) ? selected : []).map(Number).filter((n) => Number.isSafeInteger(n) && n >= 0));
  if (!sel.size) return "Error: select at least one + or - line to stage.";
  const full = runGit(root, ["diff", "--no-color", "--no-ext-diff", "-U3", "--", file]);
  if (full.code !== 0) return `Error: git diff failed (${full.out.slice(0, 200)}).`;
  const parsed = parseDiffHunks(full.out).find((f) => f.file === file);
  const hunk = parsed && idx < parsed.hunks.length ? parsed.hunks[idx] : undefined;
  if (!parsed || !hunk) return `Error: hunk ${idx} no longer exists for "${file}" — refresh the review, the file changed.`;
  if (parsed.hunks.some((h) => h.lines.length >= 200)) {
    return `Error: a hunk of "${file}" is too big for line-by-line staging — stage the whole hunk or the whole file instead.`;
  }
  const picked = hunk.lines.reduce((n, l, j) => n + (sel.has(j) && (l[0] === "-" || l[0] === "+") ? 1 : 0), 0);
  if (!picked) {
    return "Error: none of the selected lines are +/- lines (or the file changed) — refresh the review.";
  }
  const baseRun = gitStdout(root, ["show", `:${file}`]);
  if (baseRun.code !== 0) {
    return `Error: "${file}" is not in the index yet — stage the whole file first (${baseRun.out.slice(0, 160)}).`;
  }
  const base = baseRun.out;
  const next = stagedContentFrom(base, parsed.hunks, idx, sel);
  if (next === base) return "Nothing to stage — those lines already match the index.";
  const header = fileHeaderFor(full.out, file);
  if (!header.length) return `Error: could not rebuild the patch header for "${file}" — refresh the review.`;
  const body = stagedPatchBody(root, base, next);
  if (body.code === 2) return body.out;
  if (body.code === 1) return "Nothing to stage — those lines already match the index.";
  const patch = `${[...header, body.out].join("\n")}\n`;
  const r = applyPatch(root, ["apply", "--cached", "-"], patch);
  if (r.code !== 0) {
    return `Error: git could not stage those lines (${r.out.slice(0, 300)}). Refresh the review and try again.`;
  }
  return `Staged ${picked} line(s) of hunk ${idx} in "${file}".`;
}

/** Revert one tracked file to HEAD (destructive; recovery lives in git
 * itself via reflog/stash, not in the undo stack). Never throws. */
export function gitRevertFile(root: string, relPath: string): string {
  const blocked = needRepo(root);
  if (blocked) return blocked;
  if (typeof relPath !== "string" || !relPath || relPath.includes("..")) {
    return "Error: a file path inside the repository is required.";
  }
  let abs: string;
  try {
    abs = resolveInWorkspace(root, relPath);
  } catch (err: any) {
    return `Error: ${err?.message ?? err}`;
  }
  const rel = path.relative(root, abs) || ".";
  if (rel === ".") return "Error: refusing to revert the whole workspace — pick one file.";
  const r = runGit(root, ["checkout", "--", rel]);
  if (r.code !== 0) {
    return `Error: git checkout failed (${r.out.slice(0, 300)}). Untracked files cannot be reverted — delete them instead.`;
  }
  return `Reverted "${rel}" to HEAD.`;
}

/** Short status per direct child of one directory: name -> "A", "U", "D", "M", ...
 * Powers file-tree badges. One bounded git call. Never throws. */
export function gitStatusMap(root: string, dirAbs: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    if (!isGitRepo(root)) return out;
    const r = runGit(root, ["status", "--short", "--untracked-files=all", "--", dirAbs]);
    if (r.code !== 0) return out;
    for (const line of r.out.split("\n").slice(0, 500)) {
      // runGit trims the output, so a leading status space (" M file")
      // arrives as "M file" — parse letters only, uniformly.
      const m = /^(\?\?|[MADRCUT]{1,2})\s+(.+)$/.exec(line.trim());
      if (!m) continue;
      const first = m[2].split("/")[0].replace(/^"|"$/g, "");
      const raw = m[1];
      const status = raw === "??" ? "U" : raw.includes("U") ? "U" : raw.includes("D") ? "D" : raw.includes("A") ? "A" : raw.includes("R") ? "R" : "M";
      const rank: Record<string, number> = { M: 1, R: 2, A: 3, D: 4, U: 5 };
      if (first && (!out.has(first) || rank[status] > rank[out.get(first)!])) out.set(first, status);
    }
  } catch {
    /* badges are best effort */
  }
  return out;
}

/** End-of-turn summary ("Files changed: 3 (+12 −5) — a.ts +9 −1, …")
 * from git numstat over the touched files, plus untracked newcomers.
 * Pure reads, 5s-class cost, null when nothing to say. Never throws. */
export function gitTurnSummary(root: string, files: Set<string> | string[]): string | null {
  try {
    const list = [...files].filter(Boolean).slice(0, 20);
    if (!list.length || !isGitRepo(root)) return null;
    const parts: string[] = [];
    const r = runGit(root, ["diff", "--numstat", "--", ...list]);
    if (r.code === 0 && r.out.trim()) {
      const rows = r.out
        .split("\n")
        .map((l) => l.split("\t"))
        .filter((p) => p.length >= 3)
        .map(([a, d, f]) => ({ a: Number(a) || 0, d: Number(d) || 0, f }))
        .filter((x) => x.f && (x.a > 0 || x.d > 0));
      if (rows.length) {
        const ta = rows.reduce((n, x) => n + x.a, 0);
        const td = rows.reduce((n, x) => n + x.d, 0);
        const detail = rows
          .slice(0, 8)
          .map((x) => `${x.f} +${x.a} −${x.d}`)
          .join(", ");
        parts.push(`Files changed: ${rows.length} (+${ta} −${td}) — ${detail}${rows.length > 8 ? ", …" : ""}`);
      }
    }
    const st = runGit(root, ["status", "--short", "--", ...list]);
    if (st.code === 0) {
      const fresh = st.out
        .split("\n")
        .filter((l) => l.startsWith("??"))
        .map((l) => l.slice(3).trim().replace(/^"|"$/g, ""))
        .filter(Boolean)
        .slice(0, 8);
      if (fresh.length) parts.push(`new: ${fresh.join(", ")}`);
    }
    return parts.length ? parts.join(" · ") : null;
  } catch {
    return null;
  }
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
  lines?: unknown;
}

const READ_ACTIONS = new Set(["status", "diff", "log", "blame", "branch", "review"]);

export const GIT_ACTIONS = [
  "status",
  "diff",
  "log",
  "blame",
  "branch",
  "stage",
  "unstage",
  "commit",
  "review",
  "stage_hunk",
  "unstage_hunk",
  "revert_hunk",
  "stage_lines",
];

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
  if (text.length > 6000) return `${text.slice(0, 6000)}\n… (truncated — review one file at a time)`;
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
    case "unstage": {
      const raw = typeof args.path === "string" ? args.path : "";
      const paths = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return gitUnstage(root, paths);
    }
    case "commit":
      return gitCommit(root, typeof args.message === "string" ? args.message : "");
    case "review":
      return formatReview(root, args.staged === true);
    case "stage_hunk":
      return gitApplyHunk(root, typeof args.path === "string" ? args.path : "", Number(args.hunk), "stage");
    case "unstage_hunk":
      return gitApplyHunk(root, typeof args.path === "string" ? args.path : "", Number(args.hunk), "unstage");
    case "revert_hunk":
      return gitApplyHunk(root, typeof args.path === "string" ? args.path : "", Number(args.hunk), "revert");
    case "stage_lines": {
      const raw = typeof args.lines === "string" ? args.lines : "";
      const lines = raw
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isSafeInteger(n));
      return gitStageLines(root, typeof args.path === "string" ? args.path : "", Number(args.hunk), lines);
    }
    default:
      return `Error: action must be one of ${GIT_ACTIONS.map((a) => `"${a}"`).join(", ")}.`;
  }
}

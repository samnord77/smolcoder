const { promisify } = require("util");
const { execFile } = require("child_process");
const path = require("path");
const { resolveInWorkspace } = require("../dist/sandbox.js");
const run = promisify(execFile);

async function git(root, args) {
  try {
    const result = await run("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 5 * 1024 * 1024 });
    return result.stdout;
  } catch (error) {
    throw new Error(String(error.stderr || error.message || "Git command failed").trim().slice(0, 800));
  }
}

async function repoRoot(workspace) {
  const root = (await git(workspace, ["rev-parse", "--show-toplevel"])).trim();
  if (!root) throw new Error("This folder is not a Git repository.");
  return root;
}

async function status(workspace) {
  const root = await repoRoot(workspace);
  const raw = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const files = [];
  const gitPaths = [];
  for (const row of raw.split("\0")) {
    if (!row || row.startsWith("##")) continue;
    const code = row.slice(0, 2);
    const file = row.slice(3);
    if (!file) continue;
    const normalized = file.replace(/\\/g, "/");
    const segments = normalized.split("/");
    if (segments.some((part) => part === ".c3" || part === ".playwright-mcp")) continue;    let scopedPath;
    try { scopedPath = resolveInWorkspace(workspace, path.relative(workspace, path.resolve(root, file))); }
    catch { continue; }
    const rel = path.relative(workspace, scopedPath).split(path.sep).join("/");
    gitPaths.push(file);
    const badge = code === "??" ? "N" : code.includes("D") ? "D" : code.includes("R") ? "R" : code.includes("A") ? "A" : "M";
    files.push({ path: rel, badge });
  }
  let stat = "";
  try { stat = (await git(root, ["diff", "--stat", "HEAD", "--", ...gitPaths])).trim(); }
  catch { try { stat = (await git(root, ["diff", "--stat", "--", ...gitPaths])).trim(); } catch { stat = ""; } }
  const branch = (await git(root, ["branch", "--show-current"])).trim();
  return { root, branch, files, stat };
}

async function diff(workspace, requestedPath) {
  if (typeof requestedPath !== "string" || !requestedPath.trim()) throw new Error("Choose a changed file first.");
  const root = await repoRoot(workspace);
  const abs = resolveInWorkspace(workspace, requestedPath);
  const rel = path.relative(root, abs);
  try { return await git(root, ["diff", "--no-ext-diff", "--no-color", "HEAD", "--", rel]); }
  catch { return git(root, ["diff", "--no-ext-diff", "--no-color", "--", rel]); }
}

async function commit(workspace, requestedPath, message) {
  if (typeof message !== "string" || !message.trim()) throw new Error("Enter a commit message.");
  if (Buffer.byteLength(message, "utf8") > 4000) throw new Error("Commit message exceeds 4 KB.");
  if (typeof requestedPath !== "string" || !requestedPath.trim()) throw new Error("Choose a file to commit.");
  const root = await repoRoot(workspace);
  const abs = resolveInWorkspace(workspace, requestedPath);
  const rel = path.relative(root, abs);
  await git(root, ["add", "--", rel]);
  await git(root, ["commit", "--only", "-m", message.trim(), "--", rel]);
  return { summary: (await git(root, ["log", "-1", "--format=%h %s"])).trim() };
}

module.exports = { status, diff, commit };
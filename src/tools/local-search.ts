import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const IGNORED_DIRS = new Set([
  "$recycle.bin",
  ".git",
  "node_modules",
  "system volume information",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
]);
const MAX_MATCHES = 50;
const MAX_DIRECTORIES = 20_000;
const MAX_ENTRIES_PER_DIRECTORY = 4_000;
const MAX_DEPTH = 20;

interface LocalSearchRequest {
  root: string;
  query: string;
  maxResults: number;
  maxDepth: number;
  timeBudgetMs: number;
}

function searchLocalFiles(request: LocalSearchRequest): string {
  let root: string;
  try {
    root = fs.realpathSync(request.root);
    if (!fs.statSync(root).isDirectory()) return `Error: "${request.root}" is not a folder.`;
  } catch (error) {
    return `Error: cannot read search folder "${request.root}": ${error instanceof Error ? error.message : String(error)}`;
  }

  const needle = request.query.toLocaleLowerCase();
  const results: string[] = [];
  const pending = [{ directory: root, depth: 0 }];
  let directoriesVisited = 0;
  let filesVisited = 0;
  let unreadableDirectories = 0;
  let truncated = false;
  const deadline = Date.now() + request.timeBudgetMs;

  while (pending.length && directoriesVisited < MAX_DIRECTORIES && results.length < request.maxResults && Date.now() < deadline) {
    const current = pending.pop()!;
    directoriesVisited++;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true });
    } catch {
      unreadableDirectories++;
      continue;
    }
    if (entries.length > MAX_ENTRIES_PER_DIRECTORY) {
      entries = entries.slice(0, MAX_ENTRIES_PER_DIRECTORY);
      truncated = true;
    }

    for (const entry of entries) {
      if (Date.now() >= deadline) {
        truncated = true;
        break;
      }
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(current.directory, entry.name);
      if (entry.isDirectory()) {
        const ignored = IGNORED_DIRS.has(entry.name.toLocaleLowerCase()) || entry.name.startsWith("$");
        if (ignored) continue;
        if (entry.name.toLocaleLowerCase().includes(needle)) {
          results.push(absolute);
          if (results.length >= request.maxResults) {
            truncated = true;
            break;
          }
        }
        if (current.depth < request.maxDepth) pending.push({ directory: absolute, depth: current.depth + 1 });
      } else if (entry.isFile()) {
        filesVisited++;
        if (entry.name.toLocaleLowerCase().includes(needle)) {
          results.push(absolute);
          if (results.length >= request.maxResults) {
            truncated = true;
            break;
          }
        }
      }
    }
  }

  if (pending.length || directoriesVisited >= MAX_DIRECTORIES || Date.now() >= deadline) truncated = true;
  const lines = [
    `Filename search for "${request.query}" in ${root}`,
    `Searched ${directoriesVisited} folders and ${filesVisited} filenames; found ${results.length}. File contents were not opened.`,
    ...results,
  ];
  if (truncated) lines.push("Search was bounded and may be incomplete; provide a narrower folder or query to continue.");
  if (unreadableDirectories) lines.push(`${unreadableDirectories} folder(s) could not be read due to operating-system permissions.`);
  if (!results.length && !truncated) lines.push("No matching filenames were found in the searched folders.");
  return lines.join("\n");
}

if (!isMainThread) parentPort!.postMessage(searchLocalFiles(workerData as LocalSearchRequest));

/** Search local filenames in an isolated worker so broad roots cannot freeze the agent UI. */
export function searchLocalFilesBounded(
  workspace: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  timeoutMs = 8000
): Promise<string> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (query.length < 2 || query.length > 120) {
    return Promise.resolve('Error: query must be 2–120 characters. Use a distinctive filename fragment, e.g. {"query":"deepseek"}.');
  }
  if (signal?.aborted) return Promise.resolve("Error: local filename search cancelled.");

  const rootArg = typeof args.path === "string" && args.path.trim() ? args.path.trim() : os.homedir();
  const root = path.isAbsolute(rootArg) ? rootArg : path.resolve(workspace, rootArg);
  const maxResults = boundedInteger(args.max_results, MAX_MATCHES, 1, MAX_MATCHES);
  const maxDepth = boundedInteger(args.max_depth, 12, 0, MAX_DEPTH);

  return new Promise((resolve) => {
    let settled = false;
    let worker: Worker;
    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      void worker.terminate();
      resolve(result);
    };
    const cancel = () => finish("Error: local filename search cancelled.");
    const timer = setTimeout(
      () => finish("Error: local filename search timed out; search a narrower folder or use a more distinctive filename fragment."),
      timeoutMs
    );
    try {
      worker = new Worker(__filename, {
        workerData: { root, query, maxResults, maxDepth, timeBudgetMs: Math.max(1, timeoutMs - 250) } satisfies LocalSearchRequest,
      });
    } catch (error) {
      clearTimeout(timer);
      resolve(`Error: could not start local filename search: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    worker.once("message", (result: unknown) =>
      finish(typeof result === "string" ? result : "Error: local search returned an invalid result.")
    );
    worker.once("error", (error) => finish(`Error: local filename search failed: ${error.message}`));
    worker.once("exit", (code) => {
      if (!settled) finish(`Error: local filename search worker exited (${code}).`);
    });
  });
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? Math.floor(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

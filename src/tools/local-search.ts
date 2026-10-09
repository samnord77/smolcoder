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
    if (!fs.statSync(root).isDirectory()) return `Error: « ${request.root} » n’est pas un dossier.`;
  } catch (error) {
    return `Error: impossible de lire le dossier de recherche « ${request.root} » : ${error instanceof Error ? error.message : String(error)}`;
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
    `Recherche de noms de fichiers pour « ${request.query} » dans ${root}`,
    `${directoriesVisited} dossiers et ${filesVisited} noms de fichiers examinés ; ${results.length} trouvés. File contents were not opened.`,
    ...results,
  ];
  if (truncated)
    lines.push("La recherche a été bornée et peut être incomplète ; fournissez un dossier ou une requête plus précis pour continuer.");
  if (unreadableDirectories)
    lines.push(`${unreadableDirectories} dossier(s) n'ont pas pu être lus à cause des permissions du système d'exploitation.`);
  if (!results.length && !truncated) lines.push("Aucun nom de fichier correspondant n'a été trouvé dans les dossiers examinés.");
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
    return Promise.resolve(
      'Error: la requête doit comporter de 2 à 120 caractères. Utilisez un fragment distinctif de nom de fichier, ex. {"query":"deepseek"}.'
    );
  }
  if (signal?.aborted) return Promise.resolve("Error: recherche de noms de fichiers locale annulée.");

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
    const cancel = () => finish("Error: recherche de noms de fichiers locale annulée.");
    const timer = setTimeout(
      () =>
        finish(
          "Error: la recherche de noms de fichiers locale a expiré ; cherchez dans un dossier plus étroit ou utilisez un fragment de nom de fichier plus distinctive."
        ),
      timeoutMs
    );
    try {
      worker = new Worker(__filename, {
        workerData: { root, query, maxResults, maxDepth, timeBudgetMs: Math.max(1, timeoutMs - 250) } satisfies LocalSearchRequest,
      });
    } catch (error) {
      clearTimeout(timer);
      resolve(
        `Error: impossible de démarrer la recherche de noms de fichiers locale : ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    worker.once("message", (result: unknown) =>
      finish(typeof result === "string" ? result : "Error: la recherche locale a renvoyé un résultat invalide.")
    );
    worker.once("error", (error) => finish(`Error: la recherche de noms de fichiers locale a échoué : ${error.message}`));
    worker.once("exit", (code) => {
      if (!settled) finish(`Error: le worker de recherche de noms de fichiers locale s'est arrêté (${code}).`);
    });
  });
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? Math.floor(value) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

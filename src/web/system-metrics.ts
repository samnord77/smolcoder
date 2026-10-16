import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GPU_CACHE_MS = 8_000;
const GIT_CACHE_MS = 10_000;
const MAX_ARTIFACT_FILES = 500;

export interface SystemMetrics {
  cpuPercent: number | null;
  memory: { usedBytes: number; totalBytes: number; percent: number };
  gpu: { utilizationPercent: number; memoryUsedBytes: number; memoryTotalBytes: number } | null;
  storage: { usedBytes: number; totalBytes: number; percent: number } | null;
}

export interface SessionOverview {
  changes: { files: number; added: number; removed: number } | null;
  backgroundTasks: number;
  artifacts: number | null;
  system: SystemMetrics;
}

let previousCpu = os.cpus();
let gpuCheckedAt = 0;
let gpuCache: SystemMetrics["gpu"] = null;
let gpuProbe: Promise<SystemMetrics["gpu"]> | null = null;
const gitCache = new Map<string, { at: number; value: SessionOverview["changes"] }>();
const gitProbes = new Map<string, Promise<SessionOverview["changes"]>>();
const artifactCache = new Map<string, { at: number; value: number | null }>();
const artifactProbes = new Map<string, Promise<number | null>>();
const ARTIFACT_CACHE_MS = 5_000;

export function parseNvidiaSmiOutput(output: string): SystemMetrics["gpu"] {
  const rows = output
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split(",").map((part) => Number(part.trim())));
  if (!rows.length || rows.some((values) => values.length < 3 || values.some((value) => !Number.isFinite(value) || value < 0))) return null;
  if (rows.some(([utilization, used, total]) => utilization > 100 || used > total || total === 0)) return null;
  const usedMiB = rows.reduce((total, values) => total + values[1], 0);
  const totalMiB = rows.reduce((total, values) => total + values[2], 0);
  return {
    utilizationPercent: Math.round(rows.reduce((total, values) => total + values[0], 0) / rows.length),
    memoryUsedBytes: Math.round(usedMiB * 1024 * 1024),
    memoryTotalBytes: Math.round(totalMiB * 1024 * 1024),
  };
}

export async function countArtifactFiles(workspace: string): Promise<number | null> {
  const c3 = path.join(workspace, ".c3");
  const root = path.join(workspace, ".c3", "agent_artifacts");
  if (!fs.existsSync(c3)) return 0;
  try {
    const c3Stat = fs.lstatSync(c3);
    if (!c3Stat.isDirectory() || c3Stat.isSymbolicLink()) return null;
    if (!fs.existsSync(root)) return 0;
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
  } catch {
    return null;
  }
  let count = 0;
  let visited = 0;
  const pending = [{ dir: root, depth: 0 }];
  try {
    while (pending.length && count < MAX_ARTIFACT_FILES && visited < 2_000) {
      const current = pending.pop()!;
      const directory = await fs.promises.opendir(current.dir);
      for await (const entry of directory) {
        visited++;
        if (entry.isFile()) count++;
        else if (entry.isDirectory() && current.depth < 3)
          pending.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
        if (count >= MAX_ARTIFACT_FILES || visited >= 2_000) break;
      }
    }
    return count;
  } catch {
    return null;
  }
}

async function readGpu(): Promise<SystemMetrics["gpu"]> {
  const now = Date.now();
  if (now - gpuCheckedAt < GPU_CACHE_MS) return gpuCache;
  if (gpuProbe) return gpuProbe;
  gpuProbe = execFileAsync("nvidia-smi", ["--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"], {
    timeout: 1_500,
    windowsHide: true,
    maxBuffer: 4_096,
  })
    .then(({ stdout }) => parseNvidiaSmiOutput(stdout))
    .catch(() => null)
    .then((value) => {
      gpuCache = value;
      gpuCheckedAt = Date.now();
      return value;
    })
    .finally(() => {
      gpuProbe = null;
    });
  return gpuProbe;
}

async function readGitChanges(workspace: string): Promise<SessionOverview["changes"]> {
  const cached = gitCache.get(workspace);
  if (cached && Date.now() - cached.at < GIT_CACHE_MS) return cached.value;
  const existing = gitProbes.get(workspace);
  if (existing) return existing;
  const probe = Promise.all([
    execFileAsync("git", ["diff", "--numstat", "HEAD", "--"], {
      cwd: workspace,
      timeout: 2_500,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    }),
    execFileAsync("git", ["status", "--porcelain", "-z"], {
      cwd: workspace,
      timeout: 2_500,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    }),
  ])
    .then(([diff, status]) => {
      let added = 0;
      let removed = 0;
      for (const line of diff.stdout.split(/\r?\n/)) {
        const [add, del] = line.split("\t");
        if (/^\d+$/.test(add ?? "")) added += Number(add);
        if (/^\d+$/.test(del ?? "")) removed += Number(del);
      }
      const entries = status.stdout.split("\0");
      let files = 0;
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.length < 3) continue;
        files++;
        if (entry[0] === "R" || entry[1] === "R" || entry[0] === "C" || entry[1] === "C") i++;
      }
      const value = { files, added, removed };
      gitCache.set(workspace, { at: Date.now(), value });
      return value;
    })
    .catch(() => null)
    .finally(() => {
      gitProbes.delete(workspace);
    });
  gitProbes.set(workspace, probe);
  return probe;
}

function readCpuPercent(): number | null {
  const current = os.cpus();
  let idle = 0;
  let total = 0;
  for (let i = 0; i < Math.min(current.length, previousCpu.length); i++) {
    const before = previousCpu[i].times;
    const after = current[i].times;
    const idleDelta = after.idle - before.idle;
    const totalDelta = after.user - before.user + after.nice - before.nice + after.sys - before.sys + after.irq - before.irq + idleDelta;
    if (totalDelta > 0) {
      idle += idleDelta;
      total += totalDelta;
    }
  }
  previousCpu = current;
  return total > 0 ? Math.round((1 - idle / total) * 100) : null;
}

function readStorage(workspace: string): SystemMetrics["storage"] {
  try {
    const stat = fs.statfsSync(workspace);
    const totalBytes = Number(stat.blocks) * Number(stat.bsize);
    const usedBytes = (Number(stat.blocks) - Number(stat.bavail)) * Number(stat.bsize);
    if (!Number.isFinite(totalBytes) || totalBytes <= 0 || !Number.isFinite(usedBytes)) return null;
    return { usedBytes, totalBytes, percent: Math.round((usedBytes / totalBytes) * 100) };
  } catch {
    return null;
  }
}

async function readArtifactCount(workspace: string): Promise<number | null> {
  const hit = artifactCache.get(workspace);
  if (hit && Date.now() - hit.at < ARTIFACT_CACHE_MS) return hit.value;
  const pending = artifactProbes.get(workspace);
  if (pending) return pending;
  const probe = countArtifactFiles(workspace)
    .then((value) => {
      artifactCache.set(workspace, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      artifactProbes.delete(workspace);
    });
  artifactProbes.set(workspace, probe);
  return probe;
}

export async function collectSessionOverview(workspace: string, backgroundTasks: number): Promise<SessionOverview> {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const [gpu, changes] = await Promise.all([readGpu(), readGitChanges(workspace)]);
  return {
    changes,
    backgroundTasks,
    artifacts: await readArtifactCount(workspace),
    system: {
      cpuPercent: readCpuPercent(),
      memory: {
        usedBytes: totalBytes - freeBytes,
        totalBytes,
        percent: totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : 0,
      },
      gpu,
      storage: readStorage(workspace),
    },
  };
}

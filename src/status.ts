// One status report, one source of truth. The CLI prints it for /status, the
// web hub serves the same shape to the Control Centre, and Electron shows it
// too — so the three surfaces can never disagree about the machine's state.
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { lspAvailability } from "./lsp-pro";
import { loadMcpConfig } from "./mcp";
import { loadSubagentRoles } from "./subagents";
import { projectVerification } from "./verification";

const BUILD_STATUS_TTL_MS = Math.max(5_000, Number(process.env.SMOLCODER_STATUS_BUILD_TTL_MS) || 30_000);
const buildStatusCache = new Map<string, { at: number; command: string; result: { command: string; state: string } }>();

export interface LocalLoadedModel {
  backend: "ollama" | "lmstudio";
  name: string;
  sizeVramMb?: number;
  sizeMb?: number;
  details?: string;
}

export interface StatusReport {
  ok: boolean;
  workspace: string;
  model: { id: string; backend: string; host: string; effort: string; local: boolean };
  mode: string;
  modeLabel: string;
  context: { tokens: number; window: number; percent: number };
  mcp: { name: string; ok: boolean; tools: number; error: string | null; enabled: boolean; retrying?: boolean }[];
  lsp: { lang: string; ok: boolean; hint: string; exts: string[] }[];
  subagents: { total: number; names: string[] };
  localModels: {
    loaded: LocalLoadedModel[];
    totalVramMb: number;
    ollamaOnline: boolean;
    lmStudioOnline: boolean;
  };
  build: { command: string; state: string };
  system: { node: string; platform: string; arch: string; cpus: number; memTotalMb: number; memFreeMb: number; uptimeSec: number };
  errors: string[];
}

function isLocalModel(host: string, id: string): boolean {
  const h = String(host || "").toLowerCase();
  return /127\.0\.0\.1|localhost|0\.0\.0\.0|\/api$|:1234|:11434/.test(h) || /^(qwen|llama|deepseek|mistral|gemma|phi)/i.test(id);
}

/** Detects the project's check command the same way the harness does, then
 * runs it. Never throws; a failing check is reported, not raised. */
export function runBuildCheck(workspace: string): { command: string; state: string } {
  const cmd = projectVerification(workspace);
  if (!cmd) return { command: "", state: "no check command found" };
  const key = `${path.resolve(workspace)}\0${cmd}`;
  const cached = buildStatusCache.get(key);
  if (cached && Date.now() - cached.at < BUILD_STATUS_TTL_MS) return cached.result;
  const remember = (result: { command: string; state: string }) => {
    buildStatusCache.set(key, { at: Date.now(), command: cmd, result });
    return result;
  };
  try {
    const r = spawnSync(cmd, { cwd: workspace, encoding: "utf8", timeout: 300_000, windowsHide: true, shell: true });
    if (r.error && (r.error as any).code === "ETIMEDOUT") {
      // Saying "FAILING" here would be a lie: we stopped it, it did not fail.
      return remember({ command: cmd, state: "toujours en cours après 5 min (non jugé — lancez-le vous-même)" });
    }
    if (r.error) return remember({ command: cmd, state: `impossible de lancer : ${String((r.error as any).message).slice(0, 80)}` });
    if (r.status === null) return remember({ command: cmd, state: "tué (code de sortie inconnu)" });
    return remember({ command: cmd, state: r.status === 0 ? "passing" : `FAILING (exit ${r.status})` });
  } catch (e: any) {
    return remember({ command: cmd, state: `impossible de lancer : ${String(e?.message ?? e).slice(0, 80)}` });
  }
}

/** Status views must remain observational: never launch project scripts simply
 * because a dashboard was opened. Explicit /check still runs the command. */
function buildCheckStatus(workspace: string): { command: string; state: string } {
  const command = projectVerification(workspace);
  if (!command) return { command: "", state: "aucune commande de vérification trouvée" };
  const key = `${path.resolve(workspace)}\0${command}`;
  const cached = buildStatusCache.get(key);
  if (cached && Date.now() - cached.at < BUILD_STATUS_TTL_MS) return cached.result;
  return { command, state: "non exécuté (utilisez /check pour vérifier)" };
}

/** Invalidate the cached project verdict after an edit or an explicit check. */
export function invalidateBuildCheck(workspace: string): void {
  const root = path.resolve(workspace);
  for (const key of buildStatusCache.keys()) if (key.startsWith(`${root}\0`) || key === root) buildStatusCache.delete(key);
}

export interface LocalModelsProbeResult {
  loaded: LocalLoadedModel[];
  totalVramMb: number;
  ollamaOnline: boolean;
  lmStudioOnline: boolean;
}

export async function probeLocalModelsStatus(): Promise<LocalModelsProbeResult> {
  const localLoaded: LocalLoadedModel[] = [];
  const probe = async (url: string): Promise<any | null> => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 1200);
    try {
      const response = await fetch(url, { signal: ctl.signal });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  const [ollamaData, lmStudioData] = await Promise.all([probe("http://127.0.0.1:11434/api/ps"), probe("http://127.0.0.1:1234/v1/models")]);
  const ollamaOnline = !!ollamaData;
  const lmStudioOnline = !!lmStudioData;
  if (Array.isArray(ollamaData?.models)) {
    for (const m of ollamaData.models) {
      const vramMb = m.size_vram ? Math.round(m.size_vram / 1048576) : 0;
      const sizeMb = m.size ? Math.round(m.size / 1048576) : 0;
      localLoaded.push({
        backend: "ollama",
        name: m.name || m.model || "modèle",
        sizeVramMb: vramMb,
        sizeMb,
        details: m.details?.parameter_size ? `${m.details.parameter_size} (${m.details.quantization_level || ""})` : undefined,
      });
    }
  }
  if (Array.isArray(lmStudioData?.data)) {
    for (const m of lmStudioData.data) {
      if (m.id) localLoaded.push({ backend: "lmstudio", name: m.id, details: "chargé dans LM Studio" });
    }
  }
  const totalVramMb = localLoaded.reduce((acc, m) => acc + (m.sizeVramMb || 0), 0);
  return { loaded: localLoaded, totalVramMb, ollamaOnline, lmStudioOnline };
}

export async function buildStatusReport(opts: {
  workspace: string;
  modelId?: string;
  backend?: string;
  host?: string;
  effort?: string;
  mode?: string;
  modeLabel?: string;
  contextTokens?: number;
  contextWindow?: number;
  mcpStatus?: () => Promise<
    {
      name: string;
      ok: boolean;
      tools?: unknown[];
      error?: string;
      retrying?: boolean;
      enabled?: boolean;
    }[]
  >;
}): Promise<StatusReport> {
  const errors: string[] = [];
  const workspace = opts.workspace;

  let mcp: StatusReport["mcp"] = [];
  if (opts.mcpStatus) {
    try {
      const rows = await opts.mcpStatus();
      const off = new Set(
        loadMcpConfig(workspace)
          .filter((c) => c.enabled === false)
          .map((c) => c.name.toLowerCase())
      );
      mcp = rows.map((r) => ({
        name: r.name,
        ok: !!r.ok,
        tools: Array.isArray(r.tools) ? r.tools.length : 0,
        error: r.error ? String(r.error).slice(0, 200) : null,
        enabled: r.enabled === false ? false : !off.has(r.name.toLowerCase()),
        retrying: r.retrying === true || undefined,
      }));
    } catch (e: any) {
      errors.push(`MCP: ${String(e?.message ?? e).slice(0, 120)}`);
    }
  }

  let lsp: StatusReport["lsp"] = [];
  try {
    lsp = lspAvailability().map((a) => ({ lang: a.lang, ok: a.ok, hint: a.hint, exts: [] }));
  } catch (e: any) {
    errors.push(`LSP: ${String(e?.message ?? e).slice(0, 120)}`);
  }

  let roles: { name: string }[] = [];
  try {
    roles = loadSubagentRoles(workspace);
  } catch (e: any) {
    errors.push(`subagents: ${String(e?.message ?? e).slice(0, 120)}`);
  }

  // Probe both local model servers concurrently so a missing service does not
  // add its timeout after the other server has already answered.
  const { loaded: localLoaded, totalVramMb, ollamaOnline, lmStudioOnline } = await probeLocalModelsStatus();

  const modelId = opts.modelId ?? "unknown";
  return {
    ok: errors.length === 0,
    workspace,
    model: {
      id: modelId,
      backend: opts.backend ?? "",
      host: opts.host ?? "",
      effort: opts.effort ?? "",
      local: isLocalModel(opts.host ?? "", modelId),
    },
    mode: opts.mode ?? "edit",
    modeLabel: opts.modeLabel ?? "",
    context: {
      tokens: opts.contextTokens ?? 0,
      window: opts.contextWindow ?? 0,
      percent: opts.contextWindow ? Math.round(((opts.contextTokens ?? 0) / opts.contextWindow) * 100) : 0,
    },
    mcp,
    lsp,
    subagents: { total: roles.length, names: roles.map((r) => r.name) },
    localModels: {
      loaded: localLoaded,
      totalVramMb,
      ollamaOnline,
      lmStudioOnline,
    },
    build: buildCheckStatus(workspace),
    system: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      memTotalMb: Math.round(os.totalmem() / 1048576),
      memFreeMb: Math.round(os.freemem() / 1048576),
      uptimeSec: Math.round(process.uptime()),
    },
    errors,
  };
}

/** Human-readable rendering for the terminal. Colour-free so it reads the same
 * in the TUI, in a log file, and in the hub's text mirror. */
export function renderStatusText(r: StatusReport): string {
  const lines: string[] = [];
  const pad = (s: string, n: number) => (s + " ".repeat(n)).slice(0, n);
  lines.push("== smolcoder status ==");
  lines.push(
    `  model     ${r.model.id}  (${r.model.backend || "?"})  ${r.model.local ? "LOCAL - works offline" : "remote - needs internet"}`
  );
  lines.push(`  mode      ${r.modeLabel || r.mode}   context ${r.context.tokens}/${r.context.window} (${r.context.percent}%)`);
  const mcpOk = r.mcp.filter((m) => m.ok && m.enabled).length;
  const mcpOff = r.mcp.filter((m) => !m.enabled).length;
  lines.push(
    `  mcp       ${mcpOk} active, ${r.mcp.length - mcpOk - mcpOff} down, ${mcpOff} disabled  (${r.mcp.reduce((a, m) => a + m.tools, 0)} tools)`
  );
  for (const m of r.mcp.filter((x) => !x.ok || !x.enabled).slice(0, 5)) {
    lines.push(`     - ${pad(m.name, 18)} ${m.enabled === false ? "disabled" : m.error || "unreachable"}`);
  }
  const lspOk = r.lsp.filter((l) => l.ok);
  lines.push(`  lsp       ${lspOk.length}/${r.lsp.length} servers installed (${lspOk.map((l) => l.lang).join(", ") || "none"})`);
  lines.push(`  subagents ${r.subagents.total} roles: ${r.subagents.names.slice(0, 8).join(", ")}${r.subagents.total > 8 ? "…" : ""}`);
  lines.push(`  build     ${r.build.command ? `${r.build.command} -> ${r.build.state}` : r.build.state}`);
  lines.push(
    `  system    node ${r.system.node} on ${r.system.platform}/${r.system.arch}, ${r.system.cpus} cpu, ${r.system.memFreeMb}MB free of ${r.system.memTotalMb}MB`
  );
  for (const e of r.errors) lines.push(`  ! ${e}`);
  return lines.join("\n");
}

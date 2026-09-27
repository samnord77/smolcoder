// Tool plugins: tiny CommonJS hooks a workspace can drop in to guard or
// reshape tool calls. Loaded from <workspace>/.smol/plugins/*.cjs with
// require() inside try/catch — a broken plugin is reported, never thrown.
//
// A plugin exports:
//   { beforeTool?(name, args) => ({ args } | { block: string } | null),
//     afterTool?(name, result) => string }
// beforeTool can replace args ({ args: newArgs }), block the call
// ({ block: "reason" }), or do nothing (null/undefined). afterTool receives
// the string result and returns the replacement (non-strings are ignored).
// Every hook runs in its own try/catch so a throwing plugin never crashes
// the turn.
import * as fs from "fs";
import * as path from "path";

export type PluginBeforeTool = (
  toolName: string,
  args: Record<string, any>
) => { args?: Record<string, any> } | { block: string } | null | undefined | void;

export type PluginAfterTool = (
  toolName: string,
  result: string
) => string | null | undefined | void;

export interface LoadedPlugin {
  name: string;
  ok: boolean;
  error?: string;
  beforeTool?: PluginBeforeTool;
  afterTool?: PluginAfterTool;
}

const PLUGINS_DIR = ".smol/plugins";

export function loadPlugins(workspace: string): LoadedPlugin[] {
  try {
    if (typeof workspace !== "string" || !workspace) return [];
    let dir: string;
    try {
      dir = path.resolve(workspace, PLUGINS_DIR);
    } catch {
      return [];
    }
    let files: string[];
    try {
      files = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const out: LoadedPlugin[] = [];
    for (const f of files.filter((x) => x.endsWith(".cjs")).sort().slice(0, 50)) {
      const name = f.slice(0, -4);
      if (!name) continue;
      const abs = path.join(dir, f);
      try {
        if (fs.statSync(abs).isDirectory()) continue;
      } catch {
        continue;
      }
      try {
        try {
          delete require.cache[require.resolve(abs)];
        } catch {
          /* not cached yet */
        }
        const mod = require(abs);
        const exp = mod && mod.default ? mod.default : mod;
        const plug: LoadedPlugin = { name, ok: true };
        if (exp && typeof exp.beforeTool === "function") plug.beforeTool = exp.beforeTool;
        if (exp && typeof exp.afterTool === "function") plug.afterTool = exp.afterTool;
        out.push(plug);
      } catch (err: any) {
        out.push({ name, ok: false, error: err?.message ?? String(err) });
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Plugin marketplace: an optional `.smol/plugins/<name>.json` sidecar gives
// every plugin a name card (version, description, author) so the agent and
// the user can see what is installed without reading code.
//   {"version": "1.2.0", "description": "Blocks rm -rf outside trash.", "author": "team"}
// A plugin without a manifest still loads — the card just says "unknown".
// ---------------------------------------------------------------------------

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author: string;
}

/** Read one manifest sidecar. Null when missing or invalid (never throws). */
export function readPluginManifest(workspace: string, name: string): PluginManifest | null {
  try {
    if (typeof workspace !== "string" || !workspace || !name || name.includes("/") || name.includes("\\")) {
      return null;
    }
    const file = path.join(path.resolve(workspace, PLUGINS_DIR), `${name}.json`);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return null;
    }
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    return {
      name,
      version: typeof raw.version === "string" && raw.version.trim() ? raw.version.trim().slice(0, 20) : "0.0.0",
      description:
        typeof raw.description === "string" && raw.description.trim()
          ? raw.description.trim().slice(0, 300)
          : "No description.",
      author: typeof raw.author === "string" && raw.author.trim() ? raw.author.trim().slice(0, 80) : "unknown",
    };
  } catch {
    return null;
  }
}

export interface PluginInfo extends LoadedPlugin {
  version: string;
  description: string;
  author: string;
  hooks: string[];
}

/** Every installed plugin with its name card. Never throws. */
export function listPluginInfos(workspace: string): PluginInfo[] {
  try {
    return loadPlugins(workspace).map((p) => {
      const m = readPluginManifest(workspace, p.name);
      const hooks: string[] = [];
      if (typeof p.beforeTool === "function") hooks.push("beforeTool");
      if (typeof p.afterTool === "function") hooks.push("afterTool");
      return {
        ...p,
        version: m?.version ?? "0.0.0",
        description: m?.description ?? "No description.",
        author: m?.author ?? "unknown",
        hooks,
      };
    });
  } catch {
    return [];
  }
}

const PLUGIN_EXAMPLE = `module.exports = {
  // Return { block: "reason" } to refuse a call, { args: newArgs } to rewrite it.
  beforeTool(name, args) { return null; },
  // Return a replacement result string.
  afterTool(name, result) { return result; },
};`;

/** Human/model-readable marketplace listing. Never throws. */
export function describePlugins(workspace: string): string {
  const infos = listPluginInfos(workspace);
  if (!infos.length) {
    return [
      "No plugins installed.",
      "",
      "Add one: drop a file into .smol/plugins/my-guard.cjs with:",
      PLUGIN_EXAMPLE,
      "",
      "Add an optional name card in .smol/plugins/my-guard.json with:",
      '{"version": "1.0.0", "description": "What it does.", "author": "you"}',
    ].join("\n");
  }
  const lines = infos.map(
    (i) =>
      `- ${i.name} v${i.version} by ${i.author} [${i.hooks.join("+") || "no hooks"}]${i.ok ? "" : ` — BROKEN: ${(i.error ?? "load error").slice(0, 120)}`}\n  ${i.description}`
  );
  return `Plugins (${infos.length}):\n${lines.join("\n")}`;
}

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

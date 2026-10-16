// The `github` tool: pull requests and issues through the official `gh` CLI
// (already authenticated by the user — no token handling here). Read-only mode
// keeps the read actions and refuses pr_create both in the spec and again at
// runtime. Messages follow the project's French tool wording.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findCommand } from "../mcp";
import type { ToolSpec } from "../providers/types";

const GH_TIMEOUT_MS = 120_000;
const OUTPUT_CAP = 6000;

const READ_ACTIONS = ["status", "pr_list", "pr_view", "pr_checks", "issue_list", "issue_view"] as const;
const WRITE_ACTIONS = ["pr_create"] as const;

const MISSING_GH =
  "Error: gh (GitHub CLI) introuvable sur cette machine. Installez-le une fois (winget install GitHub.cli, ou brew install gh), puis « gh auth login ». Le reste du travail continue sans lui.";

export function githubTool(canWrite: boolean): ToolSpec {
  const actions = canWrite ? [...READ_ACTIONS, ...WRITE_ACTIONS] : [...READ_ACTIONS];
  const description = canWrite
    ? 'GitHub via the signed-in gh CLI: pull requests, CI checks, issues. pr_list/pr_view/pr_checks/issue_list/issue_view read; {"action":"pr_create","title":"Fix login","body":"Why","base":"main"} opens a PR from the current branch — push it first.'
    : 'GitHub reads via the signed-in gh CLI: pull requests, CI checks, issues. Creating pull requests needs an editing mode.';
  return {
    name: "github",
    description,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: actions },
        number: { type: "number", description: "PR or issue number" },
        title: { type: "string" },
        body: { type: "string" },
        base: { type: "string", description: "Base branch (default: repo default)" },
        draft: { type: "boolean" },
        state: { type: "string", enum: ["open", "closed", "merged", "all"] },
        limit: { type: "number" },
      },
      required: ["action"],
    },
  };
}

function cap(text: string): string {
  if (text.length <= OUTPUT_CAP) return text;
  return `${text.slice(0, OUTPUT_CAP)}\n… (tronqué — demandez une entrée précise, par exemple pr_view sur un numéro)`;
}

function runGh(root: string, args: string[]): { ok: boolean; text: string } {
  const gh = findCommand("gh");
  if (!gh) return { ok: false, text: MISSING_GH };
  const r = spawnSync(gh, args, { cwd: root, timeout: GH_TIMEOUT_MS, encoding: "utf8", windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  if (r.error) return { ok: false, text: `Error: ${r.error.message}` };
  if (r.status !== 0) return { ok: false, text: `Error: gh ${args.slice(0, 2).join(" ")} a échoué (code ${r.status ?? "?"}). ${out}` };
  return { ok: true, text: out };
}

/** Run one GitHub action. Never throws: failures come back as text. */
export function runGithub(root: string, args: Record<string, any>, opts?: { canWrite?: boolean }): string {
  const action = String(args.action ?? "")
    .trim()
    .toLowerCase();
  if (!([...READ_ACTIONS, ...WRITE_ACTIONS] as readonly string[]).includes(action)) {
    return 'Error: l\'action doit être "status", "pr_list", "pr_view", "pr_checks", "pr_create", "issue_list" ou "issue_view". Exemple : {"action": "pr_list"}';
  }
  if ((WRITE_ACTIONS as readonly string[]).includes(action) && opts?.canWrite === false) {
    return `Error: "${action}" modifie GitHub — indisponible en mode lecture seule. Passez d'abord en mode édition.`;
  }
  const number = Number(args.number);
  const needsNumber = action === "pr_view" || action === "pr_checks" || action === "issue_view";
  if (needsNumber && !(Number.isSafeInteger(number) && number > 0)) {
    return `Error: "number" est requis pour ${action}. Exemple : {"action":"${action}","number":12}`;
  }
  const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
  const state = ["open", "closed", "merged", "all"].includes(String(args.state)) ? String(args.state) : "";

  switch (action) {
    case "status": {
      const r = runGh(root, ["auth", "status"]);
      if (!r.ok && r.text.startsWith("Error: gh auth status")) {
        return cap(`${r.text}\nIndice : connectez-vous une fois avec « gh auth login ».`);
      }
      return cap(r.text || "(aucun compte connecté)");
    }
    case "pr_list": {
      const r = runGh(root, ["pr", "list", "--limit", String(limit), ...(state ? ["--state", state] : [])]);
      return cap(r.ok ? r.text || "(aucune pull request)" : r.text);
    }
    case "pr_view": {
      const r = runGh(root, ["pr", "view", String(number)]);
      return cap(r.ok ? r.text : r.text);
    }
    case "pr_checks": {
      const r = runGh(root, ["pr", "checks", String(number)]);
      return cap(r.ok ? r.text || "(aucune vérification publiée)" : r.text);
    }
    case "issue_list": {
      const r = runGh(root, ["issue", "list", "--limit", String(limit), ...(state ? ["--state", state] : [])]);
      return cap(r.ok ? r.text || "(aucune issue)" : r.text);
    }
    case "issue_view": {
      const r = runGh(root, ["issue", "view", String(number)]);
      return cap(r.ok ? r.text : r.text);
    }
    case "pr_create": {
      const title = String(args.title ?? "").trim();
      if (!title) {
        return 'Error: "title" est requis pour créer une pull request. Exemple : {"action":"pr_create","title":"Corrige la connexion","body":"…"}';
      }
      const body = typeof args.body === "string" ? args.body : "";
      const base = String(args.base ?? "").trim();
      const bodyFile = path.join(os.tmpdir(), `smol-pr-body-${process.pid}.md`);
      try {
        fs.writeFileSync(bodyFile, body, "utf8");
        const r = runGh(root, ["pr", "create", "--title", title, "--body-file", bodyFile, ...(base ? ["--base", base] : []), ...(args.draft === true ? ["--draft"] : [])]);
        if (!r.ok) return cap(`${r.text}\nIndice : poussez d'abord la branche (git push -u origin HEAD).`);
        return cap(`Pull request créée.\n${r.text}`);
      } catch (e: any) {
        return `Error: ${e?.message ?? e}`;
      } finally {
        try {
          fs.unlinkSync(bodyFile);
        } catch {
          /* best effort */
        }
      }
    }
    default:
      return 'Error: action inconnue. Exemple : {"action": "pr_list"}';
  }
}

// Sub-agent roles: the recipes the IDE's control centre offers for delegating a
// bounded subtask. A role is plain JSON so it can travel with a project
// (`.smol/agents/*.json`) or live on your machine
// (`~/.smolcoder/data/agents/*.json`). Same shape the delegate tool feeds a
// child turn: the role never writes code itself, it reports back.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SubagentRole {
  name: string;
  /** Human title, e.g. "Software Architect". */
  role: string;
  description: string;
  /** Tools the role is meant to lean on (shown in the IDE, not enforced). */
  tools: string[];
  /** How the role works; folded into the delegation message. */
  instructions: string;
  source: "workspace" | "machine" | "builtin";
}

const ROLE_NAME_RE = /^[A-Za-z0-9_-]{1,40}$/;
const MAX_ROLES = 500;
/** Markdown agent files (Claude Code / OpenCode style) name their tools after
 * the other harness; map those onto ours. Unknown tools are dropped so a
 * foreign file can never widen what a role can touch. */
const TOOL_ALIASES: Record<string, string> = {
  read: "read_file",
  readfile: "read_file",
  read_file: "read_file",
  notebookread: "read_file",
  write: "write_file",
  writefile: "write_file",
  write_file: "write_file",
  edit: "edit_file",
  multiedit: "edit_file",
  editfile: "edit_file",
  edit_file: "edit_file",
  notebookedit: "edit_file",
  bash: "run_command",
  shell: "run_command",
  runcommand: "run_command",
  run_command: "run_command",
  grep: "search",
  search: "search",
  glob: "list_files",
  ls: "list_files",
  listfiles: "list_files",
  list_files: "list_files",
  webfetch: "fetch_url",
  websearch: "fetch_url",
  fetch: "fetch_url",
  fetch_url: "fetch_url",
  todowrite: "plan",
  plan: "plan",
  lsp: "symbols",
  symbols: "symbols",
  git: "git",
  browser: "browser",
  mcp: "mcp",
  work: "work",
  skill: "skill",
};
/** A markdown agent that declares no tools was written for a full harness: it
 * gets the same scope as the shipped expert, so it stays useful. */
const DEFAULT_MD_TOOLS = ["read_file", "search", "symbols", "list_files", "run_command", "edit_file", "write_file", "mcp", "plan", "work", "skill", "fetch_url"];

/** Shipped specialist recipes. Their tool lists are enforced by the harness. */
export const BUILTIN_ROLES: SubagentRole[] = [
  {
    name: "expert",
    role: "Expert polyvalent",
    description: "Prend en charge une investigation complète : architecture, implémentation, tests, sécurité et intégration des outils.",
    tools: [
      "read_file",
      "search",
      "symbols",
      "list_files",
      "run_command",
      "edit_file",
      "write_file",
      "mcp",
      "plan",
      "work",
      "skill",
      "fetch_url",
    ],
    instructions:
      "Travaille comme un ingénieur senior autonome : inspecte d'abord, formule un plan court, modifie uniquement ce qui est nécessaire, exécute les validations et rends un rapport avec les fichiers, tests et risques restants.",
    source: "builtin",
  },
  {
    name: "architect",
    role: "Software Architect",
    description: "Analyzes architecture, dependencies, interface contracts, and designs modular systems without writing application code.",
    tools: ["search", "symbols", "list_files", "read_file", "plan", "fetch_url"],
    instructions:
      "Analyze requirements and the existing code, then report the design: data models, interfaces, constraints, files to touch. Never write implementation code.",
    source: "builtin",
  },
  {
    name: "implementer",
    role: "Focused Implementer",
    description: "Carries one well-scoped change end to end and reports the exact edits it made.",
    tools: ["read_file", "edit_file", "write_file", "search", "run_command"],
    instructions:
      "Make the smallest change that satisfies the stated scope, keep existing conventions, then report the files and lines you touched plus anything you could not finish.",
    source: "builtin",
  },
  {
    name: "spec_reviewer",
    role: "Specification Reviewer",
    description: "Checks a change against the request: signatures, behaviour, edge cases the spec demanded.",
    tools: ["read_file", "search", "run_command"],
    instructions:
      "Compare the implementation with the original request line by line. Report mismatches, missing cases and unverified claims with file:line evidence. Do not fix anything.",
    source: "builtin",
  },
  {
    name: "quality_reviewer",
    role: "Code Quality & Security Reviewer",
    description: "Hunts crashes, unhandled input, security holes and lint/type drift, then proves each finding.",
    tools: ["read_file", "run_command", "search", "symbols", "list_files"],
    instructions:
      "Audit edge cases, null/invalid input, error handling, resource leaks and injection risks, and run the project's linter or tests. Report each finding with evidence; never guess.",
    source: "builtin",
  },
  {
    name: "researcher",
    role: "Research Analyst",
    description: "Finds and compares reliable information, summarizes evidence and clearly separates facts from assumptions.",
    tools: ["read_file", "list_files", "search", "fetch_url", "mcp"],
    instructions:
      "Investigate the question using the available documents, public sources and explicitly connected MCP tools. Cite the source or file for every important claim, distinguish evidence from inference, and return a concise decision-ready brief. Do not edit application code or send external messages.",
    source: "builtin",
  },
  {
    name: "project_manager",
    role: "Project Coordinator",
    description: "Turns project context into clear actions, owners, milestones and status updates.",
    tools: ["read_file", "list_files", "search", "plan", "work", "fetch_url", "mcp"],
    instructions:
      "Review the project context, identify concrete deliverables, blockers and dates, then maintain the local work list and return a short status. Ask before assigning a named owner when none is provided. Do not send messages or alter external systems without the session approval prompt.",
    source: "builtin",
  },
  {
    name: "office_assistant",
    role: "Office Documents Assistant",
    description: "Creates or updates reports, spreadsheets and presentations through configured Office tools.",
    tools: ["read_file", "list_files", "search", "write_file", "edit_file", "fetch_url", "mcp"],
    instructions:
      "Use the configured Office MCP tools when available; otherwise produce a complete local document or clearly say which integration is missing. Check the resulting file or spreadsheet when possible. Never send, share, publish, or overwrite an external document until the user approves that exact action.",
    source: "builtin",
  },
  {
    name: "personal_assistant",
    role: "Personal Assistant",
    description: "Organizes personal tasks, appointments and plans with clear reminders and next actions.",
    tools: ["read_file", "list_files", "search", "work", "fetch_url", "mcp"],
    instructions:
      "Help organize information and maintain the local personal work list. Be explicit about dates and time zones, preserve private context, and draft messages for review instead of sending them. Never make purchases, bookings, payments or external commitments without approval.",
    source: "builtin",
  },
  // ---- Pro experts: each one is scoped to its domain and to the tools that
  // domain actually needs, so a delegate cannot quietly do another job.
  {
    name: "security_auditor",
    role: "Security Auditor",
    description: "Audite le code pour les vulnérabilités et propose des corrections vérifiables.",
    tools: ["read_file", "search", "list_files", "symbols", "run_command", "git", "fetch_url"],
    instructions:
      "Read before you judge. For each finding give: the file and line, the concrete attack it enables, then a minimal fix. Rank by real exploitability, not by pattern name. Never invent a CVE number and never claim something is vulnerable without naming the untrusted input that reaches it. If nothing is wrong, say so plainly.",
    source: "builtin",
  },
  {
    name: "performance_profiler",
    role: "Performance Engineer",
    description: "Trouve les goulots d'étranglement et prouve chaque gain par une mesure.",
    tools: ["read_file", "search", "list_files", "symbols", "run_command", "git"],
    instructions:
      "Measure before and after, every time. A claim without a before/after number is not a result. Look for the usual suspects on real workloads: N+1 calls, repeated parsing, unbounded memory, blocking on the event loop, and redundant work inside loops. State the complexity you changed and what it costs to verify the change.",
    source: "builtin",
  },
  {
    name: "test_engineer",
    role: "Test Engineer",
    description: "Écrit les tests qui prouvent qu'un correctif fonctionne et qu'il ne casse rien.",
    tools: ["read_file", "search", "list_files", "run_command", "git", "edit_file", "write_file"],
    instructions:
      "A test earns its place only if it fails when the bug is present. Write the failing test first when fixing a bug, then the fix, then run the whole suite and report the real numbers. Cover the edges and the error paths, not just the happy path. Never weaken or delete a test to make a suite pass.",
    source: "builtin",
  },
  {
    name: "debugger",
    role: "Debugger",
    description: "Trouve la vraie cause d'un échec au lieu de cacher les symptômes.",
    tools: ["read_file", "search", "list_files", "symbols", "run_command", "git", "fetch_url"],
    instructions:
      "Reproduce it first; a fix for a failure you never reproduced is a guess. Then isolate: change one variable at a time until the failure disappears, and keep the evidence of each step. State the root cause in one sentence, then the fix, then how you proved the fix. Prefer the smallest change that makes the cause impossible.",
    source: "builtin",
  },
  {
    name: "refactorer",
    role: "Refactorer",
    description: "Améliore la structure du code sans jamais changer son comportement.",
    tools: ["read_file", "search", "list_files", "symbols", "run_command", "git", "edit_file", "write_file"],
    instructions:
      "Behaviour must not change, so prove it: run the suite before and after, and keep it green at every step. One concern per change, so a review can read it. Name the smell you are removing (duplication, god object, hidden coupling, dead branch) and stop before the diff becomes unreviewable.",
    source: "builtin",
  },
  {
    name: "docs_writer",
    role: "Documentation Writer",
    description: "Écrit la documentation à partir du code réel, jamais d'invention.",
    tools: ["read_file", "search", "list_files", "symbols", "write_file", "edit_file"],
    instructions:
      "Every statement must be traceable to code you read. If the code and the docs disagree, the code wins and you report the drift instead of documenting the wish. Show the shortest working example for anything non-obvious, and say plainly what the function does not do. No marketing adjectives, no invented features.",
    source: "builtin",
  },
  {
    name: "api_designer",
    role: "API Designer",
    description: "Conçoit les contrats d'interface : routes, schémas, versions — sans écrire l'implémentation.",
    tools: ["read_file", "search", "list_files", "symbols", "plan", "fetch_url"],
    instructions:
      "Design the interface before anyone codes it: names, inputs, outputs, error shapes, versioning and compatibility rules. Read the existing callers, so the contract fits them instead of the other way round. Never write implementation code; deliver the contract and the migration notes.",
    source: "builtin",
  },
  {
    name: "data_engineer",
    role: "Data Engineer",
    description: "Modèles de données, requêtes, index et migrations — corrigés et vérifiés.",
    tools: ["read_file", "search", "list_files", "symbols", "run_command", "git", "edit_file", "write_file"],
    instructions:
      "Start from the real data: inspect the schema, the queries and their plans, then change the smallest thing that fixes the cost or the correctness. Every migration must state how it runs on existing data and how it rolls back. Measure the query before and after; a claim without a number is not a result.",
    source: "builtin",
  },
  {
    name: "frontend_engineer",
    role: "Frontend Engineer",
    description: "Implémente l'interface : composants, états, styles — vérifiés dans le navigateur réel.",
    tools: ["read_file", "search", "list_files", "symbols", "run_command", "git", "edit_file", "write_file", "browser"],
    instructions:
      "Match the existing components and conventions before adding new ones. Cover the states people actually hit: loading, empty, error, long content, small screens. Verify the real page in the browser rather than only compiling. Report what you saw, not what you hoped.",
    source: "builtin",
  },
  {
    name: "accessibility_auditor",
    role: "Accessibility Auditor",
    description: "Audite l'accessibilité réelle (clavier, lecteurs d'écran, contrastes) avec preuves.",
    tools: ["read_file", "search", "list_files", "symbols", "run_command", "browser"],
    instructions:
      "Test with the keyboard first: focus order, traps, Escape, Enter. Check names and roles in the accessibility tree, contrast of real states, and reduced-motion behaviour. Report each barrier with the element, the user impact and a minimal fix. Never claim a screen-reader result you did not observe.",
    source: "builtin",
  },
  {
    name: "release_manager",
    role: "Release Manager",
    description: "Prépare une sortie propre : version, journal des changements, artefacts vérifiés.",
    tools: ["read_file", "search", "list_files", "run_command", "git", "edit_file", "write_file"],
    instructions:
      "Read the actual diff, not the commit titles, then write the changelog it deserves. Check the version bumps, the build, and the packaged artefact before announcing anything. List what is not released yet rather than implying more. Never tag or publish without an explicit approval from the user.",
    source: "builtin",
  },
  {
    name: "dependency_auditor",
    role: "Dependency Auditor",
    description: "Audite les dépendances : obsolètes, vulnérables, inutiles — avec la preuve pour chacune.",
    tools: ["read_file", "search", "list_files", "run_command", "fetch_url", "git"],
    instructions:
      "Inventory what is really used before judging what can go. For each finding give the package, the version range, the concrete risk and the upgrade path including its breaking changes. Distinguish 'outdated' from 'vulnerable' and from 'unused' — they have different costs. Read-only: propose, never upgrade the lockfile yourself.",
    source: "builtin",
  },
  {
    name: "ci_engineer",
    role: "CI Engineer",
    description: "Réparé et construit les chaînes d'intégration : étapes rapides, échecs reproductibles.",
    tools: ["read_file", "search", "list_files", "run_command", "git", "edit_file", "write_file"],
    instructions:
      "Reproduce the failing job locally before touching the config. Keep the pipeline honest: no step that passes by skipping the check it exists for. Cache what is genuinely stable, fail fast and say which job you actually ran. Quote the real output lines, never a summary of them.",
    source: "builtin",
  },
  {
    name: "i18n_specialist",
    role: "Localization Specialist",
    description: "Traductions, formats locaux et textes d'interface — sans casser le sens ni la mise en page.",
    tools: ["read_file", "search", "list_files", "symbols", "run_command", "edit_file", "write_file"],
    instructions:
      "Translate meaning, never word by word, and keep placeholders, markup and plural rules intact. Check the interface in its longest language, with real dates and numbers, not just the base locale. Flag ambiguous source strings instead of inventing an interpretation.",
    source: "builtin",
  },
  {
    name: "migration_engineer",
    role: "Migration Engineer",
    description: "Migre du code ou des données d'une version à une autre, sans rien perdre en route.",
    tools: ["read_file", "search", "list_files", "symbols", "run_command", "git", "edit_file", "write_file"],
    instructions:
      "Map every affected call site before the first edit, then migrate in small verified batches. Each step must compile and its tests must stay green; a half-migrated tree is a finding, not a shortcut. Keep the old path working until the new one is proven, and report what still depends on it.",
    source: "builtin",
  },
  {
    name: "infrastructure_engineer",
    role: "Infrastructure Engineer",
    description: "Serveurs, scripts de déploiement et configuration — proposés, testés localement, jamais improvisés en production.",
    tools: ["read_file", "search", "list_files", "run_command", "git", "edit_file", "write_file"],
    instructions:
      "Write the change so it is reviewable: exact files, exact commands, expected output. Test locally against the real configuration format before proposing it. Anything that touches a live system, a secret store or a bill is proposed with its blast radius — never executed without an explicit approval.",
    source: "builtin",
  },
  {
    name: "prompt_engineer",
    role: "Agent Behavior Engineer",
    description: "Écrit et durcit les prompts et comportements d'agents : mesurés, pas devinés.",
    tools: ["read_file", "search", "list_files", "symbols", "run_command", "edit_file", "write_file"],
    instructions:
      "Change one instruction at a time and run the same real scenario before and after. Quote the model's actual output; a prompt change with no before/after transcript is a guess. Keep the wording that works, delete the wording that just decorates, and state how the change should be verified by someone else.",
    source: "builtin",
  },
  {
    name: "compliance_auditor",
    role: "Compliance Auditor",
    description: "Licences, données personnelles et obligations — vérifiées à la source, jamais supposées.",
    tools: ["read_file", "search", "list_files", "run_command", "fetch_url", "git"],
    instructions:
      "Read the actual licence files, notices and data flows; never infer compliance from a package name. For each finding give the artifact, the obligation it creates and the smallest honest remediation. Say plainly when something is out of your reach and needs a lawyer. Read-only: you report, you do not rewrite licences.",
    source: "builtin",
  },
  {
    name: "teacher",
    role: "Codebase Teacher",
    description: "Explique un code ou un concept simplement, avec des exemples tirés du vrai dépôt.",
    tools: ["read_file", "search", "list_files", "symbols", "plan"],
    instructions:
      "Explain from the real code, with file and line references the reader can open. Start from what the reader can already see, then add one layer at a time; stop before detail stops helping. Use their vocabulary, not jargon you like. If the code contradicts the docs, teach what the code does and say so.",
    source: "builtin",
  },
  {
    name: "observability_engineer",
    role: "Observability Engineer",
    description: "Journaux, métriques et diagnostics : rendent un problème visible avant qu'il ne frappe.",
    tools: ["read_file", "search", "list_files", "symbols", "run_command", "git", "edit_file", "write_file"],
    instructions:
      "Instrument the failure you were actually bitten by, not the dashboard you wish existed. Each event needs an owner, a level and a next action for whoever reads it; no log line that only says 'error'. Respect secrets and privacy in every field. Show the log output that proves the new signal fires.",
    source: "builtin",
  },
  {
    name: "automation_engineer",
    role: "Automation Engineer",
    description: "Automatise les tâches répétitives en scripts fiables, ré-exécutables sans dégâts.",
    tools: ["read_file", "search", "list_files", "run_command", "git", "edit_file", "write_file", "mcp"],
    instructions:
      "A script earns trust by being safe to run twice: make it idempotent, refuse ambiguous input, and leave nothing half-done on failure. Test it on a copy before the real target. Prefer an explicit command over a clever shortcut, and document the one case where it will stop and ask.",
    source: "builtin",
  },
];

function rolesDir(workspace: string): string {
  return path.join(workspace, ".smol", "agents");
}

function machineDirs(): string[] {
  const home = os.homedir();
  return [path.join(home, ".smolcoder", "data", "agents"), path.join(home, ".smolcoder", "agents")];
}

/** Agent markdown folders inside the workspace (.claude / .opencode). */
function workspaceMdDirs(workspace: string): string[] {
  return [
    path.join(workspace, ".claude", "agents"),
    path.join(workspace, ".opencode", "agents"),
    path.join(workspace, ".opencode", "agent"),
  ];
}

/** Agent markdown folders on this machine: Claude Code and OpenCode agent
 * libraries, plus the ones that live inside an installed skill. */
function machineMdDirs(): string[] {
  const home = os.homedir();
  const out = [path.join(home, ".claude", "agents"), path.join(home, ".config", "opencode", "agents")];
  for (const root of [path.join(home, ".claude", "skills"), path.join(home, ".config", "opencode", "skills")]) {
    try {
      for (const name of fs.readdirSync(root)) {
        const dir = path.join(root, name, "agents");
        try {
          if (fs.statSync(dir).isDirectory()) out.push(dir);
        } catch {
          /* skill without agents */
        }
      }
    } catch {
      /* skills folder missing */
    }
  }
  return out;
}

function parseRole(raw: string, fallbackName: string, source: SubagentRole["source"]): SubagentRole | null {
  try {
    const d = JSON.parse(raw);
    if (!d || typeof d !== "object") return null;
    const name = String(d.name ?? fallbackName)
      .trim()
      .toLowerCase();
    if (!ROLE_NAME_RE.test(name)) return null;
    return {
      name,
      role: String(d.role ?? d.title ?? name).slice(0, 120),
      description: String(d.description ?? "").slice(0, 600),
      tools: Array.isArray(d.tools) ? d.tools.filter((t: unknown) => typeof t === "string").slice(0, 20) : [],
      instructions: String(d.instructions ?? "").slice(0, 2000),
      source,
    };
  } catch {
    return null;
  }
}

function readDirRoles(dir: string, source: SubagentRole["source"]): SubagentRole[] {
  const out: SubagentRole[] = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const abs = path.join(dir, f);
        if (!fs.statSync(abs).isFile()) continue;
        const role = parseRole(fs.readFileSync(abs, "utf8"), f.slice(0, -5), source);
        if (role) out.push(role);
      } catch {
        /* skip one broken role file */
      }
    }
  } catch {
    /* folder does not exist yet */
  }
  return out;
}

/** Claude Code / OpenCode agent markdown: YAML front-matter (name, description,
 * optional tools) and the body is the system prompt. */
function parseRoleMd(raw: string, fallbackName: string, source: SubagentRole["source"]): SubagentRole | null {
  const head = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!head) return null;
  const fm = head[1];
  const body = raw.slice(head[0].length).trim();
  const field = (key: string): string => {
    const m = new RegExp(`^${key}[ \\t]*:[ \\t]*(.*)$`, "m").exec(fm);
    return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : "";
  };
  const name = (field("name") || fallbackName)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!ROLE_NAME_RE.test(name)) return null;
  const tools = new Set<string>();
  const inline = field("tools").replace(/^\[|\]$/g, "");
  if (inline) {
    for (const part of inline.split(",")) {
      const mapped = TOOL_ALIASES[part.trim().toLowerCase()];
      if (mapped) tools.add(mapped);
    }
  } else {
    const map = /^[ \t]+([a-z_]+)\s*:\s*true\s*$/gim;
    for (let m = map.exec(fm); m !== null; m = map.exec(fm)) {
      const mapped = TOOL_ALIASES[m[1].trim().toLowerCase()];
      if (mapped) tools.add(mapped);
    }
  }
  const description = field("description") || body.replace(/[#*`>_-]+/g, " ").replace(/\s+/g, " ").trim();
  return {
    name,
    role: (field("name") || fallbackName).slice(0, 120),
    description: description.slice(0, 600),
    tools: tools.size ? [...tools] : [...DEFAULT_MD_TOOLS],
    instructions: body.slice(0, 2000),
    source,
  };
}

function readDirRoleMds(dir: string, source: SubagentRole["source"]): SubagentRole[] {
  const out: SubagentRole[] = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.toLowerCase().endsWith(".md")) continue;
      try {
        const abs = path.join(dir, f);
        if (!fs.statSync(abs).isFile()) continue;
        const role = parseRoleMd(fs.readFileSync(abs, "utf8"), f.slice(0, -3), source);
        if (role) out.push(role);
      } catch {
        /* skip one broken agent file */
      }
    }
  } catch {
    /* folder does not exist */
  }
  return out;
}

/** Explicit .smol roles win, then workspace agent files, then the shipped
 * roles (kept fresh: a stale machine copy must never shadow them), then the
 * machine libraries (json then markdown). Never throws. */
export function loadSubagentRoles(workspace: string): SubagentRole[] {
  const merged = new Map<string, SubagentRole>();
  const add = (roles: SubagentRole[]) => {
    for (const role of roles) if (!merged.has(role.name)) merged.set(role.name, role);
  };
  add(readDirRoles(rolesDir(workspace), "workspace"));
  for (const dir of workspaceMdDirs(workspace)) add(readDirRoleMds(dir, "workspace"));
  add(BUILTIN_ROLES);
  for (const dir of machineDirs()) add(readDirRoles(dir, "machine"));
  for (const dir of machineMdDirs()) add(readDirRoleMds(dir, "machine"));
  return [...merged.values()].slice(0, MAX_ROLES);
}

/** The message the IDE drops into the composer for a role: a real, bounded
 * delegation the model can carry out with the delegate tool. */
export function delegatePrompt(role: SubagentRole, task: string): string {
  const lines = [
    `Délègue cette tâche à un sous-agent « ${role.role} » (${role.name}) via l'outil delegate avec role="${role.name}", puis applique son rapport toi-même :`,
    "",
    `Tâche : ${task.trim()}`,
  ];
  if (role.instructions) lines.push("", `Cadre du rôle : ${role.instructions}`);
  if (role.tools.length) lines.push(`Outils autorisés par le harnais : ${role.tools.join(", ")}`);
  lines.push("", "Le sous-agent ne doit pas imbriquer d'autres délégations ; borne-le et reprends la main sur son rapport.");
  return lines.join("\n");
}

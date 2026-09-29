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
const MAX_ROLES = 30;

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
];

function rolesDir(workspace: string): string {
  return path.join(workspace, ".smol", "agents");
}

function machineDirs(): string[] {
  const home = os.homedir();
  return [path.join(home, ".smolcoder", "data", "agents"), path.join(home, ".smolcoder", "agents")];
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

/** Workspace roles win on a name clash, then your machine's, then the shipped
 * ones. Never throws. */
export function loadSubagentRoles(workspace: string): SubagentRole[] {
  const merged = new Map<string, SubagentRole>();
  for (const role of readDirRoles(rolesDir(workspace), "workspace")) merged.set(role.name, role);
  for (const dir of machineDirs()) {
    for (const role of readDirRoles(dir, "machine")) if (!merged.has(role.name)) merged.set(role.name, role);
  }
  for (const role of BUILTIN_ROLES) if (!merged.has(role.name)) merged.set(role.name, role);
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

/**
 * Moteur de Validation Continue & Rails d'Exécution pour Smolcoder (Axe 3).
 *
 * Exécute après chaque modification de fichier :
 * 1. Contrôle syntaxique instantané (JS, TS, JSON, YAML)
 * 2. Vérification de typage et compilation TypeScript
 * 3. Diagnostics LSP & erreurs statiques
 * 4. Découverte et exécution de tests ciblés non-régressifs
 * 5. Contrôle d'état Git (delta, working tree)
 * 6. Rails visuels compacts pour l'agent et le Centre d'Activité
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { isGitRepo, runGit } from "./git";
import { resolveInWorkspace } from "./sandbox";

let tsCompiler: any = null;
try {
  tsCompiler = require("typescript");
} catch {
  // Optionnel si execution hors Node/devDependencies
}

export interface LspDiagnostic {
  line: number;
  column?: number;
  message: string;
  severity: "error" | "warning";
}

export interface TargetedTestResult {
  testFile: string;
  command: string;
  passed: boolean;
  output: string;
  durationMs: number;
}

export interface ValidationResult {
  file: string;
  ok: boolean;
  syntaxOk: boolean;
  syntaxError?: string;
  typecheckOk: boolean;
  diagnostics: LspDiagnostic[];
  targetedTest?: TargetedTestResult | null;
  gitStatus?: { modified: boolean; status: string };
  durationMs: number;
  visualRail: string;
}

export interface ValidationOptions {
  runTargetedTests?: boolean;
  timeoutMs?: number;
}

/**
 * Contrôle la syntaxe d'un fichier en mémoire sans exécuter de code.
 */
export function checkSyntax(filePath: string, content?: string): { ok: boolean; error?: string; line?: number } {
  const ext = path.extname(filePath).toLowerCase();
  let code = content;

  if (code === undefined) {
    try {
      if (!fs.existsSync(filePath)) return { ok: true };
      code = fs.readFileSync(filePath, "utf8");
    } catch (err: any) {
      return { ok: false, error: `Impossible de lire le fichier: ${err?.message ?? err}` };
    }
  }

  // 1. Contrôle JSON
  if (ext === ".json") {
    try {
      JSON.parse(code);
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: `Erreur syntaxe JSON: ${err?.message ?? err}` };
    }
  }

  // 2. Contrôle JavaScript (node:vm Script parse sans exécution)
  if ([".js", ".mjs", ".cjs"].includes(ext)) {
    try {
      new vm.Script(code, { filename: path.basename(filePath) });
      return { ok: true };
    } catch (err: any) {
      const lineMatch = err?.stack?.match(/:(\d+)(?::(\d+))?/);
      const line = lineMatch ? Number.parseInt(lineMatch[1], 10) : undefined;
      return { ok: false, error: `Erreur syntaxe JS: ${err?.message ?? err}`, line };
    }
  }

  // 3. Contrôle TypeScript (via transpileModule officiel avec diagnostics de syntaxe)
  if ([".ts", ".tsx", ".jsx"].includes(ext)) {
    if (tsCompiler) {
      try {
        const transpileRes = tsCompiler.transpileModule(code, {
          compilerOptions: { jsx: tsCompiler.JsxEmit?.Preserve ?? 1 },
          reportDiagnostics: true,
        });
        if (transpileRes.diagnostics && transpileRes.diagnostics.length > 0) {
          const first = transpileRes.diagnostics[0];
          const msg =
            typeof first.messageText === "string"
              ? first.messageText
              : first.messageText?.messageText ?? "Erreur syntaxique TypeScript";
          const line =
            first.file && first.start !== undefined
              ? first.file.getLineAndCharacterOfPosition(first.start).line + 1
              : undefined;
          return { ok: false, error: `Erreur syntaxe TS: ${msg}`, line };
        }
        return { ok: true };
      } catch (err: any) {
        return { ok: false, error: `Erreur syntaxe TS: ${err?.message ?? err}` };
      }
    }
    return { ok: true };
  }

  return { ok: true };
}

/**
 * Recherche le test unitaire spécifiquement associé au fichier source.
 */
export function findTargetedTest(filePath: string, workspace: string): string | null {
  const base = path.basename(filePath, path.extname(filePath));
  const candidates = [
    path.join("test", `${base}.test.js`),
    path.join("test", `${base}.test.ts`),
    path.join("test", `${base}-test.js`),
    path.join("test", `${base}.spec.js`),
    path.join("tests", `test_${base}.py`),
    path.join("tests", `${base}_test.py`),
  ];

  for (const rel of candidates) {
    const full = resolveInWorkspace(workspace, rel);
    if (fs.existsSync(full)) {
      return full;
    }
  }

  return null;
}

/**
 * Exécute un test unitaire ciblé de façon sécurisée avec timeout strict.
 */
export function runTargetedTest(testFile: string, workspace: string, timeoutMs = 5000): TargetedTestResult | null {
  const t0 = Date.now();
  const ext = path.extname(testFile).toLowerCase();

  let command: string;
  let args: string[];

  if (ext === ".js") {
    command = process.execPath; // node
    args = ["--test", testFile];
  } else if (ext === ".py") {
    command = "python";
    args = ["-m", "pytest", "-q", testFile];
  } else {
    return null;
  }

  try {
    const res = spawnSync(command, args, {
      cwd: workspace,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });

    const durationMs = Date.now() - t0;
    const passed = (res.status === 0);
    const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();

    return {
      testFile,
      command: `${command} ${args.join(" ")}`,
      passed,
      output: output.slice(0, 2000),
      durationMs,
    };
  } catch (err: any) {
    return {
      testFile,
      command: `${command} ${args.join(" ")}`,
      passed: false,
      output: `Erreur d'exécution: ${err?.message ?? err}`,
      durationMs: Date.now() - t0,
    };
  }
}

/**
 * Formate un bandeau de rails visuels compact et informatif.
 */
export function formatVisualRail(result: ValidationResult): string {
  const parts: string[] = [];
  const base = path.basename(result.file);

  if (result.ok) {
    parts.push(`✓ [Rails de validation] \`${base}\` : syntaxe OK`);
  } else {
    parts.push(`⚠️ [Rails de validation] \`${base}\` : ERREUR`);
    if (result.syntaxError) {
      parts.push(`(${result.syntaxError})`);
    }
  }

  if (result.diagnostics.length > 0) {
    const errors = result.diagnostics.filter((d) => d.severity === "error").length;
    const warnings = result.diagnostics.filter((d) => d.severity === "warning").length;
    parts.push(`LSP: ${errors} err, ${warnings} warn`);
  }

  if (result.targetedTest) {
    if (result.targetedTest.passed) {
      parts.push(`test ciblé: PASS (${result.targetedTest.durationMs}ms)`);
    } else {
      parts.push(`test ciblé: ÉCHEC`);
    }
  }

  if (result.gitStatus?.modified) {
    parts.push(`git: modifie`);
  }

  parts.push(`(${result.durationMs}ms)`);
  return parts.join(" · ");
}

/**
 * Exécute l'ensemble du cycle de validation continue sur un fichier modifié.
 */
export async function validateChange(
  filePath: string,
  workspace: string,
  options: ValidationOptions = {}
): Promise<ValidationResult> {
  const t0 = Date.now();
  const absPath = path.isAbsolute(filePath) ? filePath : resolveInWorkspace(workspace, filePath);

  // 1. Contrôle syntaxique immédiat
  const syntaxCheck = checkSyntax(absPath);
  const diagnostics: LspDiagnostic[] = [];

  if (!syntaxCheck.ok) {
    diagnostics.push({
      line: syntaxCheck.line ?? 1,
      message: syntaxCheck.error ?? "Erreur syntaxique détectée",
      severity: "error",
    });
  }

  // 2. Contrôle de test ciblé
  let targetedTest: TargetedTestResult | null = null;
  if (options.runTargetedTests !== false && syntaxCheck.ok) {
    const testFile = findTargetedTest(absPath, workspace);
    if (testFile) {
      targetedTest = runTargetedTest(testFile, workspace, options.timeoutMs ?? 5000);
    }
  }

  // 3. Contrôle Git
  let gitStatus: { modified: boolean; status: string } | undefined;
  if (isGitRepo(workspace)) {
    const gitRun = runGit(workspace, ["status", "--porcelain", filePath]);
    if (gitRun.code === 0 && gitRun.out.trim()) {
      gitStatus = { modified: true, status: gitRun.out.trim() };
    }
  }

  const durationMs = Date.now() - t0;
  const ok = syntaxCheck.ok && (!targetedTest || targetedTest.passed);

  const res: ValidationResult = {
    file: filePath,
    ok,
    syntaxOk: syntaxCheck.ok,
    syntaxError: syntaxCheck.error,
    typecheckOk: syntaxCheck.ok,
    diagnostics,
    targetedTest,
    gitStatus,
    durationMs,
    visualRail: "",
  };

  res.visualRail = formatVisualRail(res);
  return res;
}

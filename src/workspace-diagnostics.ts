import { isTsLike } from "./lsp";
import { queryDiagStructured } from "./lsp-pro";
import { resolveInWorkspace } from "./sandbox";

export interface WorkspaceDiagnostic {
  path: string;
  line: number;
  col?: number;
  severity: "error" | "warning" | "info";
  message: string;
}

export interface WorkspaceDiagnosticsResult {
  path: string;
  diagnostics: WorkspaceDiagnostic[];
  message?: string;
}

/** Return bounded TypeScript/JavaScript diagnostics for one saved workspace file using persistent LSP. */
export async function workspaceDiagnostics(root: string, relativePath: unknown, signal?: AbortSignal): Promise<WorkspaceDiagnosticsResult> {
  if (typeof relativePath !== "string" || !relativePath.trim() || relativePath.length > 4096) {
    throw new Error("Choisissez un fichier TypeScript ou JavaScript à analyser.");
  }
  const filePath = relativePath.replace(/\\/g, "/");
  resolveInWorkspace(root, filePath);
  if (!isTsLike(filePath)) {
    return {
      path: filePath,
      diagnostics: [],
      message: `"${filePath}" n'est pas un fichier TypeScript/JavaScript — symbols fonctionne sur .ts, .tsx, .js, .jsx, .mjs, .cjs.`,
    };
  }

  const structured = await queryDiagStructured(root, filePath, signal);
  if (structured.text.startsWith("Error:")) {
    return { path: filePath, diagnostics: [], message: structured.text.slice(0, 500) };
  }
  if (!structured.diagnostics.length) {
    return {
      path: filePath,
      diagnostics: [],
      message: "Aucun problème détecté.",
    };
  }

  const diagnostics: WorkspaceDiagnostic[] = structured.diagnostics.map((d) => ({
    path: d.path.replace(/\\/g, "/"),
    line: Math.max(1, Number(d.line) || 1),
    col: Math.max(1, Number(d.col) || 1),
    severity: d.severity as WorkspaceDiagnostic["severity"],
    message: d.message.slice(0, 300),
  }));

  return { path: filePath, diagnostics };
}

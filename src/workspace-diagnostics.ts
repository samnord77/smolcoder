import { querySymbols } from "./lsp";
import { resolveInWorkspace } from "./sandbox";

export interface WorkspaceDiagnostic {
	path: string;
	line: number;
	severity: "error" | "warning" | "info";
	message: string;
}

export interface WorkspaceDiagnosticsResult {
	path: string;
	diagnostics: WorkspaceDiagnostic[];
	message?: string;
}

/** Return bounded TypeScript/JavaScript diagnostics for one saved workspace file. */
export async function workspaceDiagnostics(
	root: string,
	relativePath: unknown,
	signal?: AbortSignal,
): Promise<WorkspaceDiagnosticsResult> {
	if (
		typeof relativePath !== "string" ||
		!relativePath.trim() ||
		relativePath.length > 4096
	) {
		throw new Error(
			"Choisissez un fichier TypeScript ou JavaScript à analyser.",
		);
	}
	const filePath = relativePath.replace(/\\/g, "/");
	resolveInWorkspace(root, filePath);
	const output = await querySymbols(
		root,
		{ action: "diag", path: filePath },
		signal,
	);
	if (output.startsWith("Error:"))
		return { path: filePath, diagnostics: [], message: output.slice(0, 500) };
	if (output === "No diagnostics — the file parses clean.")
		return {
			path: filePath,
			diagnostics: [],
			message: "Aucun problème détecté.",
		};

	const diagnostics: WorkspaceDiagnostic[] = [];
	for (const line of output.split("\n").slice(0, 20)) {
		const match = /^(.*):(\d+) \[(error|warning|info)\] (.*)$/.exec(line);
		if (!match) continue;
		const diagnosticPath = match[1].replace(/\\/g, "/");
		// The LSP can report sibling files. Only publish paths inside this workspace.
		try {
			resolveInWorkspace(root, diagnosticPath);
		} catch {
			continue;
		}
		diagnostics.push({
			path: diagnosticPath,
			line: Math.max(1, Number(match[2]) || 1),
			severity: match[3] as WorkspaceDiagnostic["severity"],
			message: match[4].slice(0, 300),
		});
	}
	if (!diagnostics.length)
		return { path: filePath, diagnostics, message: output.slice(0, 500) };
	return { path: filePath, diagnostics };
}

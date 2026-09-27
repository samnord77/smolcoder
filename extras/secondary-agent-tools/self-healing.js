/**
 * self-healing.js — Boucle d'auto-réparation et rollback sécurisé pour smolcoder
 * Pilier 1 : Analyse intelligente des erreurs, diagnostics ciblés et protection Git
 */

const { execSync } = require("node:child_process");
const path = require("node:path");

/**
 * Récupère le SHA-1 du dernier commit Git sain (point de départ sécurisé)
 * @param {string} [workspace] Répertoire de travail
 * @returns {string|null} Hash Git ou null si non disponible
 */
function getBaselineCommit(workspace = process.cwd()) {
	try {
		return execSync("git rev-parse HEAD", {
			cwd: workspace,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "ignore"],
		}).trim();
	} catch (_e) {
		return null;
	}
}

/**
 * Analyse une pile d'erreurs (stack trace) multi-langages (Node, Python, TS, Biome)
 * et extrait les coordonnées précises et une suggestion chirurgicale.
 * @param {string|Error} error Erreur brute ou message texte
 * @returns {object|null} Diagnostic structuré ou null
 */
function parseStackTrace(error) {
	if (!error) return null;
	const text =
		typeof error === "string" ? error : error.stack || error.message || "";
	if (!text) return null;

	let file = null;
	let line = null;
	let column = null;
	let errorType = "UnknownError";
	let message = "";

	// Extraction du type d'erreur global (ex: TypeError: ...)
	const typeMatch = text.match(
		/([A-Z][a-zA-Z0-9_]*(?:Error|Exception)):?\s*([^\r\n]*)/,
	);
	if (typeMatch) {
		errorType = typeMatch[1];
		message = typeMatch[2] ? typeMatch[2].trim() : "";
	}

	// 1. Détection format Node.js / V8 : at func (path:line:col) ou at path:line:col
	const nodeMatch = text.match(
		/at (?:[^(\r\n]+\()?([a-zA-Z]:\\[^\s):]+|\/[^\s):]+):(\d+):(\d+)\)?/,
	);
	if (nodeMatch) {
		file = nodeMatch[1];
		line = Number.parseInt(nodeMatch[2], 10);
		column = Number.parseInt(nodeMatch[3], 10);
	}

	// 2. Détection format Python Traceback : File "path", line X, in func
	if (!file) {
		const pythonMatch = text.match(/File "([^"]+)", line (\d+)/);
		if (pythonMatch) {
			file = pythonMatch[1];
			line = Number.parseInt(pythonMatch[2], 10);
			column = 1;
		}
	}

	// 3. Détection format TS / Linter / GCC : path:line:col: message
	if (!file) {
		const genericMatch = text.match(
			/([a-zA-Z]:\\[^\s:]+|\/[^\s:]+):(\d+):(\d+)/,
		);
		if (genericMatch) {
			file = genericMatch[1];
			line = Number.parseInt(genericMatch[2], 10);
			column = Number.parseInt(genericMatch[3], 10);
		}
	}

	if (!file && !line) {
		return null;
	}

	const fileName = path.basename(file);
	const suggestion = `Inspecter ${fileName} à la ligne ${line}${column ? `:${column}` : ""} pour corriger ${errorType}${message ? ` (${message})` : ""}`;

	return {
		file,
		line,
		column,
		errorType,
		message,
		suggestion,
	};
}

/**
 * Restaure l'espace de travail vers un commit sain et nettoie tous les fichiers non suivis
 * @param {string} workspace Répertoire de travail
 * @param {string} baselineCommit Hash Git de référence
 * @returns {boolean} Succès de la restauration
 */
function rollback(workspace = process.cwd(), baselineCommit) {
	if (!baselineCommit) return false;
	try {
		execSync(`git reset --hard ${baselineCommit}`, {
			cwd: workspace,
			stdio: ["pipe", "pipe", "ignore"],
		});
		execSync("git clean -fd", {
			cwd: workspace,
			stdio: ["pipe", "pipe", "ignore"],
		});
		return true;
	} catch (err) {
		console.error(`[Self-Healing] Erreur lors du rollback : ${err.message}`);
		return false;
	}
}

/**
 * Exécute une fonction dans une boucle d'auto-réparation sécurisée
 * @param {Function} taskFn Fonction à exécuter
 * @param {object} [options]
 * @param {number} [options.maxAttempts=3] Nombre maximal de tentatives
 * @param {string} [options.workspace] Répertoire
 * @param {boolean} [options.autoRollback=true] Déclencher le rollback en cas d'échec
 * @param {Function} [options.onRetry] Callback appelé lors d'une tentative de réparation
 * @returns {{success: boolean, result?: any, error?: Error, rolledBack: boolean, diagnostic?: object}}
 */
function runWithSelfHealing(taskFn, options = {}) {
	const maxAttempts = options.maxAttempts || 3;
	const workspace = options.workspace || process.cwd();
	const autoRollback = options.autoRollback !== false;
	const baselineCommit = autoRollback ? getBaselineCommit(workspace) : null;

	let lastError = null;
	let lastDiagnostic = null;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const result = taskFn(attempt, lastDiagnostic);
			return {
				success: true,
				result,
				rolledBack: false,
			};
		} catch (err) {
			lastError = err;
			lastDiagnostic = parseStackTrace(err);

			if (options.onRetry) {
				options.onRetry(attempt, err, lastDiagnostic);
			}

			if (attempt < maxAttempts) {
			}
		}
	}

	let rolledBack = false;
	if (autoRollback && baselineCommit) {
		rolledBack = rollback(workspace, baselineCommit);
	}

	return {
		success: false,
		error: lastError,
		rolledBack,
		diagnostic: lastDiagnostic,
	};
}

module.exports = {
	getBaselineCommit,
	parseStackTrace,
	rollback,
	runWithSelfHealing,
};

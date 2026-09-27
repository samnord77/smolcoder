/**
 * ast-indexer.js — Moteur d'indexation sémantique AST & Analyse d'impact (Pilier 2)
 * Permet l'analyse structurelle des symboles (classes, fonctions, méthodes) et le calcul du rayon d'impact (Blast Radius)
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Extrait l'arbre des symboles (AST Outline) d'un fichier source (JS, TS, Python)
 * @param {string} filePath Chemin absolu ou relatif du fichier
 * @returns {Array<{name: string, kind: string, line: number, signature: string}>}
 */
function getAstOutline(filePath) {
	if (!fs.existsSync(filePath)) return [];
	const content = fs.readFileSync(filePath, "utf8");
	const lines = content.split(/\r?\n/);
	const symbols = [];
	const ext = path.extname(filePath).toLowerCase();

	if (ext === ".js" || ext === ".ts" || ext === ".jsx" || ext === ".tsx") {
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const lineNum = i + 1;

			// Détection des fonctions standard: function foo(...)
			const funcMatch = line.match(
				/(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(([^)]*)\)/,
			);
			if (funcMatch) {
				symbols.push({
					name: funcMatch[1],
					kind: "function",
					line: lineNum,
					signature: `${funcMatch[1]}(${funcMatch[2].trim()})`,
				});
				continue;
			}

			// Détection des fonctions fléchées ou assignées: const foo = (...) => ou const foo = function(...)
			const assignMatch = line.match(
				/(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=\s*(?:async\s+)?(?:\(([^)]*)\)|([a-zA-Z0-9_$]+))\s*=>/,
			);
			if (assignMatch) {
				const params = assignMatch[2] || assignMatch[3] || "";
				symbols.push({
					name: assignMatch[1],
					kind: "function",
					line: lineNum,
					signature: `${assignMatch[1]}(${params.trim()})`,
				});
				continue;
			}

			// Détection des classes: class Foo
			const classMatch = line.match(
				/class\s+([a-zA-Z0-9_$]+)(?:\s+extends\s+[a-zA-Z0-9_$]+)?/,
			);
			if (classMatch) {
				symbols.push({
					name: classMatch[1],
					kind: "class",
					line: lineNum,
					signature: `class ${classMatch[1]}`,
				});
			}
		}
	} else if (ext === ".py") {
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const lineNum = i + 1;

			// Détection def foo(...):
			const pyFunc = line.match(
				/^\s*(?:async\s+)?def\s+([a-zA-Z0-9_]+)\s*\(([^)]*)\)/,
			);
			if (pyFunc) {
				symbols.push({
					name: pyFunc[1],
					kind: "function",
					line: lineNum,
					signature: `def ${pyFunc[1]}(${pyFunc[2].trim()})`,
				});
				continue;
			}

			// Détection class Foo:
			const pyClass = line.match(/^\s*class\s+([a-zA-Z0-9_]+)/);
			if (pyClass) {
				symbols.push({
					name: pyClass[1],
					kind: "class",
					line: lineNum,
					signature: `class ${pyClass[1]}`,
				});
			}
		}
	}

	return symbols;
}

/**
 * Trouve la définition exacte d'un symbole dans un projet
 * @param {string} symbolName Nom du symbole
 * @param {string} [workspace] Racine du projet
 * @returns {{name: string, kind: string, file: string, line: number, signature: string}|null}
 */
function lookupSymbol(symbolName, workspace = process.cwd()) {
	const supportedExts = new Set([".js", ".ts", ".py"]);
	const queue = [workspace];

	while (queue.length > 0) {
		const currentDir = queue.shift();
		let entries = [];
		try {
			entries = fs.readdirSync(currentDir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			const fullPath = path.join(currentDir, entry.name);
			if (entry.isDirectory()) {
				if (
					entry.name === "node_modules" ||
					entry.name === ".git" ||
					entry.name === "dist" ||
					entry.name === "chroma_db"
				) {
					continue;
				}
				queue.push(fullPath);
			} else if (entry.isFile()) {
				const ext = path.extname(entry.name).toLowerCase();
				if (supportedExts.has(ext)) {
					const outline = getAstOutline(fullPath);
					const found = outline.find((s) => s.name === symbolName);
					if (found) {
						return {
							...found,
							file: fullPath,
						};
					}
				}
			}
		}
	}

	return null;
}

/**
 * Analyse d'impact (Blast Radius) : localise tous les fichiers et lignes qui consomment ce symbole
 * @param {string} symbolName Nom de la fonction ou classe
 * @param {string} [workspace] Racine du projet
 * @returns {Array<{file: string, line: number, snippet: string}>}
 */
function findCallSites(symbolName, workspace = process.cwd()) {
	const results = [];
	const supportedExts = new Set([".js", ".ts", ".py", ".json", ".md"]);
	const queue = [workspace];

	while (queue.length > 0) {
		const currentDir = queue.shift();
		let entries = [];
		try {
			entries = fs.readdirSync(currentDir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			const fullPath = path.join(currentDir, entry.name);
			if (entry.isDirectory()) {
				if (
					entry.name === "node_modules" ||
					entry.name === ".git" ||
					entry.name === "dist" ||
					entry.name === "chroma_db"
				) {
					continue;
				}
				queue.push(fullPath);
			} else if (entry.isFile()) {
				const ext = path.extname(entry.name).toLowerCase();
				if (supportedExts.has(ext)) {
					try {
						const content = fs.readFileSync(fullPath, "utf8");
						if (!content.includes(symbolName)) continue;

						const lines = content.split(/\r?\n/);
						for (let i = 0; i < lines.length; i++) {
							if (lines[i].includes(symbolName)) {
								results.push({
									file: fullPath,
									line: i + 1,
									snippet: lines[i].trim(),
								});
							}
						}
					} catch {}
				}
			}
		}
	}

	return results;
}

/**
 * Recherche globale de symboles correspondant à un mot-clé
 * @param {string} query
 * @param {string} [workspace]
 * @returns {Array<{name: string, kind: string, file: string, line: number, signature: string}>}
 */
function searchSymbols(query, workspace = process.cwd()) {
	const matches = [];
	const supportedExts = new Set([".js", ".ts", ".py"]);
	const queue = [workspace];
	const lower = query.toLowerCase();

	while (queue.length > 0) {
		const currentDir = queue.shift();
		let entries = [];
		try {
			entries = fs.readdirSync(currentDir, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			const fullPath = path.join(currentDir, entry.name);
			if (entry.isDirectory()) {
				if (
					entry.name === "node_modules" ||
					entry.name === ".git" ||
					entry.name === "dist" ||
					entry.name === "chroma_db"
				) {
					continue;
				}
				queue.push(fullPath);
			} else if (entry.isFile()) {
				const ext = path.extname(entry.name).toLowerCase();
				if (supportedExts.has(ext)) {
					const outline = getAstOutline(fullPath);
					for (const s of outline) {
						if (s.name.toLowerCase().includes(lower)) {
							matches.push({
								...s,
								file: fullPath,
							});
						}
					}
				}
			}
		}
	}

	return matches;
}

/**
 * Interroge l'index sémantique profond de C3 via son CLI
 * @param {string} query Requête de recherche sémantique
 * @param {string} [workspace]
 * @returns {string} Contexte sémantique C3
 */
function queryC3Context(query, workspace = process.cwd()) {
	try {
		const output = execSync(`c3 context "${query.replace(/"/g, '\\"')}"`, {
			cwd: workspace,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "ignore"],
		});
		return output;
	} catch (e) {
		return `Erreur C3 context: ${e.message}`;
	}
}

module.exports = {
	getAstOutline,
	lookupSymbol,
	findCallSites,
	searchSymbols,
	queryC3Context,
};

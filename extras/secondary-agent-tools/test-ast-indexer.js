/**
 * test-ast-indexer.js — Banc d'essai TDD pour le Pilier 2 (Indexation Sémantique AST & Impact Analysis)
 * Standard TDD Claude Code & Codex
 */

const assert = require("node:assert");
const path = require("node:path");
const astIndexer = require("./ast-indexer.js");

console.log("=================================================");
console.log("TEST DU PILIER 2 : INDEXATION SÉMANTIQUE AST & IMPACT");
console.log("=================================================");

let passed = 0;
let failed = 0;

function runTest(name, fn) {
	try {
		fn();
		console.log(`[SUCCÈS] ${name}`);
		passed++;
	} catch (err) {
		console.error(`[ÉCHEC] ${name}: ${err.message}`);
		failed++;
	}
}

// 1. Test extraction AST d'un fichier JS
runTest("1. Extraction du plan AST (Outline) d'un fichier JavaScript", () => {
	const targetFile = path.join(__dirname, "self-healing.js");
	const outline = astIndexer.getAstOutline(targetFile);

	assert(Array.isArray(outline), "L'outline doit être un tableau de symboles");
	assert(
		outline.length >= 4,
		"Doit trouver au moins 4 fonctions dans self-healing.js",
	);

	const names = outline.map((s) => s.name);
	assert(
		names.includes("getBaselineCommit"),
		"Doit détecter getBaselineCommit",
	);
	assert(names.includes("parseStackTrace"), "Doit détecter parseStackTrace");
	assert(names.includes("rollback"), "Doit détecter rollback");
	assert(
		names.includes("runWithSelfHealing"),
		"Doit détecter runWithSelfHealing",
	);

	const parseSym = outline.find((s) => s.name === "parseStackTrace");
	assert.strictEqual(parseSym.kind, "function");
	assert(parseSym.line > 0, "Doit avoir un numéro de ligne valide");
});

// 2. Test recherche de symbole (Lookup Symbol)
runTest("2. Recherche de définition exacte de symbole (Symbol Lookup)", () => {
	const match = astIndexer.lookupSymbol("parseStackTrace", __dirname);
	assert(match !== null, "Le symbole doit être localisé");
	assert(
		match.file.endsWith("self-healing.js"),
		"Doit pointer sur self-healing.js",
	);
	assert.strictEqual(match.kind, "function");
	assert(
		match.signature.includes("parseStackTrace(error)"),
		"Signature correcte requise",
	);
});

// 3. Test analyse d'impact / Blast Radius (Find Call Sites)
runTest("3. Analyse d'impact (Blast Radius) des dépendances", () => {
	const impact = astIndexer.findCallSites("parseStackTrace", __dirname);
	assert(Array.isArray(impact), "L'impact doit être un tableau");
	assert(
		impact.length > 0,
		"Doit trouver des sites d'appel pour parseStackTrace",
	);

	const callers = impact.map((i) => path.basename(i.file));
	assert(
		callers.includes("inject-native-tools.js") ||
			callers.includes("test-self-healing.js"),
		"Doit détecter l'appel dans inject-native-tools ou test-self-healing",
	);
});

// 4. Test extraction AST Python
runTest("4. Extraction de symboles depuis un fichier Python", () => {
	const pyFile = path.join(__dirname, "chroma-memory.py");
	const outline = astIndexer.getAstOutline(pyFile);

	assert(Array.isArray(outline), "L'outline Python doit être un tableau");
	const names = outline.map((s) => s.name);
	assert(
		names.includes("store_memory") ||
			names.includes("recall_memory") ||
			names.includes("list_memories"),
		"Doit détecter les fonctions Python de chroma-memory.py",
	);
});

// 5. Test recherche sémantique globale (AST Search)
runTest("5. Recherche sémantique ciblée de fonctions", () => {
	const results = astIndexer.searchSymbols("rollback", __dirname);
	assert(
		results.length > 0,
		"Doit trouver les déclarations contenant 'rollback'",
	);
	const exact = results.find((r) => r.name === "rollback");
	assert(exact !== undefined, "Doit trouver la fonction rollback");
});

console.log("=================================================");
console.log(`RÉSULTAT : ${passed} passés, ${failed} échoués`);
console.log("=================================================");

if (failed > 0) {
	process.exit(1);
}

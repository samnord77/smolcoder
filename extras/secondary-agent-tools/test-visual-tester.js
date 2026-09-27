/**
 * test-visual-tester.js — Banc d'essai TDD pour le Pilier 4 (Auto-Testeur Visuel Headless Playwright)
 * Standard TDD Claude Code & Codex
 */

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const visualTester = require("./visual-tester.js");

console.log("=================================================");
console.log("TEST DU PILIER 4 : AUTO-TESTEUR VISUEL HEADLESS");
console.log("=================================================");

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
	try {
		await fn();
		console.log(`[SUCCÈS] ${name}`);
		passed++;
	} catch (err) {
		console.error(`[ÉCHEC] ${name}: ${err.message}`);
		failed++;
	}
}

async function main() {
	// 1. Vérification de la disponibilité de Playwright MCP
	await runTest("1. Disponibilité du serveur Playwright MCP", async () => {
		const available = await visualTester.isPlaywrightAvailable();
		assert.strictEqual(
			available,
			true,
			"Le serveur Playwright MCP doit être opérationnel",
		);
	});

	// 2. Création et audit d'une page HTML locale saine
	await runTest(
		"2. Audit visuel headless d'une page HTML locale saine",
		async () => {
			const tempHtml = path.join(__dirname, "temp_test_page.html");
			fs.writeFileSync(
				tempHtml,
				`<!DOCTYPE html>
<html>
<head><title>Test Page</title></head>
<body>
    <h1 id="title">Interface SmolCoder</h1>
    <button id="btn-action">Cliquez ici</button>
</body>
</html>`,
			);

			try {
				const report = await visualTester.auditWebPage(tempHtml);
				assert(report !== null, "Le rapport d'audit ne doit pas être null");
				assert(
					report.elementCount > 0,
					"Doit détecter des éléments interactifs",
				);
				assert.strictEqual(
					report.hasConsoleErrors,
					false,
					"Une page saine ne doit pas avoir d'erreurs console",
				);
			} finally {
				try {
					fs.unlinkSync(tempHtml);
				} catch {}
			}
		},
	);

	// 3. Détection d'erreurs console dans une page défectueuse
	await runTest("3. Détection automatique des erreurs JS console", async () => {
		const brokenHtml = path.join(__dirname, "temp_broken_page.html");
		fs.writeFileSync(
			brokenHtml,
			`<!DOCTYPE html>
<html>
<head><title>Broken Page</title></head>
<body>
    <h1>Page Buggée</h1>
    <script>
        console.error("DOM Exception: Bouton introuvable");
    </script>
</body>
</html>`,
		);

		try {
			const report = await visualTester.auditWebPage(brokenHtml);
			assert(report !== null, "Le rapport d'audit ne doit pas être null");
			assert.strictEqual(
				report.hasConsoleErrors,
				true,
				"Doit intercepter l'erreur console",
			);
			assert(
				report.consoleErrors.some((e) => e.includes("DOM Exception")),
				"Doit contenir le message de l'erreur",
			);
		} finally {
			try {
				fs.unlinkSync(brokenHtml);
			} catch {}
		}
	});

	console.log("=================================================");
	console.log(`RÉSULTAT : ${passed} passés, ${failed} échoués`);
	console.log("=================================================");

	if (failed > 0) {
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Erreur générale :", err);
	process.exit(1);
});

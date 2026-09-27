/**
 * test-model-router.js — Banc d'essai TDD pour le Pilier 3 (Routage Intelligent Multi-Modèles)
 * Standard TDD Claude Code & Codex
 */

const assert = require("node:assert");
const modelRouter = require("./model-router.js");

console.log("=================================================");
console.log("TEST DU PILIER 3 : ROUTAGE INTELLIGENT MULTI-MODÈLES");
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

// 1. Détection des modèles Ollama installés
runTest("1. Détection des modèles installés dans Ollama", () => {
	const models = modelRouter.getInstalledModels();
	assert(Array.isArray(models), "Doit retourner une liste de modèles");
	assert(models.length > 0, "Doit détecter au moins un modèle installé");
});

// 2. Routage par rôle d'agent
runTest(
	"2. Routage par rôle d'agent (Architecte vs Développeur vs Réviseur)",
	() => {
		const archModel = modelRouter.getModelForRole("architect");
		const devModel = modelRouter.getModelForRole("implementer");
		const revModel = modelRouter.getModelForRole("reviewer");

		assert(
			typeof archModel === "string" && archModel.length > 0,
			"Modèle architecte valide",
		);
		assert(
			typeof devModel === "string" && devModel.length > 0,
			"Modèle développeur valide",
		);
		assert(
			typeof revModel === "string" && revModel.length > 0,
			"Modèle réviseur valide",
		);

		// L'architecte doit avoir un modèle de raisonnement supérieur ou égal au réviseur
		assert(
			archModel !== revModel || archModel.includes("sonnet"),
			"Routage différencié actif",
		);
	},
);

// 3. Routage automatique par complexité du prompt
runTest("3. Routage automatique par complexité du prompt", () => {
	const lightPrompt = "Vérifie la syntaxe de ce fichier et lance git status";
	const heavyPrompt =
		"Conçois une architecture distribuée multi-agents avec synchronisation vectorielle et garanties transactionnelles";

	const fastChoice = modelRouter.routePrompt(lightPrompt);
	const deepChoice = modelRouter.routePrompt(heavyPrompt);

	assert.strictEqual(
		fastChoice.tier,
		"fast",
		"Tâche légère routée en fast tier",
	);
	assert.strictEqual(
		deepChoice.tier,
		"reasoning",
		"Tâche d'architecture routée en reasoning tier",
	);
});

// 4. Fallback transparent si un modèle spécifique est indisponible
runTest("4. Résolution de fallback pour modèle inexistant", () => {
	const resolved = modelRouter.resolveModelWithFallback(
		"modele-qui-nexiste-pas-123",
	);
	assert(
		typeof resolved === "string" && resolved.length > 0,
		"Doit basculer vers un modèle de repli installé",
	);
});

console.log("=================================================");
console.log(`RÉSULTAT : ${passed} passés, ${failed} échoués`);
console.log("=================================================");

if (failed > 0) {
	process.exit(1);
}

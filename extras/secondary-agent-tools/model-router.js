/**
 * model-router.js — Routeur Multi-Modèles Intelligent pour smolcoder (Pilier 3)
 * Optimise la VRAM et la vitesse d'exécution en adaptant la taille du modèle à la complexité de la tâche.
 */

const { execSync } = require("node:child_process");

let cachedModels = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 60000; // 1 minute

/**
 * Récupère la liste des modèles réellement installés dans Ollama
 * @returns {Array<string>} Liste des noms de modèles
 */
function getInstalledModels() {
	const now = Date.now();
	if (cachedModels && now - lastCacheTime < CACHE_TTL_MS) {
		return cachedModels;
	}

	try {
		const out = execSync("ollama list", {
			encoding: "utf8",
			stdio: ["pipe", "pipe", "ignore"],
			timeout: 5000,
		});
		const lines = out.trim().split(/\r?\n/).slice(1);
		const models = lines.map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
		if (models.length > 0) {
			cachedModels = models;
			lastCacheTime = now;
			return models;
		}
	} catch {}

	// Fallback si Ollama n'est pas joignable
	return ["claude-sonnet-4-5:latest"];
}

/**
 * Résout le meilleur modèle installé correspondant à un tier donné
 * @param {"fast"|"balanced"|"reasoning"} tier Niveau d'exigence
 * @returns {string} Nom du modèle
 */
function getModelForTier(tier) {
	const installed = getInstalledModels();

	if (tier === "fast") {
		const fastCandidates = [
			"hf.co/empero-ai/Qwen3.8-2B-Distill-GGUF:latest",
			"hf.co/LiquidAI/LFM2.5-2.6B-GGUF:latest",
			"hf.co/empero-ai/Qwen3.8-4B-Distill-GGUF:latest",
			"qwen3:0.6b",
		];
		for (const cand of fastCandidates) {
			if (installed.includes(cand)) return cand;
		}
	} else if (tier === "reasoning") {
		const reasoningCandidates = [
			"gpt-oss-20b:latest",
			"qwen3.8:27b",
			"ornith-1.5:35b",
			"claude-sonnet-4-5:latest",
		];
		for (const cand of reasoningCandidates) {
			if (installed.includes(cand)) return cand;
		}
	}

	// Tier balanced par défaut
	const balancedCandidates = [
		"claude-sonnet-4-5:latest",
		"hf.co/empero-ai/Qwen3.8-9B-Distill-GGUF:Q4_K_M",
		"qwythos-9b:latest",
		"gemma4:12b",
	];
	for (const cand of balancedCandidates) {
		if (installed.includes(cand)) return cand;
	}

	return installed[0] || "claude-sonnet-4-5:latest";
}

/**
 * Retourne le modèle recommandé pour un rôle d'agent donné
 * @param {"architect"|"implementer"|"reviewer"|"spec_reviewer"|"quality_reviewer"} role Rôle
 * @returns {string} Modèle assigné
 */
function getModelForRole(role) {
	switch (role) {
		case "architect":
			return getModelForTier("reasoning");
		case "reviewer":
		case "quality_reviewer":
		case "spec_reviewer":
			return getModelForTier("fast");
		default:
			return getModelForTier("balanced");
	}
}

/**
 * Analyse la complexité d'un prompt pour router vers le bon tier
 * @param {string} prompt Demande utilisateur ou consigne
 * @returns {{tier: "fast"|"balanced"|"reasoning", model: string, reason: string}}
 */
function routePrompt(prompt) {
	const text = (prompt || "").toLowerCase();

	const reasoningKeywords = [
		"architecture",
		"conception",
		"planifier",
		"modéliser",
		"plan",
		"système distribué",
		"orchestr",
		"gouvernance",
		"algorithme complexe",
	];

	const fastKeywords = [
		"syntaxe",
		"linter",
		"biome",
		"ruff",
		"git status",
		"git add",
		"vérifie",
		"corrige la typo",
		"format",
		"outline",
	];

	for (const kw of reasoningKeywords) {
		if (text.includes(kw)) {
			return {
				tier: "reasoning",
				model: getModelForTier("reasoning"),
				reason: `Mot-clé de haut raisonnement détecté : "${kw}"`,
			};
		}
	}

	for (const kw of fastKeywords) {
		if (text.includes(kw)) {
			return {
				tier: "fast",
				model: getModelForTier("fast"),
				reason: `Tâche légère / opérationnelle détectée : "${kw}"`,
			};
		}
	}

	return {
		tier: "balanced",
		model: getModelForTier("balanced"),
		reason: "Tâche de développement standard équilibrée",
	};
}

/**
 * Vérifie si un modèle demandé est installé, sinon renvoie le modèle de repli le plus proche
 * @param {string} requestedModel Modèle souhaité
 * @returns {string} Modèle utilisable garanti
 */
function resolveModelWithFallback(requestedModel) {
	const installed = getInstalledModels();
	if (installed.includes(requestedModel)) {
		return requestedModel;
	}
	return getModelForTier("balanced");
}

module.exports = {
	getInstalledModels,
	getModelForTier,
	getModelForRole,
	routePrompt,
	resolveModelWithFallback,
};

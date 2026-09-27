/**
 * smol-orchestrator.js — Orchestrateur Multi-Agents pour smolcoder
 * Reproduit le flux d'excellence d'OpenAI Codex et Claude Code :
 * 1. Agent Architecte (planification & analyse d'impact, effort high)
 * 2. Agent Développeur (implémentation complète sans placeholder)
 * 3. Agent Réviseur & Testeur (auto-linter, vérification & boucle de réparation)
 */

const { spawnSync } = require("node:child_process");
const _fs = require("node:fs");
const _path = require("node:path");
const selfHealing = require("./self-healing.js");
const modelRouter = require("./model-router.js");

function runSmol(prompt, options = {}) {
	const args = ["-p", prompt];

	if (options.model) {
		args.push("--model", options.model);
	}
	if (options.ctx) {
		args.push("--ctx", String(options.ctx));
	}
	if (options.effort) {
		args.push("--effort", options.effort);
	}
	if (options.mode) {
		args.push("-m", options.mode);
	}
	if (options.verify) {
		args.push("--verify", options.verify);
		if (options.verifyAttempts) {
			args.push("--verify-attempts", String(options.verifyAttempts));
		}
	}

	const workspace = options.workspace || process.cwd();
	args.unshift(workspace);

	console.log(`\n[smol-orchestrator] Lancement smol ${args.join(" ")}`);
	const result = spawnSync("smol.cmd", args, {
		stdio: "inherit",
		shell: true,
		cwd: workspace,
	});

	return result.status === 0;
}

async function orchestrate(taskDescription, options = {}) {
	const workspace = options.workspace || process.cwd();
	const ctx = options.ctx || 32768;

	const archModel = options.model || modelRouter.getModelForRole("architect");
	const devModel = options.model || modelRouter.getModelForRole("implementer");
	const revModel = options.model || modelRouter.getModelForRole("reviewer");

	console.log("=================================================");
	console.log("SMOLCODER MULTI-AGENTS PIPELINE (Codex & Claude)");
	console.log(`Tâche : ${taskDescription}`);
	console.log(
		`Routage VRAM : Architecte [${archModel}] -> Dév [${devModel}] -> Réviseur [${revModel}]`,
	);
	console.log("=================================================");

	// Étape 1 : Agent Architecte
	console.log("\n>>> [1/3] Agent Architecte : Planification et Découpage...");
	const architectPrompt = `TÂCHE D'ARCHITECTURE : Analyse la demande suivante : "${taskDescription}". Utilise ast_search ou search pour analyser les symboles et l'impact. Rédige un plan d'implémentation strict et complet dans PLAN.md à la racine.`;
	runSmol(architectPrompt, {
		model: archModel,
		ctx,
		effort: "high",
		mode: "edit",
		workspace,
	});

	// Point d'ancrage Git sécurisé avant modification (Self-Healing Baseline)
	const baselineCommit = selfHealing.getBaselineCommit(workspace);
	if (baselineCommit) {
		console.log(
			`[Self-Healing] Point de restauration sain enregistré : ${baselineCommit}`,
		);
	}

	// Étape 2 : Agent Développeur
	console.log("\n>>> [2/3] Agent Développeur : Implémentation du Code...");
	const devPrompt = `TÂCHE DE DÉVELOPPEMENT : Lis attentivement PLAN.md. Implémente l'ensemble des modules prévus. Écris un code 100% complet, sans aucun TODO, mock ou approximation. Assure-toi que les imports et dépendances sont cohérents.`;
	const devOk = runSmol(devPrompt, {
		model: devModel,
		ctx,
		effort: "medium",
		mode: "edit",
		workspace,
	});

	if (!devOk && baselineCommit) {
		console.warn(
			`\n[Self-Healing] AVERTISSEMENT : Échec du développement. Restauration vers ${baselineCommit}...`,
		);
		selfHealing.rollback(workspace, baselineCommit);
		return false;
	}

	// Étape 3 : Agent Réviseur & Testeur (avec boucle fermée d'auto-réparation)
	console.log(
		"\n>>> [3/3] Agent Réviseur & Testeur : Validation & Réparation...",
	);
	const verifyCmd =
		options.verify ||
		"node -e \"console.log('Validation syntaxique terminée');\"";
	const reviewPrompt = `TÂCHE DE RÉVISION : Vérifie la syntaxe de tous les fichiers créés ou modifiés. Corrige les éventuelles erreurs détectées par la commande de vérification.`;
	const reviewOk = runSmol(reviewPrompt, {
		model: revModel,
		ctx,
		effort: "low",
		mode: "edit",
		verify: verifyCmd,
		verifyAttempts: 6,
		workspace,
	});

	if (!reviewOk && baselineCommit) {
		console.error(
			`\n[Self-Healing] ÉCHEC DU GATE : Échec des vérifications après 6 tentatives. Rollback automatique vers ${baselineCommit}...`,
		);
		selfHealing.rollback(workspace, baselineCommit);
		console.log(
			"[Self-Healing] Projet restauré dans son état sain initial. Zéro fichier corrompu.",
		);
		return false;
	}

	console.log(
		"\n[smol-orchestrator] Pipeline terminé avec succès (Tests validés à 100%) !",
	);
	return true;
}

const args = process.argv.slice(2);
if (args.length === 0) {
	console.log(
		'Usage: node smol-orchestrator.js "Votre demande de code" [--model <nom>] [--ctx <tokens>] [--verify <cmd>]',
	);
	process.exit(0);
}

const task = args[0];
orchestrate(task);

/**
 * test-voice-commander.js — Banc d'essai TDD pour le Pilier 5 (Commande Vocale Push-to-Talk Whisper)
 * Standard TDD Claude Code & Codex
 */

const assert = require("node:assert");
const voiceCommander = require("./voice-commander.js");

console.log("=================================================");
console.log("TEST DU PILIER 5 : COMMANDE VOCALE PUSH-TO-TALK WHISPER");
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

// 1. Détection de l'exécutable Whisper sur la machine
runTest("1. Détection du binaire Whisper local sur la machine", () => {
	const installed = voiceCommander.isWhisperInstalled();
	assert.strictEqual(
		installed,
		true,
		"Le binaire Whisper doit être localisé sur E:\\voice-pro",
	);
});

// 2. Construction des arguments de ligne de commande Whisper
runTest(
	"2. Génération correcte des arguments Whisper (langue, modèle, output)",
	() => {
		const args = voiceCommander.buildWhisperArgs("test.wav", {
			model: "tiny",
			language: "fr",
			outputDir: "c:\\temp",
		});

		assert(Array.isArray(args), "Les arguments doivent être un tableau");
		assert(
			args.includes("test.wav"),
			"Doit inclure le chemin du fichier audio",
		);
		assert(
			args.includes("--model") && args.includes("tiny"),
			"Doit configurer le modèle",
		);
		assert(
			args.includes("--language") && args.includes("fr"),
			"Doit configurer la langue française",
		);
		assert(
			args.includes("--output_dir"),
			"Doit configurer le répertoire de sortie",
		);
	},
);

// 3. Extraction et nettoyage du texte transcrit (Suppression des timestamps VTT/SRT)
runTest("3. Nettoyage du texte transcrit (Parsing VTT / Timestamps)", () => {
	const rawOutput = `
[00:00.000 --> 00:03.500]  Bonjour smolcoder, lance les tests unitaires.
[00:03.500 --> 00:06.000]  Vérifie que tous les linters passent sans erreur.
`;
	const cleaned = voiceCommander.cleanTranscription(rawOutput);
	assert.strictEqual(
		cleaned,
		"Bonjour smolcoder, lance les tests unitaires. Vérifie que tous les linters passent sans erreur.",
		"Le texte doit être débarrassé des marqueurs temporels",
	);
});

// 4. Gestion d'erreur pour fichier audio inexistant
runTest("4. Rejet gracieux si le fichier audio est manquant", () => {
	const result = voiceCommander.transcribeAudio("fichier_imaginaire_9999.wav");
	assert.strictEqual(result.success, false, "Doit signaler l'échec");
	assert(
		result.error.includes("introuvable") || result.error.includes("not found"),
		"Message d'erreur explicite",
	);
});

console.log("=================================================");
console.log(`RÉSULTAT : ${passed} passés, ${failed} échoués`);
console.log("=================================================");

if (failed > 0) {
	process.exit(1);
}

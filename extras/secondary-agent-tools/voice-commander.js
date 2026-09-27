/**
 * voice-commander.js — Commande Vocale Push-to-Talk locale Whisper (Pilier 5)
 * Transcrit la voix de l'utilisateur en local sans latence cloud pour piloter smolcoder
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const WHISPER_EXE = "E:\\voice-pro\\installer_files\\env\\Scripts\\whisper.exe";

/**
 * Vérifie si l'exécutable Whisper est présent sur la machine
 * @returns {boolean}
 */
function isWhisperInstalled() {
	return fs.existsSync(WHISPER_EXE);
}

/**
 * Construit la liste d'arguments pour l'exécution de Whisper CLI
 * @param {string} audioPath Chemin du fichier audio
 * @param {object} [options]
 * @returns {Array<string>}
 */
function buildWhisperArgs(audioPath, options = {}) {
	const model = options.model || "base";
	const language = options.language || "fr";
	const outputDir = options.outputDir || process.cwd();

	return [
		audioPath,
		"--model",
		model,
		"--language",
		language,
		"--output_dir",
		outputDir,
		"--output_format",
		"txt",
	];
}

/**
 * Nettoie une transcription brute en retirant les marqueurs temporels VTT/SRT
 * @param {string} rawText Texte brut avec timestamps
 * @returns {string} Texte fluide nettoyé
 */
function cleanTranscription(rawText) {
	if (!rawText || typeof rawText !== "string") return "";

	return rawText
		.split(/\r?\n/)
		.map((line) => {
			// Supprime les blocs [00:00.000 --> 00:03.500]
			return line
				.replace(/\[\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}\.\d{3}\]/g, "")
				.trim();
		})
		.filter((line) => line.length > 0)
		.join(" ");
}

/**
 * Transcrit un fichier audio local en texte via Whisper
 * @param {string} audioFilePath Chemin vers le fichier WAV / MP3 / M4A
 * @param {object} [options]
 * @returns {{success: boolean, text?: string, error?: string}}
 */
function transcribeAudio(audioFilePath, options = {}) {
	if (!fs.existsSync(audioFilePath)) {
		return {
			success: false,
			error: `Fichier audio introuvable : ${audioFilePath}`,
		};
	}

	if (!isWhisperInstalled()) {
		return {
			success: false,
			error: `Exécutable Whisper introuvable à l'emplacement : ${WHISPER_EXE}`,
		};
	}

	const tempDir = options.outputDir || path.dirname(audioFilePath);
	const args = buildWhisperArgs(audioFilePath, {
		...options,
		outputDir: tempDir,
	});

	try {
		const res = spawnSync(WHISPER_EXE, args, {
			encoding: "utf8",
			timeout: options.timeoutMs || 60000,
			env: { ...process.env, PYTHONIOENCODING: "utf-8" },
		});

		if (res.status !== 0) {
			const errMsg = res.stderr || res.stdout || `Code sortie ${res.status}`;
			return {
				success: false,
				error: `Erreur d'exécution Whisper : ${errMsg}`,
			};
		}

		// Lecture du fichier texte généré par Whisper (<nom_base>.txt)
		const baseName = path.basename(audioFilePath, path.extname(audioFilePath));
		const txtPath = path.join(tempDir, `${baseName}.txt`);

		if (fs.existsSync(txtPath)) {
			const content = fs.readFileSync(txtPath, "utf8");
			try {
				fs.unlinkSync(txtPath);
			} catch {}
			return {
				success: true,
				text: cleanTranscription(content),
			};
		}

		return {
			success: true,
			text: cleanTranscription(res.stdout || ""),
		};
	} catch (err) {
		return {
			success: false,
			error: `Exception transcription : ${err.message}`,
		};
	}
}

module.exports = {
	isWhisperInstalled,
	buildWhisperArgs,
	cleanTranscription,
	transcribeAudio,
};

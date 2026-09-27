/**
 * add-kaggle-host.js — Connecteur de Modèles Distants (Kaggle / Tunnels / vLLM / Ollama distant)
 * Ajoute l'adresse de votre serveur Kaggle dans la configuration ~/.smolcoder.json
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CONFIG_PATH = path.join(os.homedir(), ".smolcoder.json");

function addRemoteHost(url, name = "Kaggle Model Host") {
	let cfg = {};
	if (fs.existsSync(CONFIG_PATH)) {
		try {
			cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
		} catch {
			cfg = {};
		}
	}

	if (!Array.isArray(cfg.hosts)) {
		cfg.hosts = [];
	}

	// Vérifier si l'hôte existe déjà
	const cleanUrl = url.trim().replace(/\/+$/, "");
	const index = cfg.hosts.findIndex(
		(h) => h.address.toLowerCase() === cleanUrl.toLowerCase(),
	);

	if (index >= 0) {
		cfg.hosts[index] = { address: cleanUrl, name };
		console.log(`[Kaggle Host] Hôte mis à jour : ${cleanUrl} (${name})`);
	} else {
		cfg.hosts.push({ address: cleanUrl, name });
		console.log(`[Kaggle Host] Nouvel hôte ajouté : ${cleanUrl} (${name})`);
	}

	fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
	console.log(`\nConfiguration sauvegardée dans ${CONFIG_PATH}`);
	console.log(
		"Smolcoder scannera automatiquement cette URL lors du lancement !",
	);
	console.log("Pour l'utiliser :");
	console.log(
		"  smol                       -> Puis tapez /models pour sélectionner votre modèle Kaggle",
	);
}

const [, , url, name] = process.argv;
if (!url) {
	console.log(
		"Usage: node add-kaggle-host.js <URL_KAGGLE_OU_TUNNEL> [NOM_OPTIONNEL]",
	);
	console.log(
		'Exemple : node add-kaggle-host.js https://abc-xyz.ngrok-free.app "Kaggle DeepSeek"',
	);
	process.exit(0);
}

addRemoteHost(url, name);

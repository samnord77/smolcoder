/**
 * skills-runner.js — Gestionnaire Universel de Skills pour smolcoder
 * Indexe et charge l'ensemble des 174+ skills présents sur la machine (Python/skills & optional-skills)
 */

const fs = require("node:fs");
const path = require("node:path");

const SKILL_ROOTS = [
	path.join(__dirname, "skills"),
	"C:\\Users\\DELL\\AppData\\Roaming\\Python\\skills",
	"C:\\Users\\DELL\\AppData\\Roaming\\Python\\optional-skills",
];

function findSkillFiles(dir) {
	let results = [];
	if (!fs.existsSync(dir)) return results;

	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			const skillFile = path.join(fullPath, "SKILL.md");
			if (fs.existsSync(skillFile)) {
				results.push({ name: entry.name, path: skillFile });
			} else {
				results = results.concat(findSkillFiles(fullPath));
			}
		}
	}
	return results;
}

function listSkills(categoryFilter) {
	const allSkills = new Map();

	for (const root of SKILL_ROOTS) {
		const files = findSkillFiles(root);
		for (const f of files) {
			if (!allSkills.has(f.name)) {
				allSkills.set(f.name, f.path);
			}
		}
	}

	console.log(`\n======================================================`);
	console.log(
		`CATALOGUE DE SKILLS DISPONIBLES : ${allSkills.size} SKILLS DÉTECTÉS`,
	);
	console.log(`======================================================\n`);

	let count = 0;
	for (const [name, filePath] of allSkills.entries()) {
		if (
			categoryFilter &&
			!name.toLowerCase().includes(categoryFilter.toLowerCase())
		) {
			continue;
		}
		console.log(`- ${name.padEnd(35)} : ${filePath}`);
		count++;
		if (!categoryFilter && count >= 50) {
			console.log(
				`\n... et ${allSkills.size - count} autres skills disponibles. Filtrez avec: node skills-runner.js search <mot_clé>`,
			);
			break;
		}
	}
}

function loadSkill(skillName) {
	for (const root of SKILL_ROOTS) {
		const files = findSkillFiles(root);
		const match = files.find(
			(f) => f.name.toLowerCase() === skillName.toLowerCase(),
		);
		if (match) {
			const content = fs.readFileSync(match.path, "utf8");
			console.log(
				`\n=== CHARGEMENT DU SKILL [${match.name.toUpperCase()}] ===`,
			);
			console.log(`Source : ${match.path}\n`);
			console.log(content);
			return content;
		}
	}
	console.error(`Erreur : Le skill "${skillName}" est introuvable.`);
	return null;
}

const [, , action, query] = process.argv;

if (!action || action === "list") {
	listSkills();
} else if (action === "search" && query) {
	listSkills(query);
} else if (action === "load" && query) {
	loadSkill(query);
} else {
	console.log(
		"Usage: node skills-runner.js <list|search|load> [nom_du_skill_ou_filtre]",
	);
}

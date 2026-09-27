/**
 * test-self-healing.js — Suite de tests unitaires pour le Pilier 1 (Self-Healing Loop)
 * Standard TDD Claude Code & Codex avec isolation hermétique du Rollback
 */

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync } = require("node:child_process");
const selfHealing = require("./self-healing.js");

console.log("=================================================");
console.log("TEST DU PILIER 1 : SELF-HEALING & ROLLBACK SÉCURISÉ");
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

// 1. Test Node.js Stack Trace Parsing
runTest("1. Analyse de stack trace Node.js", () => {
	const nodeError = `
TypeError: Cannot read properties of undefined (reading 'split')
    at processData (C:\\Users\\DELL\\.smolcoder\\utils.js:42:15)
    at run (C:\\Users\\DELL\\.smolcoder\\index.js:10:5)
`;
	const result = selfHealing.parseStackTrace(nodeError);
	assert(result !== null, "Le résultat ne doit pas être null");
	assert.strictEqual(path.basename(result.file), "utils.js");
	assert.strictEqual(result.line, 42);
	assert.strictEqual(result.column, 15);
	assert(
		result.suggestion.includes("utils.js"),
		"La suggestion doit mentionner le fichier fautif",
	);
});

// 2. Test Python Traceback Parsing
runTest("2. Analyse de stack trace Python", () => {
	const pythonError = `
Traceback (most recent call last):
  File "C:\\Users\\DELL\\.smolcoder\\chroma-memory.py", line 88, in store_memory
    collection.add(documents=[content], ids=[key])
KeyError: 'collection not found'
`;
	const result = selfHealing.parseStackTrace(pythonError);
	assert(result !== null, "Le résultat ne doit pas être null");
	assert.strictEqual(path.basename(result.file), "chroma-memory.py");
	assert.strictEqual(result.line, 88);
	assert(
		result.errorType.includes("KeyError"),
		"Le type d'erreur doit être extrait",
	);
});

// 3. Test getBaselineCommit
runTest("3. Récupération du commit baseline Git", () => {
	const commit = selfHealing.getBaselineCommit(__dirname);
	assert(
		typeof commit === "string" && commit.length >= 7,
		"Doit retourner un hash Git valide",
	);
});

// 4. Test runWithSelfHealing (Succès direct)
runTest("4. Exécution sans erreur (succès direct)", () => {
	let attempts = 0;
	const outcome = selfHealing.runWithSelfHealing(
		() => {
			attempts++;
			return "OK";
		},
		{ maxAttempts: 3, workspace: __dirname },
	);
	assert.strictEqual(outcome.success, true);
	assert.strictEqual(attempts, 1);
	assert.strictEqual(outcome.result, "OK");
});

// 5. Test runWithSelfHealing (Succès après retry)
runTest("5. Auto-réparation avec retry réussi", () => {
	let attempts = 0;
	const outcome = selfHealing.runWithSelfHealing(
		() => {
			attempts++;
			if (attempts < 2) {
				const err = new Error(
					"Syntax error at C:\\Users\\DELL\\.smolcoder\\test.js:12:4",
				);
				err.stack =
					"Error: Fail\n    at C:\\Users\\DELL\\.smolcoder\\test.js:12:4";
				throw err;
			}
			return "REPAIRED";
		},
		{ maxAttempts: 3, workspace: __dirname },
	);
	assert.strictEqual(outcome.success, true);
	assert.strictEqual(attempts, 2);
	assert.strictEqual(outcome.result, "REPAIRED");
});

// 6. Test Rollback après échec définitif dans un environnement isolé hermétique
runTest("6. Rollback Git après échec définitif (Isolé)", () => {
	const tempDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "smolcoder-healing-test-"),
	);
	try {
		// Initialisation d'un repo git jetable dédié
		execSync("git init", { cwd: tempDir, stdio: "ignore" });
		execSync('git config user.name "Test"', { cwd: tempDir, stdio: "ignore" });
		execSync('git config user.email "test@example.com"', {
			cwd: tempDir,
			stdio: "ignore",
		});
		fs.writeFileSync(path.join(tempDir, "base.txt"), "healthy baseline");
		execSync('git add base.txt && git commit -m "Initial commit"', {
			cwd: tempDir,
			stdio: "ignore",
		});

		const corruptFile = path.join(tempDir, "corrupt.tmp");
		fs.writeFileSync(corruptFile, "corrupted content");

		const outcome = selfHealing.runWithSelfHealing(
			() => {
				throw new Error("Fatal unrecoverable failure");
			},
			{ maxAttempts: 2, workspace: tempDir, autoRollback: true },
		);

		assert.strictEqual(outcome.success, false);
		assert.strictEqual(
			outcome.rolledBack,
			true,
			"Doit avoir déclenché le rollback",
		);
		assert(
			!fs.existsSync(corruptFile),
			"Le fichier corrompu doit avoir été supprimé par le rollback",
		);
	} finally {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	}
});

console.log("=================================================");
console.log(`RÉSULTAT : ${passed} passés, ${failed} échoués`);
console.log("=================================================");

if (failed > 0) {
	process.exit(1);
}

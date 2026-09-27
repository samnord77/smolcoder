/**
 * visual-tester.js — Moteur de Test Visuel Headless Playwright (Pilier 4)
 * Standard Claude Code & Codex avec Serveur HTTP éphémère pour exécution DOM réelle
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PLAYWRIGHT_CMD = "C:\\npm-global\\playwright-mcp.cmd";

/**
 * Vérifie si le serveur Playwright MCP est disponible
 * @returns {Promise<boolean>}
 */
async function isPlaywrightAvailable() {
	return fs.existsSync(PLAYWRIGHT_CMD);
}

/**
 * Crée un mini-serveur HTTP éphémère pour servir un fichier local à Playwright
 * @param {string} filePath Chemin du fichier
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
function serveLocalFile(filePath) {
	return new Promise((resolve, reject) => {
		try {
			const content = fs.readFileSync(filePath);
			const ext = path.extname(filePath).toLowerCase();
			const contentType =
				ext === ".html"
					? "text/html"
					: ext === ".js"
						? "application/javascript"
						: "text/plain";

			const server = http.createServer((_req, res) => {
				res.writeHead(200, { "Content-Type": contentType });
				res.end(content);
			});

			server.listen(0, "127.0.0.1", () => {
				const addr = server.address();
				const port = typeof addr === "object" && addr ? addr.port : 8080;
				resolve({
					url: `http://127.0.0.1:${port}/`,
					close: () =>
						new Promise((cb) => {
							try {
								server.close(cb);
							} catch {
								cb();
							}
						}),
				});
			});
		} catch (err) {
			reject(err);
		}
	});
}

/**
 * Exécute une session de test Playwright via le protocole MCP
 * @param {Array<object>} requests Liste des requêtes JSON-RPC
 * @param {number} [timeoutMs=10000] Timeout
 * @returns {Promise<Array<object>>}
 */
function runPlaywrightSession(requests, timeoutMs = 12000) {
	return new Promise((resolve, reject) => {
		if (!fs.existsSync(PLAYWRIGHT_CMD)) {
			return reject(new Error("Serveur Playwright MCP introuvable"));
		}

		const proc = spawn(PLAYWRIGHT_CMD, [], {
			stdio: ["pipe", "pipe", "pipe"],
			shell: true,
		});

		let stdoutData = "";
		let _stderrData = "";
		const responses = [];

		proc.stdout.on("data", (chunk) => {
			stdoutData += chunk.toString();
			const lines = stdoutData.split(/\r?\n/);
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const parsed = JSON.parse(trimmed);
					if (parsed.id && !responses.some((r) => r.id === parsed.id)) {
						responses.push(parsed);
					}
				} catch {}
			}

			const lastReq = requests[requests.length - 1];
			if (lastReq && responses.some((r) => r.id === lastReq.id)) {
				clearTimeout(timer);
				setTimeout(() => {
					try {
						proc.kill();
					} catch {}
					resolve(responses);
				}, 100);
			}
		});

		proc.stderr.on("data", (chunk) => {
			_stderrData += chunk.toString();
		});

		// 1. Initialisation MCP
		const initReq = JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2024-11-05",
				clientInfo: { name: "smolcoder-visual-tester", version: "1.0.0" },
				capabilities: {},
			},
		});
		proc.stdin.write(`${initReq}\n`);

		setTimeout(() => {
			proc.stdin.write(
				`${JSON.stringify({
					jsonrpc: "2.0",
					method: "notifications/initialized",
					params: {},
				})}\n`,
			);

			for (const req of requests) {
				proc.stdin.write(`${JSON.stringify(req)}\n`);
			}
		}, 200);

		const timer = setTimeout(() => {
			try {
				proc.kill();
			} catch {}
			resolve(responses);
		}, timeoutMs);

		proc.on("close", () => {
			clearTimeout(timer);
			resolve(responses);
		});

		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

/**
 * Analyse statique de secours si Playwright n'est pas joignable
 * @param {string} filePath
 * @returns {object}
 */
function fallbackStaticAudit(filePath) {
	if (!fs.existsSync(filePath)) {
		return {
			success: false,
			elementCount: 0,
			hasConsoleErrors: true,
			consoleErrors: [`Fichier introuvable : ${filePath}`],
			snapshot: "",
		};
	}

	const content = fs.readFileSync(filePath, "utf8");
	const consoleErrors = [];

	const errorMatches = content.match(
		/console\.error\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g,
	);
	if (errorMatches) {
		for (const m of errorMatches) {
			consoleErrors.push(m);
		}
	}

	const buttonCount = (content.match(/<button\b/gi) || []).length;
	const inputCount = (content.match(/<input\b/gi) || []).length;
	const linkCount = (content.match(/<a\b/gi) || []).length;
	const elementCount = buttonCount + inputCount + linkCount + 1;

	return {
		success: true,
		url: filePath,
		elementCount,
		hasConsoleErrors: consoleErrors.length > 0,
		consoleErrors,
		snapshot: `Static DOM Audit: ${buttonCount} boutons, ${inputCount} champs, ${linkCount} liens`,
	};
}

/**
 * Réalise un audit visuel headless complet d'une page HTML ou d'une URL
 * @param {string} targetUrlOrFile Chemin local ou URL web
 * @param {object} [options]
 * @returns {Promise<{success: boolean, url: string, elementCount: number, hasConsoleErrors: boolean, consoleErrors: Array<string>, snapshot: string}>}
 */
async function auditWebPage(targetUrlOrFile, options = {}) {
	let targetUrl = targetUrlOrFile;
	let ephemeralServer = null;

	const isLocalFile = fs.existsSync(targetUrlOrFile);
	if (isLocalFile) {
		try {
			ephemeralServer = await serveLocalFile(targetUrlOrFile);
			targetUrl = ephemeralServer.url;
		} catch {}
	}

	try {
		const requests = [
			{
				jsonrpc: "2.0",
				id: 10,
				method: "tools/call",
				params: {
					name: "browser_navigate",
					arguments: { url: targetUrl },
				},
			},
			{
				jsonrpc: "2.0",
				id: 20,
				method: "tools/call",
				params: {
					name: "browser_snapshot",
					arguments: {},
				},
			},
			{
				jsonrpc: "2.0",
				id: 30,
				method: "tools/call",
				params: {
					name: "browser_console_messages",
					arguments: {},
				},
			},
			{
				jsonrpc: "2.0",
				id: 40,
				method: "tools/call",
				params: {
					name: "browser_close",
					arguments: {},
				},
			},
		];

		const responses = await runPlaywrightSession(
			requests,
			options.timeoutMs || 8000,
		);

		let snapshot = "";
		const consoleErrors = [];
		let elementCount = 0;

		for (const res of responses) {
			if (res.id === 20 && res.result?.content) {
				const text = res.result.content.map((c) => c.text || "").join("\n");
				snapshot = text;
				elementCount = text
					.split(/\r?\n/)
					.filter((l) => l.trim().length > 0).length;
			}
			if (res.id === 30 && res.result?.content) {
				const logs = res.result.content.map((c) => c.text || "").join("\n");
				if (
					logs.includes("Errors: [") ||
					logs.includes("error") ||
					logs.includes("Error:") ||
					logs.includes("Exception")
				) {
					consoleErrors.push(logs);
				}
			}
		}

		if (elementCount > 0) {
			return {
				success: true,
				url: targetUrl,
				elementCount,
				hasConsoleErrors: consoleErrors.length > 0,
				consoleErrors,
				snapshot,
			};
		}
	} catch {
	} finally {
		if (ephemeralServer) {
			try {
				await ephemeralServer.close();
			} catch {}
		}
	}

	if (isLocalFile) {
		return fallbackStaticAudit(targetUrlOrFile);
	}

	return {
		success: false,
		url: targetUrl,
		elementCount: 0,
		hasConsoleErrors: false,
		consoleErrors: [],
		snapshot: "Audit indisponible",
	};
}

module.exports = {
	isPlaywrightAvailable,
	serveLocalFile,
	auditWebPage,
	fallbackStaticAudit,
};

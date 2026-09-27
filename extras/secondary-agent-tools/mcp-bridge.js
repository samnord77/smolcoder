/**
 * mcp-bridge.js — Passerelle MCP universelle complète pour smolcoder
 * Supporte et exécute automatiquement TOUS les serveurs MCP installés sur la machine
 */

const { spawn } = require("node:child_process");
const _fs = require("node:fs");
const _path = require("node:path");

const KNOWN_MCP_SERVERS = {
	// 1. Raisonnement profond & Pensée séquentielle
	"sequential-thinking": { cmd: "mcp-sequential-thinking.cmd", args: [] },

	// 2. Automatisation & Tests E2E visuels
	playwright: { cmd: "playwright-mcp.cmd", args: [] },
	"chrome-devtools": { cmd: "chrome-devtools-mcp.cmd", args: [] },

	// 3. Contexte, Mémoire & Code Intelligence
	c3: { cmd: "C:\\Users\\DELL\\.local\\bin\\c3-mcp.exe", args: [] },
	memory: { cmd: "mcp-server-memory.cmd", args: [] },
	context7: { cmd: "context7-mcp.cmd", args: [] },
	sqlite: { cmd: "mcp-server-sqlite.exe", args: [] },
	filesystem: { cmd: "mcp-server-filesystem.cmd", args: [] },

	// 4. Sécurité & Modèles locaux
	laya: {
		cmd: "C:\\Python314\\python.exe",
		args: [
			"C:\\Users\\DELL\\AppData\\Roaming\\Python\\Python314\\Scripts\\mcp_laya.py",
		],
	},
	"python-sandbox": {
		cmd: "C:\\Python313\\Scripts\\python-mcp-server.exe",
		args: [],
	},

	// 5. Recherche Web & Extraction
	firecrawl: { cmd: "firecrawl-mcp.cmd", args: [] },
	duckduckgo: { cmd: "duckduckgo-mcp-server.cmd", args: [] },
	tavily: { cmd: "tavily-mcp.cmd", args: [] },
	scrapling: { cmd: "C:\\Python314\\Scripts\\scrapling-mcp.exe", args: [] },
	youtube: { cmd: "youtube-transcript-mcp.cmd", args: [] },

	// 6. Bureautique & Documents
	excel: { cmd: "excel-mcp-server.cmd", args: [] },
	word: { cmd: "C:\\Users\\DELL\\.local\\bin\\word_mcp_server.exe", args: [] },
};

function listAvailableServers() {
	console.log("\n=================================================");
	console.log(
		`SERVEURS MCP PRÊTS À L'EMPLOI SUR CETTE MACHINE (${Object.keys(KNOWN_MCP_SERVERS).length} DISPONIBLES) :`,
	);
	console.log("=================================================\n");
	for (const [name, conf] of Object.entries(KNOWN_MCP_SERVERS)) {
		console.log(`- ${name.padEnd(22)} : Commande -> ${conf.cmd}`);
	}
	console.log("\nUsage pour exécuter :");
	console.log(
		"node mcp-bridge.js list <serveur>           (ex: node mcp-bridge.js list playwright)",
	);
	console.log(
		'node mcp-bridge.js call <serveur> <outil>   (ex: node mcp-bridge.js call sequential-thinking sequentialthinking \'{"thought":"mon raisonnement"}\')',
	);
}

function runMcpJsonRpc(serverName, requests, timeoutMs = 5000) {
	return new Promise((resolve, reject) => {
		const server = KNOWN_MCP_SERVERS[serverName];
		if (!server) {
			return reject(
				new Error(
					`Serveur MCP "${serverName}" inconnu. Tapez "node mcp-bridge.js servers" pour voir la liste.`,
				),
			);
		}

		const isCmd =
			typeof server.cmd === "string" &&
			(server.cmd.endsWith(".cmd") || server.cmd.endsWith(".bat"));
		const proc = spawn(server.cmd, server.args || [], {
			stdio: ["pipe", "pipe", "pipe"],
			shell: isCmd,
		});

		let output = "";
		let errorOutput = "";

		proc.stdout.on("data", (chunk) => {
			const str = chunk.toString();
			output += str;
			const lastReq = requests[requests.length - 1];
			if (
				lastReq &&
				(str.includes(`"id":${lastReq.id}`) ||
					str.includes(`"id": ${lastReq.id}`))
			) {
				clearTimeout(timer);
				setTimeout(() => {
					try {
						proc.kill();
					} catch {}
					resolve({ output, errorOutput });
				}, 50);
			}
		});

		proc.stderr.on("data", (chunk) => {
			errorOutput += chunk.toString();
		});

		const initReq = `${JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2024-11-05",
				clientInfo: { name: "smolcoder-mcp-bridge", version: "2.0.0" },
				capabilities: {},
			},
		})}\n`;

		proc.stdin.write(initReq);

		setTimeout(() => {
			proc.stdin.write(
				`${JSON.stringify({
					jsonrpc: "2.0",
					id: 2,
					method: "notifications/initialized",
					params: {},
				})}\n`,
			);

			for (const req of requests) {
				proc.stdin.write(`${JSON.stringify(req)}\n`);
			}
		}, 150);

		const timer = setTimeout(() => {
			try {
				proc.kill();
			} catch {}
			resolve({ output, errorOutput });
		}, timeoutMs);

		proc.on("close", () => {
			clearTimeout(timer);
			resolve({ output, errorOutput });
		});

		proc.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
	});
}

async function listTools(serverName) {
	console.log(
		`[MCP Bridge] Interrogation des outils pour le serveur: ${serverName}...`,
	);
	const req = { jsonrpc: "2.0", id: 10, method: "tools/list", params: {} };
	const res = await runMcpJsonRpc(serverName, [req]);

	const lines = res.output.trim().split("\n");
	let found = false;
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line);
			if (parsed.id === 10 && parsed.result?.tools) {
				found = true;
				console.log(`\nOutils disponibles sur "${serverName}" :`);
				for (const tool of parsed.result.tools) {
					console.log(`- ${tool.name}: ${tool.description}`);
				}
				return parsed.result.tools;
			}
		} catch {
			// Ignorer les fragments non-JSON
		}
	}
	if (!found) {
		console.log(res.output || res.errorOutput || "Aucun outil retourné.");
	}
}

async function callTool(serverName, toolName, argsObj = {}) {
	console.log(
		`[MCP Bridge] Appel de l'outil "${toolName}" sur "${serverName}"...`,
	);
	const req = {
		jsonrpc: "2.0",
		id: 20,
		method: "tools/call",
		params: { name: toolName, arguments: argsObj },
	};
	const res = await runMcpJsonRpc(serverName, [req], 8000);

	const lines = res.output.trim().split("\n");
	for (const line of lines) {
		try {
			const parsed = JSON.parse(line);
			if (parsed.id === 20 && parsed.result) {
				console.log("\nRésultat MCP :");
				console.log(JSON.stringify(parsed.result, null, 2));
				return parsed.result;
			}
		} catch {
			// Continuer
		}
	}
	console.log(res.output || res.errorOutput);
}

const [, , action, server, tool, argsJson] = process.argv;

if (!action || action === "servers") {
	listAvailableServers();
} else if (action === "list" && server) {
	listTools(server).catch(console.error);
} else if (action === "call" && server && tool) {
	const args = argsJson ? JSON.parse(argsJson) : {};
	callTool(server, tool, args).catch(console.error);
} else {
	console.log("Usage:");
	console.log("  node mcp-bridge.js servers");
	console.log("  node mcp-bridge.js list <serveur>");
	console.log("  node mcp-bridge.js call <serveur> <outil> [arguments_json]");
}

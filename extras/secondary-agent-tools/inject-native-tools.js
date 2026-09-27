/**
 * inject-native-tools.js — Intégration native complète pour TOUTES les interfaces de Smolcoder :
 * Interface 1 : CLI Global (C:\npm-global\node_modules\smolcoder)
 * Interface 2 : Web Hub Browser (smol --web / smol-web.cmd)
 * Interface 3 : IDE Electron Desktop (C:\Users\DELL\smolcoder-source\desktop)
 *
 * Outils & Capacités injectés :
 * 1. 179 Skills (recherche et chargement instantané)
 * 2. Mémoire Vectorielle Infinie ChromaDB (stockage & rappel sémantique)
 * 3. web_fetch (extraction propre HTTP/HTTPS pour documentation et APIs en ligne)
 * 4. think (scratchpad de réflexion séquentielle pas-à-pas)
 * 5. subagent (délégation avec 4 rôles spécialisés et boucle fermée --verify)
 * 6. mcp_call (passerelle vers 18 serveurs MCP locaux, Git MCP strictement bloqué)
 * 7. Auto-Linter ultra-rapide Biome (JS/TS/JSON/CSS) & Ruff (Python)
 * 8. Machine à remonter le temps Git Checkpoints automatique
 */

const fs = require("node:fs");
const _path = require("node:path");

const TARGET_FILES = [
	"C:\\npm-global\\node_modules\\smolcoder\\dist\\tools\\index.js",
	"C:\\Users\\DELL\\smolcoder-source\\dist\\tools\\index.js",
	"c:\\Users\\DELL\\.smolcoder\\smolcoder-core\\dist\\tools\\index.js",
];

// 1. Définition des schémas d'outils natifs (Lecture & Raisonnement)
const readToolsSchema = `
        {
            name: "skill",
            description: 'Directly search or load one of the 179 skills on this system (e.g. "codex", "claude-code", "subagent-driven-development", "test-driven-development"). Example: {"action": "load", "name": "codex"} or {"action": "search", "query": "debug"}.',
            parameters: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["search", "load", "list"], description: "Action: search, load or list" },
                    name: { type: "string", description: "Skill name to load" },
                    query: { type: "string", description: "Search keyword" },
                },
                required: ["action"],
            },
        },
        {
            name: "memory",
            description: 'Infinite vector memory powered by local ChromaDB. Store key architecture facts, patterns, or recall knowledge. Example: {"action": "recall", "query": "auth pattern"} or {"action": "store", "key": "arch_rule", "content": "Always use TDD"}.',
            parameters: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["store", "recall", "stats"], description: "Action: store, recall or stats" },
                    key: { type: "string", description: "Memory key or ID (for store)" },
                    content: { type: "string", description: "Content to store (for store)" },
                    query: { type: "string", description: "Semantic search query (for recall)" },
                },
                required: ["action"],
            },
        },
        {
            name: "web_fetch",
            description: 'Fetch web documentation, GitHub source code, or API responses via HTTP/HTTPS. Returns clean text or JSON (max 8000 chars). Example: {"url": "https://raw.githubusercontent.com/..."}.',
            parameters: {
                type: "object",
                properties: {
                    url: { type: "string", description: "The full HTTP or HTTPS URL to fetch" },
                },
                required: ["url"],
            },
        },
        {
            name: "think",
            description: 'Internal chain-of-thought reasoning scratchpad. Use to break down complex tasks, explore edge cases, or plan before making code changes. Example: {"thought": "1. Analyze edge cases... 2. Check types..."}.',
            parameters: {
                type: "object",
                properties: {
                    thought: { type: "string", description: "Detailed reasoning or analysis" },
                },
                required: ["thought"],
            },
        },`;

// 2. Définition des schémas d'outils natifs (Exécution & Délégation)
const execToolsSchema = `
        {
            name: "subagent",
            description: 'Spawn an autonomous subagent for a focused task (roles: implementer, spec_reviewer, quality_reviewer, architect). Example: {"role": "implementer", "task": "Build user auth in src/auth.js", "verify": "npm test"}.',
            parameters: {
                type: "object",
                properties: {
                    role: { type: "string", enum: ["implementer", "spec_reviewer", "quality_reviewer", "architect", "custom"], description: "Specialized role" },
                    task: { type: "string", description: "Detailed task prompt" },
                    verify: { type: "string", description: "Verification command to run for autonomous self-repair" },
                    model: { type: "string", description: "Optional model override (e.g. remote Kaggle model)" },
                },
                required: ["role", "task"],
            },
        },
        {
            name: "mcp_call",
            description: 'Directly invoke an installed MCP server on this machine (laya, c3, playwright, sequential-thinking, firecrawl, duckduckgo, sqlite, memory). Example: {"server": "laya", "tool": "laya_health", "args": {}}. Git MCP is strictly disabled.',
            parameters: {
                type: "object",
                properties: {
                    server: { type: "string", description: "MCP server name: laya, c3, playwright, sequential-thinking, firecrawl, duckduckgo, sqlite, memory" },
                    tool: { type: "string", description: "Tool name on that MCP server" },
                    args: { type: "object", description: "Arguments object for the tool" },
                },
                required: ["server", "tool"],
            },
        },
        {
            name: "ast_search",
            description: 'Semantic & AST symbol indexing powered by Tree-sitter & C3 (Pilier 2). Inspect symbol outlines, find exact definitions, or calculate Blast Radius impact before editing. Example: {"action": "lookup", "symbol": "parseStackTrace"} or {"action": "impact", "symbol": "parseStackTrace"} or {"action": "outline", "file": "self-healing.js"}.',
            parameters: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["outline", "lookup", "impact", "c3_context"], description: "Action: outline (symbols in file), lookup (find definition), impact (find callers / blast radius), c3_context (deep embeddings query)" },
                    symbol: { type: "string", description: "Symbol or function name (for lookup or impact)" },
                    file: { type: "string", description: "Relative or absolute file path (for outline)" },
                    query: { type: "string", description: "Semantic search query (for c3_context)" },
                },
                required: ["action"],
            },
        },
        {
            name: "visual_audit",
            description: 'Headless visual tester & DOM console auditor powered by Playwright MCP (Pilier 4). Audits HTML files or live URLs, catches JavaScript runtime exceptions, and verifies interactive elements. Example: {"target": "index.html"} or {"target": "http://localhost:3000"}.',
            parameters: {
                type: "object",
                properties: {
                    target: { type: "string", description: "Local HTML file path or HTTP URL to audit" },
                },
                required: ["target"],
            },
        },
        {
            name: "voice_transcribe",
            description: 'Local Push-to-Talk voice transcription powered by Whisper on E:\\voice-pro (Pilier 5). Transcribes audio recordings (.wav, .mp3, .m4a) to text instructions without cloud latency. Example: {"audio_path": "recording.wav", "language": "fr"}.',
            parameters: {
                type: "object",
                properties: {
                    audio_path: { type: "string", description: "Path to local audio file" },
                    language: { type: "string", description: "Language code (fr, en, es...)" },
                    model: { type: "string", description: "Whisper model size: tiny, base, small, medium" },
                },
                required: ["audio_path"],
            },
        },`;

// 3. Implémentations d'exécution natives
const executionLogic = `
/* NATIVE_SKILLS_MCP_SUBAGENTS_CHROMA_INJECTED */
const fsSync = require("fs");
const pathSync = require("path");
const cpSync = require("child_process");

function nativeExecuteSkill(args) {
    const action = args.action || "list";
    const roots = [
        "c:\\\\Users\\\\DELL\\\\.smolcoder\\\\skills",
        "C:\\\\Users\\\\DELL\\\\AppData\\\\Roaming\\\\Python\\\\skills",
        "C:\\\\Users\\\\DELL\\\\AppData\\\\Roaming\\\\Python\\\\optional-skills"
    ];
    function getSkillFiles(dir) {
        let res = [];
        if (!fsSync.existsSync(dir)) return res;
        try {
            const entries = fsSync.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
                const full = pathSync.join(dir, e.name);
                if (e.isDirectory()) {
                    const sk = pathSync.join(full, "SKILL.md");
                    if (fsSync.existsSync(sk)) res.push({ name: e.name, path: sk });
                    else res = res.concat(getSkillFiles(full));
                }
            }
        } catch {}
        return res;
    }
    const all = [];
    for (const r of roots) all.push(...getSkillFiles(r));

    if (action === "load") {
        const found = all.find(s => s.name.toLowerCase() === String(args.name || "").toLowerCase());
        if (!found) return "Error: skill '" + args.name + "' not found. Use action 'search' to find available skills.";
        return fsSync.readFileSync(found.path, "utf8");
    }
    if (action === "search") {
        const q = String(args.query || "").toLowerCase();
        const matches = all.filter(s => s.name.toLowerCase().includes(q));
        if (matches.length === 0) return "No skills matching '" + q + "'.";
        return "Found " + matches.length + " skills:\\n" + matches.map(m => "- " + m.name + ": " + m.path).join("\\n");
    }
    return "Total skills available: " + all.length + ". Use search with query to filter.";
}

function nativeExecuteMemory(args) {
    const action = String(args.action || "recall");
    const pyScript = "c:\\\\Users\\\\DELL\\\\.smolcoder\\\\chroma-memory.py";
    const pyExe = "C:\\\\Python314\\\\python.exe";

    let pyArgs = [pyScript, action];
    if (action === "store") {
        pyArgs.push(String(args.key || ("mem_" + Date.now())), String(args.content || ""), "project");
    } else if (action === "recall") {
        pyArgs.push(String(args.query || ""), "3");
    }

    try {
        const res = cpSync.spawnSync(pyExe, pyArgs, {
            encoding: "utf8",
            timeout: 35000,
            env: { ...process.env, PYTHONIOENCODING: "utf-8" }
        });
        return res.stdout || res.stderr || "Memory operation completed.";
    } catch (e) {
        return "Error in memory: " + (e.message || String(e));
    }
}

async function nativeExecuteWebFetch(args) {
    try {
        const targetUrl = String(args.url || "").trim();
        if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
            return "Error: URL must start with http:// or https://";
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(targetUrl, {
            signal: controller.signal,
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
        });
        clearTimeout(timer);
        if (!res.ok) {
            return "HTTP Error " + res.status + ": " + res.statusText;
        }
        const text = await res.text();
        return text.slice(0, 8000);
    } catch (e) {
        return "Fetch error: " + (e.message || String(e));
    }
}

function nativeExecuteThink(args) {
    const thought = String(args.thought || "").trim();
    if (!thought) return "Error: thought is required.";
    return "Reasoning registered (" + thought.length + " chars). Ready to proceed.";
}

function nativeExecuteMcp(args) {
    const serverName = String(args.server || "").toLowerCase();
    const toolName = String(args.tool || "");
    const toolArgs = args.args || {};

    if (serverName === "git" || serverName.includes("git")) {
        return "Error: MCP Git is strictly disabled by user policy. Do not use MCP git.";
    }

    const bridgePath = "c:\\\\Users\\\\DELL\\\\.smolcoder\\\\mcp-bridge.js";
    if (!fsSync.existsSync(bridgePath)) {
        return "Error: mcp-bridge.js not found.";
    }

    try {
        const res = cpSync.spawnSync(process.execPath, [bridgePath, "call", serverName, toolName, JSON.stringify(toolArgs)], {
            encoding: "utf8",
            timeout: 20000
        });
        return res.stdout || res.stderr || "Tool executed with empty output.";
    } catch (e) {
        return "Error executing MCP tool: " + (e.message || String(e));
    }
}

function nativeExecuteSubagent(args, ctx) {
    const role = String(args.role || "implementer");
    const task = String(args.task || "");
    const verifyCmd = args.verify ? String(args.verify) : "";
    const model = args.model ? String(args.model) : "";

    let roleInstruction = "";
    if (role === "implementer") {
        roleInstruction = "ROLE: Implementer. Implement exactly what is specified in the task without placeholder or TODO. Follow TDD.";
    } else if (role === "spec_reviewer") {
        roleInstruction = "ROLE: Spec Compliance Reviewer. Verify that all requirements from the spec are implemented. Output PASS or specific gaps.";
    } else if (role === "quality_reviewer") {
        roleInstruction = "ROLE: Code Quality Reviewer. Review code style, edge cases, error handling, and run linters.";
    } else if (role === "architect") {
        roleInstruction = "ROLE: Software Architect. Analyze architecture, dependencies, and design interfaces without coding.";
    }

    const prompt = "[SUBAGENT ROLE: " + role.toUpperCase() + "]\\n" + roleInstruction + "\\n\\nTASK:\\n" + task;
    const indexPath = pathSync.join(__dirname, "..", "index.js");
    const ws = (ctx && ctx.workspace) ? ctx.workspace : process.cwd();
    const subArgs = [indexPath, ws, "-p", prompt, "-m", "edit"];
    if (verifyCmd) {
        subArgs.push("--verify", verifyCmd, "--verify-attempts", "6");
    }
    let selectedModel = model;
    if (!selectedModel) {
        const mrPath = "c:\\\\Users\\\\DELL\\\\.smolcoder\\\\model-router.js";
        if (fsSync.existsSync(mrPath)) {
            try {
                const mr = require(mrPath);
                selectedModel = mr.getModelForRole(role);
            } catch {}
        }
    }
    if (selectedModel) {
        subArgs.push("--model", selectedModel);
    }

    try {
        const res = cpSync.spawnSync(process.execPath, subArgs, {
            cwd: ws,
            encoding: "utf8",
            timeout: 180000
        });
        return res.stdout || res.stderr || ("Subagent " + role + " completed.");
    } catch (e) {
        return "Error running subagent: " + (e.message || String(e));
    }
}

function nativeExecuteAstSearch(args, ctx) {
    const action = args.action || "lookup";
    const ws = (ctx && ctx.workspace) || process.cwd();
    const astPath = "c:\\\\Users\\\\DELL\\\\.smolcoder\\\\ast-indexer.js";
    if (!fsSync.existsSync(astPath)) {
        return "ast-indexer.js non disponible.";
    }
    const ast = require(astPath);
    if (action === "outline" && args.file) {
        const target = pathSync.isAbsolute(args.file) ? args.file : pathSync.join(ws, args.file);
        const outline = ast.getAstOutline(target);
        return JSON.stringify(outline, null, 2);
    }
    if (action === "lookup" && args.symbol) {
        const found = ast.lookupSymbol(args.symbol, ws);
        return found ? JSON.stringify(found, null, 2) : "Symbole " + args.symbol + " non trouve.";
    }
    if (action === "impact" && args.symbol) {
        const callers = ast.findCallSites(args.symbol, ws);
        return JSON.stringify({ symbol: args.symbol, blast_radius_count: callers.length, callers }, null, 2);
    }
    if (action === "c3_context" && (args.query || args.symbol)) {
        return ast.queryC3Context(args.query || args.symbol, ws);
    }
    return "Action ou parametres invalides pour ast_search.";
}

async function nativeExecuteVisualAudit(args, ctx) {
    const target = args.target;
    if (!target) return "Parametre 'target' requis pour visual_audit.";
    const ws = (ctx && ctx.workspace) || process.cwd();
    const vtPath = "c:\\\\Users\\\\DELL\\\\.smolcoder\\\\visual-tester.js";
    if (!fsSync.existsSync(vtPath)) {
        return "visual-tester.js non disponible.";
    }
    const vt = require(vtPath);
    const resolvedTarget = (!target.startsWith("http://") && !target.startsWith("https://") && !pathSync.isAbsolute(target)) 
        ? pathSync.join(ws, target) 
        : target;
    try {
        const report = await vt.auditWebPage(resolvedTarget);
        return JSON.stringify(report, null, 2);
    } catch (e) {
        return "Erreur lors de l'audit visuel : " + (e.message || String(e));
    }
}

function nativeExecuteVoiceTranscribe(args, ctx) {
    const audioPath = args.audio_path;
    if (!audioPath) return "audio_path is required.";
    const ws = (ctx && ctx.workspace) || process.cwd();
    const vcPath = "c:\\\\Users\\\\DELL\\\\.smolcoder\\\\voice-commander.js";
    if (!fsSync.existsSync(vcPath)) {
        return "voice-commander.js non disponible.";
    }
    const vc = require(vcPath);
    const resolvedPath = pathSync.isAbsolute(audioPath) ? audioPath : pathSync.join(ws, audioPath);
    const result = vc.transcribeAudio(resolvedPath, {
        language: args.language || "fr",
        model: args.model || "base"
    });
    return JSON.stringify(result, null, 2);
}
`;

const switchCases = `
            case "skill":
                result = nativeExecuteSkill(args);
                break;
            case "memory":
                result = nativeExecuteMemory(args);
                break;
            case "web_fetch":
                result = await nativeExecuteWebFetch(args);
                break;
            case "think":
                result = nativeExecuteThink(args);
                break;
            case "subagent":
                result = nativeExecuteSubagent(args, ctx);
                break;
            case "mcp_call":
                result = nativeExecuteMcp(args);
                break;
            case "ast_search":
                result = nativeExecuteAstSearch(args, ctx);
                break;
            case "visual_audit":
                result = await nativeExecuteVisualAudit(args, ctx);
                break;
            case "voice_transcribe":
                result = nativeExecuteVoiceTranscribe(args, ctx);
                break;
`;

const newAfterWrite = `function afterWrite(workspace, relPath) {
    try {
        const abs = (0, sandbox_1.resolveInWorkspace)(workspace, relPath);
        
        // 1. Auto-Linter instantané Biome & Ruff
        const ext = pathSync.extname(relPath).toLowerCase();
        if ([".js", ".jsx", ".ts", ".tsx", ".json", ".css"].includes(ext)) {
            try {
                cpSync.spawnSync(process.execPath, ["C:\\\\Users\\\\DELL\\\\AppData\\\\Roaming\\\\npm\\\\node_modules\\\\@biomejs\\\\biome\\\\bin\\\\biome", "format", "--write", abs], { timeout: 3000 });
            } catch {}
        } else if (ext === ".py") {
            try {
                cpSync.spawnSync("ruff", ["format", abs], { timeout: 3000 });
                cpSync.spawnSync("ruff", ["check", "--fix", abs], { timeout: 3000 });
            } catch {}
        }

        // 2. Auto-Checkpoint silencieux Git
        try {
            cpSync.spawnSync("git", ["add", relPath], { cwd: workspace, timeout: 2000 });
            cpSync.spawnSync("git", ["commit", "-m", "[Auto-Checkpoint] " + relPath], { cwd: workspace, timeout: 3000 });
        } catch {}

        const warning = (0, check_1.syntaxCheck)(abs, relPath);
        return warning ? "\\nWarning: " + warning + " Fix this before moving on (use edit_file)." : "";
    }
    catch {
        return "";
    }
}`;

function injectInTarget(targetFile) {
	if (!fs.existsSync(targetFile)) return;

	const bakFile = `${targetFile}.bak`;
	if (fs.existsSync(bakFile)) {
		fs.copyFileSync(bakFile, targetFile);
	} else {
		fs.copyFileSync(targetFile, bakFile);
	}

	let content = fs.readFileSync(targetFile, "utf8");

	if (!content.includes('"skill"')) {
		content = content.replace(
			"const read = [",
			`const read = [${readToolsSchema}`,
		);
		content = content.replace(
			"const exec = [",
			`const exec = [${execToolsSchema}`,
		);
	}

	if (!content.includes("NATIVE_SKILLS_MCP_SUBAGENTS_CHROMA_INJECTED")) {
		content = content.replace(
			"async function executeTool(name, args, ctx, signal) {",
			`${executionLogic}\nasync function executeTool(name, args, ctx, signal) {`,
		);
		content = content.replace(
			"switch (name) {",
			`switch (name) {${switchCases}`,
		);
	}

	content = content.replace(
		/ctx\.filesTouched\.add\(String\(args\.path\)\);/g,
		"if (ctx && ctx.filesTouched) ctx.filesTouched.add(String(args.path));",
	);
	content = content.replace(
		/ctx\.commandsRun\.push\(/g,
		"if (ctx && ctx.commandsRun) ctx.commandsRun.push(",
	);

	const oldAfterWriteRegex =
		/function afterWrite\(workspace, relPath\) \{[\s\S]*?return "";\s*\}\s*\}/;
	content = content.replace(oldAfterWriteRegex, newAfterWrite);

	fs.writeFileSync(targetFile, content, "utf8");
	console.log(`[SUCCÈS] Outils natifs injectés dans : ${targetFile}`);
}

for (const f of TARGET_FILES) {
	injectInTarget(f);
}

console.log(
	"\nTOUTES LES 3 INTERFACES (CLI, Web Hub, IDE Desktop) SONT DÉSORMAIS CABLÉES ET SYNCHRONISÉES !",
);

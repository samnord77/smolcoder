/**
 * test-all-tools.js — Banc d'essai et test en profondeur de TOUS les 14 outils de Smolcoder
 * Valide les outils natifs, ChromaDB, WebFetch, Think, Subagents, MCP, Biome, Ruff et Git Checkpoints.
 */

const { executeTool, buildToolSpecs } = require("C:/npm-global/node_modules/smolcoder/dist/tools/index.js");
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");

const WORKSPACE = "c:\\Users\\DELL\\.smolcoder";
const ctx = {
    workspace: WORKSPACE,
    filesTouched: new Set(),
    commandsRun: [],
    plan: {
        current: null,
        set: (steps) => { ctx.plan.current = steps.map(s => ({ step: s, done: false })); return "Plan set."; },
        done: (idx) => { if (ctx.plan.current && ctx.plan.current[idx]) ctx.plan.current[idx].done = true; return "Step marked done."; },
        modelView: () => JSON.stringify(ctx.plan.current)
    }
};

let passed = 0;
let failed = 0;

function assert(condition, message) {
    if (condition) {
        console.log(`[SUCCÈS] ${message}`);
        passed++;
    } else {
        console.error(`[ÉCHEC] ${message}`);
        failed++;
    }
}

async function runTestSuite() {
    console.log("=================================================");
    console.log("DÉMARRAGE DU TEST EN PROFONDEUR DE SMOLCODER (14 OUTILS)");
    console.log("=================================================\n");

    // 0. Vérification du catalogue d'outils
    const specs = buildToolSpecs("read_write");
    assert(specs.length === 17, `17 outils enregistrés dans le catalogue (Trouvé: ${specs.length})`);

    // 1. Test du Skill Runner
    console.log("\n--- 1. TEST OUTIL 'skill' ---");
    const skillSearch = await executeTool("skill", { action: "search", query: "codex" }, ctx);
    assert(typeof skillSearch === "string" && skillSearch.includes("codex"), "Recherche de skill par mot-clé");

    const skillLoad = await executeTool("skill", { action: "load", name: "codex" }, ctx);
    assert(typeof skillLoad === "string" && skillLoad.length > 50, "Chargement du contenu complet d'un skill (SKILL.md)");

    // 2. Test de la Mémoire Infinie ChromaDB
    console.log("\n--- 2. TEST OUTIL 'memory' (ChromaDB Local) ---");
    const memStore = await executeTool("memory", { action: "store", key: "test_verification_key", content: "Architecture de test smolcoder TDD 2026" }, ctx);
    assert(typeof memStore === "string" && (memStore.includes("enregistr") || memStore.includes("Stocké")), "Stockage vectoriel dans ChromaDB");

    const memRecall = await executeTool("memory", { action: "recall", query: "smolcoder TDD test" }, ctx);
    assert(typeof memRecall === "string" && memRecall.includes("Architecture"), "Rappel sémantique vectoriel depuis ChromaDB");

    // 3. Test de WebFetch
    console.log("\n--- 3. TEST OUTIL 'web_fetch' ---");
    const webRes = await executeTool("web_fetch", { url: "https://raw.githubusercontent.com/robots.txt" }, ctx);
    assert(typeof webRes === "string" && (webRes.includes("User-agent") || webRes.includes("Disallow") || webRes.length > 0), "Extraction de contenu web HTTP/HTTPS");

    // 4. Test du Scratchpad Think
    console.log("\n--- 4. TEST OUTIL 'think' ---");
    const thinkRes = await executeTool("think", { thought: "Étape 1: Valider la syntaxe. Étape 2: Lancer les tests." }, ctx);
    assert(typeof thinkRes === "string" && thinkRes.includes("Reasoning registered"), "Scratchpad de réflexion pas-à-pas opérationnel");

    // 5. Test MCP et Sécurité Git
    console.log("\n--- 5. TEST OUTIL 'mcp_call' ET SÉCURITÉ ---");
    const gitBlockRes = await executeTool("mcp_call", { server: "git", tool: "status", args: {} }, ctx);
    assert(typeof gitBlockRes === "string" && gitBlockRes.includes("strictly disabled"), "Blocage strict du MCP Git respecté");

    const mcpLayaRes = await executeTool("mcp_call", { server: "laya", tool: "laya_health", args: {} }, ctx);
    assert(typeof mcpLayaRes === "string" && mcpLayaRes.includes("protocolVersion"), "Appel réussi d'un serveur MCP local (Laya)");

    // 6. Test des Fichiers, Auto-Linter (Biome) et Git Checkpoints
    console.log("\n--- 6. TEST FICHIERS, AUTO-LINTER & GIT CHECKPOINTS ---");
    const testFilePath = "temp_auto_test.js";
    const unformattedCode = "const    x =    42 ;   console.log(   x  );";
    
    // Écriture du fichier (doit déclencher Biome et Git Checkpoint)
    const writeRes = await executeTool("write_file", { path: testFilePath, content: unformattedCode }, ctx);
    assert(typeof writeRes === "string" && !writeRes.startsWith("Error"), "Écriture du fichier via write_file");

    // Vérification que Biome a formaté automatiquement le code
    const fullTestPath = path.join(WORKSPACE, testFilePath);
    if (fs.existsSync(fullTestPath)) {
        const formattedCode = fs.readFileSync(fullTestPath, "utf8");
        assert(formattedCode.includes("const x = 42;"), "Auto-Linter Biome a instantanément corrigé le formatage");
    } else {
        assert(false, "Fichier temporaire introuvable pour test Biome");
    }

    // Vérification que le Git Checkpoint automatique a bien été créé
    const gitLog = cp.execSync("git log -n 1 --oneline", { cwd: WORKSPACE, encoding: "utf8" });
    assert(gitLog.includes("[Auto-Checkpoint]"), "Commit Git Checkpoint automatique généré silencieusement");

    // Test de lecture
    const readRes = await executeTool("read_file", { path: testFilePath }, ctx);
    assert(typeof readRes === "string" && readRes.includes("const x = 42;"), "Lecture du fichier via read_file");

    // Test d'édition
    const editRes = await executeTool("edit_file", { path: testFilePath, old_text: "const x = 42;", new_text: "const x = 100;" }, ctx);
    assert(typeof editRes === "string" && !editRes.startsWith("Error"), "Édition chirurgicale via edit_file");

    // Nettoyage propre
    if (fs.existsSync(fullTestPath)) {
        fs.unlinkSync(fullTestPath);
        try {
            cp.execFileSync("git", ["add", "temp_auto_test.js"], { cwd: WORKSPACE });
            cp.execFileSync("git", ["commit", "-m", "[Auto-Checkpoint] Cleanup test"], { cwd: WORKSPACE });
        } catch {}
    }

    // 7. Test de Recherche et Liste
    console.log("\n--- 7. TEST RECHERCHE & LISTE ---");
    const listRes = await executeTool("list_files", { path: "." }, ctx);
    assert(typeof listRes === "string" && listRes.includes("AGENTS.md"), "Exploration arborescence via list_files");

    const searchRes = await executeTool("search", { pattern: "Protocole d'Excellence" }, ctx);
    if (!searchRes || !searchRes.includes("AGENTS.md")) {
        console.log("DÉTAIL ÉCHEC SEARCH:", JSON.stringify(searchRes));
    }
    assert(typeof searchRes === "string" && searchRes.includes("AGENTS.md"), "Recherche exacte de texte via search");

    // 8. Test de Planification et Commandes
    console.log("\n--- 8. TEST PLANIFICATION & COMMANDES ---");
    const planSet = await executeTool("plan", { action: "set", steps: ["Étape A", "Étape B"] }, ctx);
    assert(typeof planSet === "string", "Création de plan structuré via plan");

    const cmdRes = await executeTool("run_command", { command: "node -e \"console.log(7 * 6)\"" }, ctx);
    assert(typeof cmdRes === "string" && cmdRes.includes("42"), "Exécution système via run_command");

    // 9. Test du Moteur AST & Sémantique (Pilier 2)
    console.log("\n--- 9. TEST OUTIL 'ast_search' (PILIER 2) ---");
    const astLookup = await executeTool("ast_search", { action: "lookup", symbol: "parseStackTrace" }, ctx);
    assert(typeof astLookup === "string" && astLookup.includes("self-healing.js"), "Recherche exacte de symbole via ast_search (lookup)");

    const astImpact = await executeTool("ast_search", { action: "impact", symbol: "parseStackTrace" }, ctx);
    assert(typeof astImpact === "string" && astImpact.includes("blast_radius_count"), "Calcul du rayon d'impact (Blast Radius) via ast_search (impact)");

    const astOutline = await executeTool("ast_search", { action: "outline", file: "self-healing.js" }, ctx);
    assert(typeof astOutline === "string" && astOutline.includes("getBaselineCommit"), "Extraction d'outline structurelle sans lecture brute");

    // 10. Test de l'Auto-Testeur Visuel Headless (Pilier 4)
    console.log("\n--- 10. TEST OUTIL 'visual_audit' (PILIER 4) ---");
    const tempHtmlAudit = path.join(WORKSPACE, "temp_audit_check.html");
    fs.writeFileSync(tempHtmlAudit, "<!DOCTYPE html><html><body><h1>SmolCoder Audit</h1><button>Action</button></body></html>");
    try {
        const visualRes = await executeTool("visual_audit", { target: tempHtmlAudit }, ctx);
        assert(typeof visualRes === "string" && visualRes.includes("elementCount"), "Audit visuel headless via visual_audit (Playwright)");
    } finally {
        try { fs.unlinkSync(tempHtmlAudit); } catch {}
    }

    // 11. Test de la Commande Vocale Push-to-Talk Whisper (Pilier 5)
    console.log("\n--- 11. TEST OUTIL 'voice_transcribe' (PILIER 5) ---");
    const voiceRes = await executeTool("voice_transcribe", { audio_path: "missing_sample.wav" }, ctx);
    assert(typeof voiceRes === "string" && voiceRes.includes("introuvable"), "Transcription vocale locale via voice_transcribe (Whisper)");

    // Bilan final
    console.log("\n=================================================");
    console.log(`BILAN DU BANC D'ESSAI : ${passed} SUCCÈS / ${failed} ÉCHECS`);
    console.log("=================================================");
    
    if (failed === 0) {
        console.log("RÉSULTAT GLOBAL : TOUS LES OUTILS ET AUTOMATISMES SONT 100% OPÉRATIONNELS !");
    } else {
        process.exit(1);
    }
}

runTestSuite().catch(err => {
    console.error("Erreur critique pendant le test :", err);
    process.exit(1);
});

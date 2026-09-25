// Smolcoder Desktop (Electron) — main process.
// Shell natif autour du hub web existant : fenetre principale (hub complet),
// editeur de fichiers integre, menus natifs pour /models /mode /effort /tasks.
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const fs = require("fs");
const path = require("path");
const hub = require("./hub-client");

const ROOT = path.join(__dirname, ".."); // smolcoder-source
const DIST_INDEX = path.join(ROOT, "dist", "index.js");
const { resolveInWorkspace } = require(path.join(ROOT, "dist", "sandbox.js"));

let hubRec = null;
let hubBase = "";
let activeSid = null;
let mainWin = null;
let editorWin = null;
let editorRoot = null;
let currentProjectDir = ROOT;
let hubWatchTimer = null;

function hubMsg(text) {
  return hub.sendSlash(hubRec, text).catch((e) => errBox(e.message));
}

function errBox(msg) {
  dialog.showMessageBox({ type: "warning", title: "Smolcoder Desktop", message: String(msg) });
}

function stopHubWatchdog() {
  if (hubWatchTimer) {
    clearInterval(hubWatchTimer);
    hubWatchTimer = null;
  }
}

function startHubWatchdog(win) {
  stopHubWatchdog();
  let fails = 0;
  let alerted = false;
  let busy = false;
  hubWatchTimer = setInterval(async () => {
    if (!mainWin || win !== mainWin || win.isDestroyed()) {
      stopHubWatchdog();
      return;
    }
    if (busy) return;
    busy = true;
    try {
      await hub.snapshot(hubRec);
      fails = 0;
    } catch {
      fails += 1;
      if (fails >= 2 && !alerted) {
        alerted = true;
        stopHubWatchdog();
        errBox("Serveur injoignable — rouvrez l'IDE quand il tourne");
      }
    } finally {
      busy = false;
    }
  }, 15000);
  if (hubWatchTimer.unref) hubWatchTimer.unref();
}

function openMainWindow() {
  mainWin = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "Smolcoder",
    autoHideMenuBar: false,
    backgroundColor: "#1a1a1a",
  });
  const win = mainWin;
  let retried = false;
  win.webContents.on("did-fail-load", async (_e, _code, _desc, _url, isMainFrame) => {
    if (isMainFrame === false || win.isDestroyed()) return;
    if (!retried) {
      retried = true;
      try {
        const r = await hub.ensureHub({ projectDir: currentProjectDir || ROOT, distIndex: DIST_INDEX });
        hubRec = r.rec;
        hubBase = r.url;
        if (!win.isDestroyed()) await win.loadURL(activeSid ? hubBase + "#" + activeSid : hubBase);
        return;
      } catch { /* tombe sur l'errBox ci-dessous */ }
    }
    errBox(`Impossible de joindre le serveur Smolcoder.\nCopiez cette URL dans un navigateur quand il tourne :\n${hubBase || "(serveur arrêté)"}`);
  });
  win.loadURL(activeSid ? hubBase + "#" + activeSid : hubBase);
  startHubWatchdog(win);
  win.on("closed", () => {
    if (mainWin === win) mainWin = null;
    stopHubWatchdog();
  });
}

function openEditor() {
  if (editorWin) {
    editorWin.focus();
    return;
  }
  editorWin = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 700,
    minHeight: 450,
    title: "Smolcoder — \u00c9diteur",
    backgroundColor: "#1e1e1e",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  editorWin.loadFile(path.join(__dirname, "editor.html"));
  editorWin.on("closed", () => { editorWin = null; });
}

let panelWin = null;

function openPanel() {
  if (panelWin) {
    panelWin.focus();
    return;
  }
  panelWin = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    title: "Smolcoder — MCP, plugins & LSP",
    backgroundColor: "#1e1e1e",
    webPreferences: { preload: path.join(__dirname, "preload-panel.js"), contextIsolation: true, nodeIntegration: false },
  });
  panelWin.loadFile(path.join(__dirname, "mcp.html"));
  panelWin.on("closed", () => { panelWin = null; });
}

function buildMenu() {
  const send = (label, text) => ({ label, click: () => hubMsg(text) });
  const template = [
    {
      label: "Projet",
      submenu: [
        {
          label: "Ouvrir un dossier\u2026",
          click: async () => {
            try {
              const r = await dialog.showOpenDialog({ properties: ["openDirectory"] });
              if (r.canceled || !r.filePaths.length) return;
              const res = await hub.api(hubRec, "POST", "/workspaces/add", { path: r.filePaths[0], start: true });
              if (res?.id && mainWin) {
                activeSid = res.id;
                await mainWin.loadURL(hubBase + "#" + res.id);
                mainWin.focus();
              }
            } catch (e) {
              errBox(e.message);
            }
          },
        },
        { type: "separator" },
        { label: "\u00c9diteur de fichiers", accelerator: "CmdOrCtrl+E", click: openEditor },
      ],
    },
    {
      label: "Session",
      submenu: [
        { label: "Nouvelle session", click: () => hubMsg("/clear") },
        { label: "Annuler le tour (esc)", click: () => hub.cancelTurn(hubRec).catch((e) => errBox(e.message)) },
        { type: "separator" },
        { label: "\u00c9diteur de fichiers", accelerator: "CmdOrCtrl+E", click: openEditor },
        { type: "separator" },
        { role: "quit", label: "Quitter" },
      ],
    },
    {
      label: "Mod\u00e8le",
      submenu: [
        { label: "Choisir un mod\u00e8le\u2026", click: () => hubMsg("/models") },
        { label: "Trouver des mod\u00e8les sur le r\u00e9seau\u2026", click: () => hubMsg("/models") },
      ],
    },
    {
      label: "Mode",
      submenu: [
        send("Lecture seule (ro)", "/mode ro"),
        send("\u00c9dition (edit)", "/mode edit"),
        send("Sans demande (bypass)", "/mode bypass"),
        { type: "separator" },
        { label: "Basculer (shift+tab)", click: () => hub.cycleMode(hubRec).catch((e) => errBox(e.message)) },
      ],
    },
    {
      label: "Effort",
      submenu: [send("Off (rapide)", "/effort off"), send("Low", "/effort low"), send("Medium", "/effort medium"), send("High", "/effort high")],
    },
    {
      label: "T\u00e2ches",
      submenu: [
        send("Voir les t\u00e2ches", "/tasks"),
        { type: "separator" },
        { label: "Ouvrir un terminal", click: () => hub.openTerminal(hubRec).then(() => mainWin?.focus()).catch((e) => errBox(e.message)) },
      ],
    },
    {
      label: "Outils",
      submenu: [
        { label: "Panneau MCP, plugins & LSP", accelerator: "CmdOrCtrl+M", click: openPanel },
        { type: "separator" },
        send("Voir le plan", "/plan"),
        send("Contexte", "/context"),
        send("Compacter", "/compact"),
      ],
    },
    {
      label: "Affichage",
      submenu: [
        { role: "reload", label: "Recharger" },
        { role: "toggleDevTools", label: "Outils dev" },
        { type: "separator" },
        { role: "resetZoom", label: "Zoom 100\u00a0%" },
        { role: "zoomIn", label: "Zoom +" },
        { role: "zoomOut", label: "Zoom \u2212" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- editeur : fichiers via le dossier choisi, confines au dossier ----
function assertRoot() {
  if (!editorRoot) throw new Error("Choisissez d\u2019abord un dossier (bouton \u00ab\u00a0Dossier\u00a0\u00bb).");
  return editorRoot;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".smolcoder"]);

ipcMain.handle("ed:pickFolder", async () => {
  const r = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  if (r.canceled || !r.filePaths.length) return null;
  editorRoot = r.filePaths[0];
  return editorRoot;
});

ipcMain.handle("ed:setRoot", async (_e, dir) => {
  editorRoot = dir;
  return editorRoot;
});

ipcMain.handle("ed:list", async (_e, rel) => {
  const root = assertRoot();
  const abs = resolveInWorkspace(root, rel && rel.trim() ? rel : ".");
  const st = fs.statSync(abs);
  if (!st.isDirectory()) throw new Error("Pas un dossier.");
  const names = fs.readdirSync(abs, { withFileTypes: true });
  const out = [];
  for (const e of names) {
    if (e.name.startsWith(".") && e.isDirectory()) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    out.push({ name: e.name, dir: e.isDirectory() });
    if (out.length >= 500) break;
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return out;
});

ipcMain.handle("ed:read", async (_e, rel) => {
  const root = assertRoot();
  const abs = resolveInWorkspace(root, rel);
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new Error("C\u2019est un dossier.");
  if (st.size > 1024 * 1024) throw new Error("Fichier > 1 Mo : ouvrez-le dans un autre \u00e9diteur.");
  return fs.readFileSync(abs, "utf8");
});

ipcMain.handle("ed:save", async (_e, rel, content) => {
  const root = assertRoot();
  const abs = resolveInWorkspace(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, String(content ?? ""), "utf8");
  return true;
});

ipcMain.handle("ed:askModel", async () => {
  // Propose le dossier du projet courant comme racine d'editeur.
  try {
    const snap = await hub.snapshot(hubRec);
    const ws = snap.workspaces ?? [];
    ws.sort((a, b) => (b.last || 0) - (a.last || 0));
    return ws.length ? ws[0].path : null;
  } catch {
    return null;
  }
});

// ---- panneau MCP / plugins / LSP : memes categories que l'IDE opencode ----
// Serveurs (nom, statut, transport, outils), plugins = skills (nom,
// description courte, source), LSP (disponibilite de l'outil symbols).
ipcMain.handle("panel:data", async () => {
  const { createMcpBridge, loadMcpConfig } = require(path.join(ROOT, "dist", "mcp.js"));
  const { listSkills, readSkill } = require(path.join(ROOT, "dist", "skills.js"));
  const { BUILTIN_SKILLS } = require(path.join(ROOT, "dist", "builtin-skills.js"));
  let workspace = editorRoot;
  if (!workspace) {
    try {
      const snap = await hub.snapshot(hubRec);
      const ws = (snap.workspaces ?? []).sort((a, b) => (b.last || 0) - (a.last || 0));
      workspace = ws.length ? ws[0].path : ROOT;
    } catch {
      workspace = ROOT;
    }
  }
  const cfgs = loadMcpConfig(workspace);
  const transportOf = (name) => {
    const c = cfgs.find((s) => s.name.toLowerCase() === String(name).toLowerCase());
    if (!c) return "?";
    if (c.url) return c.url;
    return [c.command, ...(c.args ?? [])].filter(Boolean).join(" ");
  };
  let servers = [];
  try {
    const bridge = createMcpBridge(workspace);
    try {
      // 20s comme /mcp : à 8s les serveurs npx passent "too slow" à tort.
      servers = (await bridge.status(20000)).map((r) => ({
        name: r.name,
        ok: !!r.ok,
        tools: r.tools ?? [],
        error: r.error ?? null,
        transport: transportOf(r.name),
      }));
    } finally {
      bridge.closeAll();
    }
  } catch (e) {
    servers = cfgs.map((c) => ({ name: c.name, ok: false, tools: [], error: String(e.message ?? e), transport: transportOf(c.name) }));
  }
  // Plugins = skills : lus + integres, avec leur premiere ligne en description.
  const firstLine = (t) => String(t ?? "").split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  let skills = [];
  try {
    const m = /Skills \(\d+\): (.*)$/.exec(listSkills(workspace).replace(/\n/g, " ")) ;
    const names = m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : [];
    for (const n of names.slice(0, 60)) {
      const builtin = /\(built-in\)$/.test(n);
      const clean = n.replace(/\s*\(built-in\)$/, "");
      let desc = "";
      try {
        desc = builtin ? firstLine(BUILTIN_SKILLS[clean]) : firstLine(readSkill(workspace, clean));
      } catch { /* sans description */ }
      skills.push({ name: clean, builtin, desc: desc.slice(0, 140) });
    }
  } catch (e) {
    skills = [{ name: "?", builtin: false, desc: String(e.message ?? e) }];
  }
  // LSP : pas de serveur local requis pour la validation ; le binaire
  // typescript-language-server rend le direct (survol, definition) possible.
  let lspServer = null;
  for (const dir of String(process.env.PATH ?? "").split(";")) {
    for (const exe of ["typescript-language-server.cmd", "typescript-language-server"]) {
      try {
        fs.accessSync(path.join(dir, exe));
        lspServer = path.join(dir, exe);
        break;
      } catch { /* suivant */ }
    }
    if (lspServer) break;
  }
  return {
    workspace,
    servers,
    skills,
    lsp: {
      tool: "symbols (hover, d\u00e9finition, r\u00e9f\u00e9rences, diagnostics)",
      available: true,
      serverBinary: lspServer,
      note: lspServer
        ? "Serveur LSP install\u00e9 : survol et d\u00e9finitions en direct possibles."
        : "Validation sans serveur OK ; installez typescript-language-server pour le direct.",
    },
  };
});

app.whenReady().then(async () => {
  if (!fs.existsSync(DIST_INDEX)) {
    dialog.showErrorBox("Smolcoder Desktop", `dist/index.js introuvable.\nLancez d\u2019abord : npm run build\n(dans ${ROOT})`);
    app.quit();
    return;
  }
  let projectDir = ROOT;
  try {
    projectDir = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : ROOT;
    currentProjectDir = projectDir;
    const r = await hub.ensureHub({ projectDir, distIndex: DIST_INDEX });
    hubRec = r.rec;
    hubBase = r.url;
  } catch (e) {
    dialog.showErrorBox("Smolcoder Desktop", e.message);
    app.quit();
    return;
  }
  // Branche tout de suite : reprend la derniere session (ou neuve) et ouvre
  // un terminal, pour ne jamais demarrer sur une fenetre vide.
  try {
    activeSid = await hub.ensureSession(hubRec, projectDir);
    try {
      await hub.openTerminalSid(hubRec, activeSid);
    } catch { /* le bouton +>_ reste dispo */ }
  } catch (e) {
    errBox(`Session : ${e.message}`);
  }
  buildMenu();
  openMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

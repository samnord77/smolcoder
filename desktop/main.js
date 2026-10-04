// Smolcoder Desktop (Electron) — main process.
// Shell natif autour du hub web existant : fenetre principale (hub complet),
// editeur de fichiers integre, menus natifs pour /models /mode /effort /tasks.
const { app, BrowserWindow, Menu, clipboard, dialog, ipcMain } = require("electron");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const hub = require("./hub-client");

const ROOT = path.join(__dirname, ".."); // smolcoder-source
const DIST_INDEX = path.join(ROOT, "dist", "index.js");
const DIST_SANDBOX = path.join(ROOT, "dist", "sandbox.js");
let APP_VERSION = "0.0.0";
let gitService;
let editorFileService;
let resolveInWorkspace;
let searchWorkspace;
try {
  APP_VERSION = require(path.join(ROOT, "package.json")).version || APP_VERSION;
} catch {
  /* version inconnue : la garde anti-vieux-hub est désactivée */
}

/** dist/ state via the shared checker when built, else a local fallback. */
function distState() {
  if (!fs.existsSync(DIST_INDEX) || !fs.existsSync(DIST_SANDBOX)) return "missing";
  try {
    return require(path.join(ROOT, "dist", "build-check.js")).distState(ROOT);
  } catch {
    try {
      if (!fs.existsSync(DIST_INDEX)) return "missing";
    } catch {
      return "unknown";
    }
    return "unknown";
  }
}

function runBuild() {
  try {
    const checker = require(path.join(ROOT, "dist", "build-check.js"));
    if (checker.runBuild(ROOT, () => {}) && fs.existsSync(DIST_INDEX) && fs.existsSync(DIST_SANDBOX)) return true;
  } catch {
    /* fall through to the local npm hunt below */
  }
  const candidates = ["npm", "npm.cmd"];
  try {
    for (const base of [process.env.ProgramFiles, "C:\\Program Files", "C:\\Program Files (x86)"]) {
      if (base) candidates.push(path.join(base, "nodejs", "npm.cmd"));
    }
  } catch {
    /* variables d'environnement illisibles */
  }
  for (const cmd of candidates) {
    try {
      const r = spawnSync(cmd, ["run", "build"], {
        cwd: ROOT,
        shell: true,
        timeout: 300000,
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      });
      if (!r.error && r.status === 0 && fs.existsSync(DIST_INDEX) && fs.existsSync(DIST_SANDBOX)) return true;
    } catch {
      /* commande suivante */
    }
  }
  return false;
}

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
      if (fails >= 2) {
        try {
          const ensured = await hub.ensureHub(cfg, (line) => console.log(line));
          if (ensured?.rec && !win.isDestroyed()) {
            hubRec = ensured.rec;
            const sid = await hub.ensureSession(hubRec, projectDir);
            const targetUrl = `http://127.0.0.1:${hubRec.port}/?k=${hubRec.token}#${sid}`;
            win.loadURL(targetUrl);
            fails = 0;
          }
        } catch {
          /* Nouvelle tentative automatique au prochain cycle */
        }
      }
    } finally {
      busy = false;
    }
  }, 10000);
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
        if (!win.isDestroyed()) await win.webContents.session.clearCache().catch(() => {});
        win.loadURL(activeSid ? `${hubBase}#${activeSid}` : hubBase);
        return;
      } catch { /* tombe sur l'errBox ci-dessous */ }
    }
    errBox(`Impossible de joindre le serveur Smolcoder.\nCopiez cette URL dans un navigateur quand il tourne :\n${hubBase || "(serveur arrêté)"}`);
  });
  win.webContents.session.clearCache().catch(() => {});
  win.loadURL(activeSid ? `${hubBase}#${activeSid}` : hubBase);
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
let gitWin = null;

function openGit() {
  if (gitWin) { gitWin.focus(); return; }
  gitWin = new BrowserWindow({
    width: 1120, height: 760, minWidth: 760, minHeight: 520,
    title: "Smolcoder - Git", backgroundColor: "#1e1e1e",
    webPreferences: { preload: path.join(__dirname, "preload-git.js"), contextIsolation: true, nodeIntegration: false },
  });
  gitWin.loadFile(path.join(__dirname, "git.html"));
  gitWin.on("closed", () => { gitWin = null; });
}

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

/** Read-only live-follow link for the current session (copied to clipboard). */
async function openShare() {
  try {
    const { token } = await hub.withLiveSid(hubRec, (sid) => hub.api(hubRec, "POST", "/sessions/share", { sid }));
    const url = `${String(hubBase).split("?")[0]}?share=${token}`;
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "Smolcoder — partage",
      message: "Lien de suivi en lecture seule :",
      detail: url,
      buttons: ["Copier le lien", "Fermer"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) clipboard.writeText(url);
  } catch (e) {
    errBox(e.message);
  }
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
                await mainWin.loadURL(`${hubBase}#${res.id}`);
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
        { label: "Partager la session (lecture seule)", click: openShare },
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
        { label: "Git", accelerator: "CmdOrCtrl+Shift+G", click: openGit },
        { type: "separator" },
        send("Voir le plan", "/plan"),
        send("Revoir les modifications", "/review"),
        send("Santé des serveurs de langage", "/doctor"),
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
const editorTreeStatusCache = new Map();
async function editorTreeStatus(root) {
  const key = path.resolve(root);
  const cached = editorTreeStatusCache.get(key);
  if (cached?.status && Date.now() - cached.at < 10000) return cached.status;
  if (cached?.promise) return cached.promise;
  const entry = { at: 0, status: null, promise: null };
  entry.promise = gitService.status(root).then((status) => {
    entry.at = Date.now();
    entry.status = status;
    return status;
  }).finally(() => { entry.promise = null; });
  editorTreeStatusCache.set(key, entry);
  return entry.promise;
}

ipcMain.handle("ed:pickFolder", async () => {
  const r = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  if (r.canceled || !r.filePaths.length) return null;
  editorRoot = r.filePaths[0];
  editorTreeStatusCache.clear();
  return editorRoot;
});

ipcMain.handle("ed:setRoot", async (_e, dir) => {
  editorRoot = dir;
  editorTreeStatusCache.clear();
  return editorRoot;
});

ipcMain.handle("ed:list", async (_e, rel) => {
  const root = assertRoot();
  const abs = resolveInWorkspace(root, rel?.trim() ? rel : ".");
  const st = fs.statSync(abs);
  if (!st.isDirectory()) throw new Error("Pas un dossier.");
  const names = fs.readdirSync(abs, { withFileTypes: true });
  const statusMap = new Map();
  try {
    const status = await editorTreeStatus(root);
    const current = path.relative(root, abs).split(path.sep).join("/");
    const prefix = current && current !== "." ? `${current}/` : "";
    const rank = { M: 1, R: 2, A: 3, D: 4, N: 5 };
    for (const file of status.files) {
      const normalized = String(file.path || "").replace(/\\/g, "/");
      if (prefix && !normalized.startsWith(prefix)) continue;
      const child = (prefix ? normalized.slice(prefix.length) : normalized).split("/")[0];
      const badge = file.badge === "U" ? "N" : file.badge;
      if (child && (!statusMap.has(child) || rank[badge] > rank[statusMap.get(child)])) statusMap.set(child, badge);
    }
  } catch {
    /* badges best effort */
  }
  const out = [];
  for (const e of names) {
    if (e.name.startsWith(".") && e.isDirectory()) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    out.push({ name: e.name, dir: e.isDirectory(), status: statusMap.get(e.name) || "" });
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
  return editorFileService.readWorkspaceFile(root, rel);
});
ipcMain.handle("ed:image", async (_e, rel) => editorFileService.readWorkspaceImage(assertRoot(), rel));

ipcMain.handle("ed:search", async (_e, query) => searchWorkspace(assertRoot(), query, { maxMatches: 200 }));
ipcMain.handle("ed:diagnostics", async (_e, rel) => {
  const root = assertRoot();
  try {
    const { queryDiagStructured } = require(path.join(ROOT, "dist", "lsp-pro.js"));
    const r = await queryDiagStructured(root, rel);
    return { message: r.text, diagnostics: r.diagnostics };
  } catch {
    const { workspaceDiagnostics } = require(path.join(ROOT, "dist", "workspace-diagnostics.js"));
    return workspaceDiagnostics(root, rel);
  }
});

ipcMain.handle("ed:backendStatus", async () => {
  try {
    const { probeLocalModelsStatus } = require(path.join(ROOT, "dist", "status.js"));
    return await probeLocalModelsStatus();
  } catch (e) {
    return {
      loaded: [],
      totalVramMb: 0,
      ollamaOnline: false,
      lmStudioOnline: false,
      error: String(e?.message ? e.message : e),
    };
  }
});

ipcMain.handle("ed:save", async (_e, rel, content, expectedMtimeMs) => {
  const root = assertRoot();
  if (typeof content !== "string") throw new Error("Le contenu à enregistrer doit être du texte.");
  if (Buffer.byteLength(content, "utf8") > 1024 * 1024) throw new Error("Fichier > 1 Mo : réduisez son contenu avant de l’enregistrer.");
  const abs = resolveInWorkspace(root, rel);
  if (fs.existsSync(abs)) {
    const current = fs.statSync(abs);
    if (!Number.isFinite(expectedMtimeMs) || Math.abs(current.mtimeMs - expectedMtimeMs) > 1) {
      throw new Error("Le fichier a changé sur le disque. Rechargez-le avant d’enregistrer.");
    }
  } else if (Number.isFinite(expectedMtimeMs)) {
    throw new Error("Le fichier a été supprimé du disque. Rechargez le dossier avant d’enregistrer.");
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  editorTreeStatusCache.delete(path.resolve(root));
  return { mtimeMs: fs.statSync(abs).mtimeMs };
});

ipcMain.handle("ed:new", async (_e, rel, dir) => {
  const root = assertRoot();
  if (!rel || rel === "." || rel === "/") throw new Error("Chemin requis.");
  const abs = resolveInWorkspace(root, rel);
  if (fs.existsSync(abs)) throw new Error(`"${rel}" existe déjà.`);
  if (dir === true) fs.mkdirSync(abs, { recursive: true });
  else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "", "utf8");
  }
  editorTreeStatusCache.delete(path.resolve(root));
  return { path: rel };
});

ipcMain.handle("ed:rename", async (_e, rel, to) => {
  const root = assertRoot();
  if (!rel || !to) throw new Error("Chemins requis.");
  const absFrom = resolveInWorkspace(root, rel);
  const absTo = resolveInWorkspace(root, to);
  if (!fs.existsSync(absFrom)) throw new Error(`"${rel}" n’existe pas.`);
  if (fs.existsSync(absTo)) throw new Error(`"${to}" existe déjà.`);
  fs.mkdirSync(path.dirname(absTo), { recursive: true });
  fs.renameSync(absFrom, absTo);
  editorTreeStatusCache.delete(path.resolve(root));
  return { path: to };
});

ipcMain.handle("ed:delete", async (_e, rel) => {
  const root = assertRoot();
  if (!rel || rel === "." || rel === "/") throw new Error("Chemin requis (jamais le dossier lui-même).");
  const abs = resolveInWorkspace(root, rel);
  if (!fs.existsSync(abs)) throw new Error(`"${rel}" n’existe pas.`);
  if (fs.statSync(abs).isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
  else fs.unlinkSync(abs);
  editorTreeStatusCache.delete(path.resolve(root));
  return {};
});

ipcMain.handle("ed:completion", async (_e, rel, line, col) => {
  const root = assertRoot();
  const { queryCode } = require(path.join(ROOT, "dist", "lsp-pro.js"));
  const out = await queryCode(root, { action: "completion", path: rel, line, col });
  if (typeof out === "string" && out.startsWith("Error")) throw new Error(out);
  const items = String(out)
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .slice(0, 12)
    .map((l) => {
      const body = l.slice(2);
      const m = /^(.+?)(?: \(([^)]*)\))?(?: — (.*))?$/.exec(body);
      return { label: (m ? m[1] : body).trim(), kind: m?.[2] || "", detail: m?.[3] || "" };
    });
  return { items };
});

ipcMain.handle("ed:inlineStart", async (_e, payload) => {
  const root = assertRoot();
  if (!hubRec) throw new Error("Hub Smolcoder requis (fenêtre principale).");
  const sid = await hub.ensureSession(hubRec, root);
  const r = await hub.api(hubRec, "POST", "/code/inline/start", { sid, ...(payload || {}) });
  if (!r?.op) throw new Error("L’édition inline n’a pas démarré.");
  return r;
});

ipcMain.handle("ed:inlineResult", async (_e, op) => {
  if (!hubRec) throw new Error("Hub Smolcoder requis (fenêtre principale).");
  return hub.api(hubRec, "GET", `/code/inline/result?id=${encodeURIComponent(String(op ?? ""))}`, null);
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
async function activeWorkspace() {
  try {
    const snap = await hub.snapshot(hubRec);
    for (const workspace of snap.workspaces ?? []) {
      if ((workspace.sessions ?? []).some((session) => session.id === activeSid)) return workspace.path;
    }
    const recent = [...(snap.workspaces ?? [])].sort((a, b) => (b.last || 0) - (a.last || 0));
    if (recent.length) return recent[0].path;
  } catch { /* use the current project when the hub is offline */ }
  return editorRoot || currentProjectDir || ROOT;
}

ipcMain.handle("ed:gitStatus", async () => gitService.status(assertRoot()));
ipcMain.handle("ed:gitSyncStatus", async () => gitService.syncStatus(assertRoot()));
ipcMain.handle("ed:gitBlame", async (_event, rel, line) => gitService.blame(assertRoot(), rel, line));
ipcMain.handle("git:status", async () => gitService.status(await activeWorkspace()));
ipcMain.handle("git:diff", async (_event, rel) => ({ diff: await gitService.diff(await activeWorkspace(), rel) }));
ipcMain.handle("git:commit", async (_event, message, rel) => gitService.commit(await activeWorkspace(), rel, message));

ipcMain.handle("panel:setEnabled", async (_event, name, enabled) => {
  if (typeof name !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(name) || typeof enabled !== "boolean") {
    throw new Error("Invalid MCP server settings.");
  }
  const workspace = await activeWorkspace();
  const { globalMcpConfigPath, loadMcpConfig } = require(path.join(ROOT, "dist", "mcp.js"));
  const configured = loadMcpConfig(workspace).find((server) => server.name.toLowerCase() === name.toLowerCase());
  if (!configured) throw new Error("This MCP server is no longer configured.");
  const candidates = [path.join(workspace, ".smol", "mcp.json"), globalMcpConfigPath()];
  for (const file of candidates) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.servers) ? raw.servers : null;
    const entry = list?.find((server) => server && typeof server.name === "string" && server.name.toLowerCase() === name.toLowerCase());
    if (!entry) continue;
    entry.enabled = enabled;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    return { enabled };
  }
  throw new Error("MCP configuration file was not found.");
});
ipcMain.handle("panel:data", async () => {
  const { createMcpBridge, loadMcpConfig } = require(path.join(ROOT, "dist", "mcp.js"));
  const { buildToolSpecs } = require(path.join(ROOT, "dist", "tools", "index.js"));
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
        enabled: cfgs.find((server) => server.name.toLowerCase() === String(r.name).toLowerCase())?.enabled !== false,
        error: r.error ?? null,
        transport: transportOf(r.name),
      }));
    } finally {
      bridge.closeAll();
    }
  } catch (e) {
    servers = cfgs.map((c) => ({ name: c.name, ok: false, tools: [], enabled: c.enabled !== false, error: String(e.message ?? e), transport: transportOf(c.name) }));
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
  const toolModes = [
    ["ro", "Lecture seule"],
    ["edit", "Edition"],
    ["bypass", "Sans demande"],
  ];
  const toolMap = new Map();
  for (const [mode, label] of toolModes) {
    for (const tool of buildToolSpecs(mode, { allowDelegate: true })) {
      const current = toolMap.get(tool.name) ?? {
        name: tool.name,
        description: tool.description,
        modes: [],
      };
      if (!current.description && tool.description) current.description = tool.description;
      current.modes.push({ id: mode, label });
      toolMap.set(tool.name, current);
    }
  }
  return {
    workspace,
    servers,
    skills,
    tools: [...toolMap.values()].sort((a, b) => a.name.localeCompare(b.name)),
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
  const st = distState();
  if (st === "missing" || st === "stale") {
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "Smolcoder Desktop",
      message: st === "missing" ? "Première compilation requise." : "Le code source a changé depuis la dernière compilation.",
      detail: "Compiler maintenant ? (~1 minute — affiche ensuite les nouveautés).",
      buttons: st === "missing" ? ["Compiler", "Quitter"] : ["Compiler", "Continuer quand même"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response !== 0) {
      if (st === "missing") {
        app.quit();
        return;
      }
    } else if (!runBuild() || !fs.existsSync(DIST_INDEX)) {
      dialog.showErrorBox(
        "Smolcoder Desktop",
        "La compilation a échoué. Lancez `npm run build` dans un terminal, puis relancez."
      );
      app.quit();
      return;
    }
  }
  if (!fs.existsSync(DIST_INDEX) || !fs.existsSync(DIST_SANDBOX)) {
    dialog.showErrorBox("Smolcoder Desktop", `Fichiers core dist/index.js ou dist/sandbox.js introuvables.\nLancez d\u2019abord : npm run build\n(dans ${ROOT})`);
    app.quit();
    return;
  }
  ({ resolveInWorkspace } = require(DIST_SANDBOX));
  ({ searchWorkspace } = require(path.join(ROOT, "dist", "workspace-search.js")));
  gitService = require("./git-service");
  editorFileService = require("./editor-file-service");
  let projectDir = ROOT;
  try {
    projectDir = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : ROOT;
    currentProjectDir = projectDir;
    try {
      const r = await hub.ensureHub({ projectDir, distIndex: DIST_INDEX, expectedVersion: APP_VERSION });
      hubRec = r.rec;
      hubBase = r.url;
    } catch (e) {
      if (e && e.code === "OLD_HUB") {
        const { response } = await dialog.showMessageBox({
          type: "warning",
          title: "Smolcoder Desktop",
          message: `Un hub v${e.hubVersion} tourne encore — les nouveautés seraient invisibles.`,
          detail: "Le redémarrer ? Les sessions sont sauvegardées et reprendront.",
          buttons: ["Redémarrer le hub", "Continuer quand même"],
          defaultId: 0,
          cancelId: 1,
        });
        if (response === 0) {
          try {
            process.kill(e.hubPid);
          } catch {
            /* déjà arrêté */
          }
          await new Promise((r) => setTimeout(r, 1500));
          const r = await hub.ensureHub({ projectDir, distIndex: DIST_INDEX, expectedVersion: APP_VERSION });
          hubRec = r.rec;
          hubBase = r.url;
        } else {
          const r = await hub.ensureHub({ projectDir, distIndex: DIST_INDEX, allowStale: true });
          hubRec = r.rec;
          hubBase = r.url;
        }
      } else {
        throw e;
      }
    }
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

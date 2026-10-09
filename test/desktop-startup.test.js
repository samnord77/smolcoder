const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const desktopPackage = require("../desktop/package.json");
const rootPackage = require("../package.json");
const fs = require("node:fs");

test("Electron main can load before the shared dist bundle exists", () => {
  const noop = () => {};
  const electron = {
    app: { whenReady: () => new Promise(noop), on: noop, quit: noop },
    BrowserWindow: class {},
    Menu: { buildFromTemplate: () => ({}), setApplicationMenu: noop },
    clipboard: {},
    dialog: {},
    ipcMain: { handle: noop, on: noop },
    shell: {},
  };
  const mainPath = path.join(__dirname, "..", "desktop", "main.js");
  const originalLoad = Module._load;

  Module._load = function (request, parent, isMain) {
    if (request === "electron") return electron;
    if (typeof request === "string" && /(?:^|[\\/])dist[\\/]/i.test(request)) {
      const error = new Error(`Cannot find module '${request}'`);
      error.code = "MODULE_NOT_FOUND";
      throw error;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    assert.doesNotThrow(() => require(mainPath));
    assert.equal(rootPackage.scripts.desktop, "electron desktop");
    assert.match(rootPackage.scripts.predesktop, /npm run build/);
    assert.match(rootPackage.scripts["desktop:smoke"], /npm run build/);
    assert.match(rootPackage.scripts["package-win"], /^npm run build &&/);
    assert.equal(desktopPackage.main, "main.js");
    assert.equal(fs.existsSync(path.join(__dirname, "..", "desktop", "package-lock.json")), false);
    assert.equal(desktopPackage.scripts, undefined);
    assert.equal(desktopPackage.devDependencies, undefined);
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(mainPath)];
  }
});

test("the Windows launcher uses the root Electron install and shared build", () => {
  const readme = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  const launcher = fs.readFileSync(path.join(__dirname, "..", "extras", "secondary-agent-tools", "Lancer-Smolcoder.bat"), "utf8");
  assert.match(readme, /run `npm run desktop`; npm runs `predesktop` first to rebuild the shared `dist\/` core/);
  assert.match(launcher, /call npm --prefix "%SMOL_ROOT%" run build/);
  assert.match(launcher, /start "" "%SMOL_ROOT%\\node_modules\\electron\\dist\\electron\.exe" "%SMOL_ROOT%\\desktop"/);
  assert.doesNotMatch(launcher, /desktop\\node_modules\\electron/i);
});

test("Desktop exposes live read-only Git status and blame to the editor", () => {
  const preload = fs.readFileSync(path.join(__dirname, "..", "desktop", "preload.js"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "..", "desktop", "main.js"), "utf8");
  const editor = fs.readFileSync(path.join(__dirname, "..", "desktop", "editor.html"), "utf8");
  assert.match(preload, /gitSyncStatus: \(\) => ipcRenderer\.invoke\("ed:gitSyncStatus"\)/);
  assert.match(preload, /gitBlame: \(rel, line\) => ipcRenderer\.invoke\("ed:gitBlame", rel, line\)/);
  assert.match(main, /ipcMain\.handle\("ed:gitSyncStatus"/);
  assert.match(main, /ipcMain\.handle\("ed:gitBlame"/);
  assert.match(editor, /window\.smolEd\.gitSyncStatus\(\)/);
  assert.match(editor, /window\.smolEd\.gitBlame\(cur, line\)/);
  assert.doesNotMatch(editor, /41 sortants|Dernière modification par You|Branche Git : main/);
});

test("Desktop project tree shows larger left-side Git badges and refreshes without blanking", () => {
  const editor = fs.readFileSync(path.join(__dirname, "..", "desktop", "editor.html"), "utf8");
  const main = fs.readFileSync(path.join(__dirname, "..", "desktop", "main.js"), "utf8");
  assert.match(editor, /status-m \{ color: #e3b341/);
  assert.match(editor, /font-size: 13px; font-weight: 900/);
  assert.match(editor, /tree\.replaceChildren\(\.\.\.nextTree\.childNodes\)/);
  assert.match(editor, /if \(root && !document\.hidden\) void refreshTree/);
  assert.match(main, /const status = await editorTreeStatus\(root\)/);
  assert.match(main, /entry\.promise = gitService\s*\.status\(root\)/);
});

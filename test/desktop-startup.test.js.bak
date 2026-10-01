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
    app: { whenReady: () => ({ then: noop }), on: noop, quit: noop },
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

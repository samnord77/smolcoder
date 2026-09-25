// Desktop app mode: browser lookup and window args, offline with fake
// folders and injected platforms. Never launches anything.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { appProfileDir, buildAppArgs, findAppBrowser } = require("../dist/web/app");

test("windows finds chrome and edge in the given roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "smol-app-"));
  const chrome = path.join(root, "Google", "Chrome", "Application", "chrome.exe");
  fs.mkdirSync(path.dirname(chrome), { recursive: true });
  fs.writeFileSync(chrome, "fake");
  assert.equal(findAppBrowser("win32", { ProgramFiles: root }), chrome);
  assert.equal(findAppBrowser("win32", { ProgramFiles: path.join(root, "nowhere") }), null);
});

test("unknown platform has no app browser", () => {
  assert.equal(findAppBrowser("linux", {}), null);
  assert.equal(findAppBrowser("win32", {}), null);
});

test("app args open the hub url in its own profile", () => {
  const args = buildAppArgs("http://127.0.0.1:7433/?k=abc");
  assert.ok(args[0].startsWith("--app=http://127.0.0.1:7433/"));
  assert.ok(args[1].startsWith("--user-data-dir="));
  assert.ok(appProfileDir().endsWith("smolcoder-app"));
});

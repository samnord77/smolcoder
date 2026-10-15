// L'outil browser : enum des actions selon le mode, refus en lecture seule,
// validations d'arguments, et un test live qui pilote une vraie page locale
// (ignoré proprement quand aucun Chrome/Edge n'est installé).
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { browserTool, runBrowser } = require("../dist/tools/browser");
const { findBrowser, BrowserSession } = require("../dist/browser");

function fakeBrowser(overrides = {}) {
  const calls = [];
  const fake = {
    calls,
    running: true,
    async open(url) {
      calls.push(["open", url]);
      return { title: "Page factice", url };
    },
    async read() {
      calls.push(["read"]);
      return { title: "Page factice", url: "http://127.0.0.1/", text: "Bonjour factice", truncated: false };
    },
    async click(selector) {
      calls.push(["click", selector]);
      if (selector === "#absent") return { ok: false };
      return { ok: true, tag: "button", text: "Valider" };
    },
    async type(selector, text, submit) {
      calls.push(["type", selector, text, submit]);
      return { ok: true, tag: "input", submitted: submit === true };
    },
    async press(key) {
      calls.push(["press", key]);
    },
    async screenshot(workspace) {
      calls.push(["shot", workspace]);
      return { rel: ".smol/screenshots/browser-x.png", bytes: 2048 };
    },
    async back() {
      calls.push(["back"]);
      return { title: "Page factice", url: "http://127.0.0.1/" };
    },
    async close() {
      calls.push(["close"]);
    },
    ...overrides,
  };
  return fake;
}

test("browser: l'enum des actions respecte le mode", () => {
  const ro = browserTool(false);
  const rw = browserTool(true);
  assert.equal(ro.name, "browser");
  assert.deepEqual(ro.parameters.properties.action.enum, ["open", "read", "shot", "back", "close"]);
  assert.deepEqual(rw.parameters.properties.action.enum, ["open", "read", "click", "type", "press", "shot", "back", "close"]);
  assert.deepEqual(ro.parameters.required, ["action"]);
});

test("browser: la lecture seule refuse les actions qui modifient la page", async () => {
  const fake = fakeBrowser();
  const ctx = { workspace: process.cwd(), canWrite: false, browser: fake };
  for (const args of [
    { action: "click", selector: "#ok" },
    { action: "type", selector: "#nom", text: "Jean" },
    { action: "press", key: "Enter" },
  ]) {
    const out = await runBrowser(ctx, args);
    assert.match(out, /lecture seule/);
  }
  assert.deepEqual(fake.calls, []);
});

test("browser: les actions de lecture passent en lecture seule", async () => {
  const fake = fakeBrowser();
  const ctx = { workspace: process.cwd(), canWrite: false, browser: fake };
  const read = await runBrowser(ctx, { action: "read" });
  assert.match(read, /Page factice/);
  assert.match(read, /Bonjour factice/);
  const shot = await runBrowser(ctx, { action: "shot" });
  assert.match(shot, /browser-x\.png/);
  const back = await runBrowser(ctx, { action: "back" });
  assert.match(back, /Retour arrière/);
  assert.deepEqual(
    fake.calls.map((c) => c[0]),
    ["read", "shot", "back"]
  );
});

test("browser: validations d'arguments", async () => {
  const ctx = { workspace: process.cwd(), canWrite: true, browser: fakeBrowser() };
  assert.match(await runBrowser(ctx, { action: "open" }), /"url" est requis/);
  assert.match(await runBrowser(ctx, { action: "click" }), /"selector" est requis/);
  assert.match(await runBrowser(ctx, { action: "type", selector: "#x" }), /"text" est requis/);
  assert.match(await runBrowser(ctx, { action: "press" }), /"key" est requis/);
  assert.match(await runBrowser(ctx, { action: "danser" }), /l'action doit être/);
  await assert.rejects(new BrowserSession().open("ftp://x"), /schéma non supporté/);
  await assert.rejects(new BrowserSession().open("pas une url"), /adresse invalide/);
});

test("browser: les actions et leurs retours", async () => {
  const fake = fakeBrowser();
  const ctx = { workspace: "C:/ws", canWrite: true, browser: fake };
  const open = await runBrowser(ctx, { action: "open", url: "http://127.0.0.1:9/" });
  assert.match(open, /Page ouverte/);
  const click = await runBrowser(ctx, { action: "click", selector: "#valider" });
  assert.match(click, /Clic effectué/);
  assert.match(click, /Valider/);
  const typed = await runBrowser(ctx, { action: "type", selector: "#nom", text: "Jean", submit: true });
  assert.match(typed, /Texte saisi/);
  assert.match(typed, /formulaire envoyé/);
  const press = await runBrowser(ctx, { action: "press", key: "Enter" });
  assert.match(press, /Touche « Enter » pressée/);
  assert.match(await runBrowser(ctx, { action: "click", selector: "#absent" }), /aucun élément/);
  assert.equal(ctx.browser, fake);
  const close = await runBrowser(ctx, { action: "close" });
  assert.match(close, /Navigateur fermé/);
  assert.equal(ctx.browser, undefined);
});

test("browser: un clic sans élément ne casse pas", async () => {
  const fake = fakeBrowser({
    async click() {
      return { ok: false };
    },
  });
  const out = await runBrowser({ workspace: process.cwd(), canWrite: true, browser: fake }, { action: "click", selector: "#nope" });
  assert.match(out, /aucun élément/);
});

test("browser: chaque étape du direct est remise au panneau (live.jpg + UI)", async () => {
  const { Session } = require("../dist/session");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "smol-browser-live-"));
  const seen = [];
  const harness = Object.create(Session.prototype);
  harness.workspace = workspace;
  harness.ui = { browserView: (v) => seen.push(v) };
  const raw = "jpeg-factice";
  await harness.browserLive({ url: "http://127.0.0.1:9/p", title: "Titre", action: "click", png: Buffer.from(raw).toString("base64") });
  const file = path.join(workspace, ".smol", "screenshots", "live.jpg");
  assert.ok(fs.existsSync(file), "live.jpg doit être écrit");
  assert.equal(fs.readFileSync(file).toString(), raw, "la capture décodée doit correspondre");
  assert.deepEqual(seen, [{ url: "http://127.0.0.1:9/p", title: "Titre", action: "click", shot: ".smol/screenshots/live.jpg" }]);
  // Un notify qui jette ne doit jamais remonter : le direct est un confort.
  harness.ui = {
    browserView: () => {
      throw new Error("panneau cassé");
    },
  };
  await harness.browserLive({ url: "u", title: "t", action: "open", png: Buffer.from(raw).toString("base64") });
  try {
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test("browser: une erreur du navigateur revient en texte", async () => {
  const fake = fakeBrowser({
    async open() {
      throw new Error("chrome est parti en promenade");
    },
  });
  const out = await runBrowser({ workspace: process.cwd(), canWrite: true, browser: fake }, { action: "open", url: "http://127.0.0.1:9/" });
  assert.match(out, /^Error: chrome est parti en promenade/);
});

const livePage = `<!doctype html><html><head><title>Page de test</title></head>
<body>
<h1>Bonjour Smolcoder</h1>
<p id="par">Texte initial.</p>
<button id="btn" onclick="document.getElementById('par').textContent='Bouton clique !'">Cliquer</button>
<input id="nom" name="nom" />
</body></html>`;

test(
  "browser: pilote une vraie page locale (live)",
  { skip: (findBrowser() ?? "") === "" ? "aucun navigateur Chrome/Edge sur cette machine" : false },
  async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(livePage);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "smol-browser-test-"));
    const live = [];
    const ctx = { workspace, canWrite: true, browserNotify: (ev) => live.push(ev) };
    try {
      const open = await runBrowser(ctx, { action: "open", url: `http://127.0.0.1:${port}/` });
      assert.match(open, /Page ouverte/);
      assert.match(open, /Page de test/);
      const read = await runBrowser(ctx, { action: "read" });
      assert.match(read, /Texte initial/);
      const click = await runBrowser(ctx, { action: "click", selector: "#btn" });
      assert.match(click, /Clic effectué/);
      const after = await runBrowser(ctx, { action: "read" });
      assert.match(after, /Bouton clique !/);
      const typed = await runBrowser(ctx, { action: "type", selector: "#nom", text: "Jean Dupont" });
      assert.match(typed, /Texte saisi/);
      const shot = await runBrowser(ctx, { action: "shot" });
      assert.match(shot, /Capture d'écran enregistrée/);
      assert.ok(fs.existsSync(path.join(workspace, ".smol", "screenshots")), "le dossier de captures doit exister");
      assert.ok(live.length >= 3, "chaque action qui change la page diffuse une étape");
      assert.ok(
        live.some((e) => e.action === "open"),
        "l'étape open est diffusée"
      );
      assert.ok(
        live.some((e) => e.action === "click"),
        "l'étape click est diffusée"
      );
      const last = live[live.length - 1];
      assert.ok(typeof last.png === "string" && last.png.length > 100, "la capture jpeg voyage en base64");
      assert.match(last.url, /127\.0\.0\.1:/, "l'étape porte l'url courante");
    } finally {
      await runBrowser(ctx, { action: "close" }).catch(() => {});
      await new Promise((resolve) => server.close(resolve));
      try {
        fs.rmSync(workspace, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
);

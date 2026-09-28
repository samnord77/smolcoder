// Client smoke: EXECUTE the real bundle (not just parse it) with a minimal
// DOM stub — opening the files/review tabs must not throw, must hit the
// right endpoints, and must render rows. Catches TDZ/reference errors that
// bundle-parse tests cannot see.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { CLIENT_JS } = require("../dist/web/client");

function makeEl(all) {
  const el = {
    children: [],
    style: {},
    dataset: {},
    hidden: false,
    value: "",
    textContent: "",
    innerHTML: "",
    title: "",
    type: "",
    className: "",
    appendChild(c) { el.children.push(c); return c; },
    append(...cs) { el.children.push(...cs); },
    prepend(...cs) { el.children.unshift(...cs); },
    insertBefore(c, ref) {
      const i = ref ? el.children.indexOf(ref) : -1;
      if (i < 0) el.children.push(c);
      else el.children.splice(i, 0, c);
      return c;
    },
    replaceChildren(...cs) { el.children.length = 0; el.children.push(...cs); },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    getAttribute() { return null; },
    focus() {},
    select() {},
    setSelectionRange() {},
    setRangeText() {},
    dispatchEvent() {},
    click() {},
    scrollIntoView() {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  };
  all.push(el);
  return new Proxy(el, {
    get(t, p) {
      if (p in t) return t[p];
      return undefined;
    },
    set(t, p, v) {
      t[p] = v;
      return true;
    },
  });
}

function boot(treeEntries, diffPayload) {
  const all = [];
  const els = {};
  const urls = [];
  const doc = {
    createElement: () => makeEl(all),
    createTextNode: (text) => {
      const el = makeEl(all);
      el.textContent = String(text);
      return el;
    },
    getElementById: (id) => els[id] || (els[id] = makeEl(all)),
    querySelector: () => null,
    querySelectorAll: () => [],
    body: null,
    title: "",
    activeElement: null,
    addEventListener() {},
  };
  doc.body = makeEl(all);
  const loc = { search: "", hash: "", pathname: "/", origin: "http://127.0.0.1:1", reloads: 0, reload() { loc.reloads++; } };
  const store = {};
  let esInstance = null;
  const context = {
    document: doc,
    window: null,
    location: loc,
    history: { replaceState() {} },
    navigator: { userAgent: "node-smoke" },
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    alert() {},
    prompt: () => null,
    confirm: () => false,
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    URLSearchParams,
    URL,
    JSON,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    Promise,
    Map,
    Set,
    console,
    setTimeout: (...a) => { const t = setTimeout(...a); if (t && t.unref) { try { t.unref(); } catch {} } return t; },
    clearTimeout: (...a) => clearTimeout(...a),
    setInterval: (...a) => { const t = setInterval(...a); if (t && t.unref) { try { t.unref(); } catch {} } return t; },
    clearInterval: (...a) => clearInterval(...a),
    fetch: async (url, opts) => {
      urls.push(String(url));
      const u = String(url);
      let body = {};
      if (u.includes("/workspace/tree")) body = { path: ".", entries: treeEntries, workspace: "/ws" };
      else if (u.includes("/workspace/file") && (!opts || opts.method !== "POST")) body = { path: "a.ts", content: "const x = 1;\n", mtimeMs: 1 };
      else if (u.includes("/code/diff") && !u.includes("/hunk")) body = diffPayload;
      else if (u.includes("/plan")) body = { exists: false, steps: [], current: -1, done: 0, total: 0 };
      else if (u.includes("/code/")) body = { result: "", diagnostics: [] };
      return { ok: true, status: 200, json: async () => body };
    },
    EventSource: class {
      constructor(url) {
        this.url = url;
        esInstance = this;
      }
      close() {}
    },
  };
  context.window = {
    document: doc,
    location: loc,
    addEventListener() {},
    innerWidth: 1400,
    innerHeight: 900,
    matchMedia: function () { return { matches: false }; },
    getSelection: () => "",
  };
  vm.createContext(context);
  vm.runInContext(CLIENT_JS, context, { filename: "client.js" });
  const classes = () => {
    const out = new Set();
    for (const e of all) {
      if (e.className) String(e.className).split(/\s+/).forEach((c) => c && out.add(c));
    }
    return out;
  };
  const errors = () => (els.smolerror && els.smolerror.textContent ? els.smolerror.textContent : "");
  const flush = async (ms = 120) => new Promise((r) => setTimeout(r, ms));
  return { context, els, urls, classes, errors, flush, es: () => esInstance, allElements: () => all };
}

const TREE = [
  { name: "src", path: "src", dir: true },
  { name: "a.ts", path: "a.ts", dir: false },
];
const DIFF = {
  files: [{ file: "a.ts", hunks: [{ index: 0, header: "@@ -1 +1 @@", lines: ["-old", "+new", " same"] }] }],
  note: "",
};

function emitHub(ctx, sid = "s1", startedAt = 1000) {
  ctx.es().onmessage({
    data: JSON.stringify({
      t: "hub",
      version: "9.9.9",
      home: "/h",
      sep: "/",
      startedAt,
      workspaces: [
        { path: "/ws", name: "ws", display: "~/ws", last: 1, sessions: [{ id: sid, title: "t", status: "idle", live: true, createdAt: 1, updatedAt: 1, model: "m", terminals: [], viewers: [], plan: "Plan 1/2 · beta", editing: [] }] },
      ],
    }),
  });
}

test("client template contains no bare backticks", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "web", "client.ts"), "utf8");
  const bad = [];
  src.split("\n").forEach((t, i) => {
    if (/String\.raw`$/.test(t) || /^\s*`;\s*$/.test(t)) return;
    if (t.replace(/\\`/g, "").includes("`")) bad.push(i + 1 + ":" + t.slice(0, 80));
  });
  assert.deepEqual(bad, [], "bare backticks terminate the String.raw template");
});

test("files tab builds, fetches the tree and renders rows", async () => {
  const c = boot(TREE, DIFF);
  emitHub(c);
  await c.flush();
  assert.equal(c.errors(), "", "no page error during boot + snapshot");
  c.els.btnfiles.onclick();
  await c.flush(200);
  assert.equal(c.errors(), "", "no page error while opening the files tab");
  assert.ok(c.urls.some((u) => u.includes("/workspace/tree")), "tree endpoint was hit");
  const cls = c.classes();
  assert.ok(cls.has("treetoggle"), "folder toggles rendered");
  assert.ok(cls.has("fileitem"), "file rows rendered");
});

test("review tab builds and renders colored hunks", async () => {
  const c = boot(TREE, DIFF);
  emitHub(c);
  await c.flush();
  c.els.btnreview.onclick();
  await c.flush(200);
  assert.equal(c.errors(), "", "no page error while opening the review tab");
  assert.ok(c.urls.some((u) => u.includes("/code/diff?")), "diff endpoint was hit");
  const cls = c.classes();
  assert.ok(cls.has("reviewpatch"), "review patch rendered");
  assert.ok(cls.has("add") && cls.has("del"), "hunk lines carry add/del classes");
});

test("panel click without a session explains instead of dying silently", async () => {
  const c = boot(TREE, DIFF);
  await c.flush();
  c.els.btnfiles.onclick();
  await c.flush(120);
  assert.equal(c.errors(), "", "no page error");
  const texts = [];
  const walk = (el) => {
    if (el.textContent) texts.push(el.textContent);
    for (const ch of el.children || []) walk(ch);
  };
  walk(c.context.document.body);
  for (const el of c.allElements()) walk(el);
  assert.ok(texts.some((t) => /session/i.test(t)), "user is told to open a session first");
});

test("crumb shows the plan chip; review has filter and nav", async () => {
  const c = boot(TREE, DIFF);
  emitHub(c);
  await c.flush();
  const cls = c.classes();
  assert.ok(cls.has("planchip"), "todo chip rendered in the crumb");
  c.els.btnreview.onclick();
  await c.flush(200);
  const byPlaceholder = c.allElements().filter((e) => e.placeholder === "Filtrer…");
  assert.equal(byPlaceholder.length, 1, "review filter present");
  const titles = c.allElements().map((e) => e.title).filter(Boolean);
  assert.ok(titles.includes("Previous change") && titles.includes("Next change"), "hunk navigation present");
});

test("agent file activity shows live and refreshes review", async () => {
  const c = boot(TREE, DIFF);
  emitHub(c);
  await c.flush();
  c.els.btnfiles.onclick();
  await c.flush(200);
  c.es().onmessage({ data: JSON.stringify({ t: "tool", sid: "s1", name: "write_file", summary: "a.ts" }) });
  await c.flush(120);
  const texts = [];
  for (const e of c.allElements()) if (e.textContent) texts.push(e.textContent);
  assert.ok(texts.some((t) => t.includes("🤖 write_file")), "agent chip shows the live tool call");
});

test("side-by-side toggle renders paired columns", async () => {
  const c = boot(TREE, DIFF);
  emitHub(c);
  await c.flush();
  c.els.btnreview.onclick();
  await c.flush(200);
  const toggle = c.allElements().find((e) => e.title === "side-by-side view");
  assert.ok(toggle, "sbs toggle present");
  toggle.onclick();
  await c.flush(200);
  assert.equal(c.errors(), "", "no page error in side-by-side");
  assert.ok(c.classes().has("sbsgrid"), "paired grid rendered");
  assert.ok(c.classes().has("sbsrow"), "paired rows rendered");
});

test("page reloads itself when the hub restarts underneath", async () => {
  const c = boot(TREE, DIFF);
  emitHub(c, "s1", 1000);
  await c.flush();
  assert.equal(c.context.location.reloads || 0, 0);
  emitHub(c, "s1", 2000);
  await c.flush(120);
  assert.equal(c.context.location.reloads, 1);
});

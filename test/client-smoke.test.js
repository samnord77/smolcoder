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
const { PAGE_HTML } = require("../dist/web/page");

function makeEl(all) {
  const el = {
    children: [],
    listeners: {},
    attributes: {},
    style: {},
    dataset: {},
    scrollTop: 0,
    hidden: false,
    value: "",
    textContent: "",
    innerHTML: "",
    title: "",
    type: "",
    className: "",
    appendChild(c) {
      c.parent = el;
      el.children.push(c);
      return c;
    },
    append(...cs) {
      cs.forEach((c) => {
        c.parent = el;
      });
      el.children.push(...cs);
    },
    prepend(...cs) {
      cs.forEach((c) => {
        c.parent = el;
      });
      el.children.unshift(...cs);
    },
    insertBefore(c, ref) {
      c.parent = el;
      const i = ref ? el.children.indexOf(ref) : -1;
      if (i < 0) el.children.push(c);
      else el.children.splice(i, 0, c);
      return c;
    },
    replaceChildren(...cs) {
      el.children.length = 0;
      cs.forEach((c) => {
        c.parent = el;
      });
      el.children.push(...cs);
    },
    remove() {
      const p = el.parent;
      if (!p) return;
      const i = p.children.indexOf(el);
      if (i >= 0) p.children.splice(i, 1);
      el.parent = null;
    },
    addEventListener(name, callback) {
      if (!el.listeners[name]) el.listeners[name] = [];
      el.listeners[name].push(callback);
    },
    removeEventListener(name, callback) {
      el.listeners[name] = (el.listeners[name] || []).filter((listener) => listener !== callback);
    },
    setAttribute(name, value) {
      el.attributes[name] = String(value);
    },
    getAttribute(name) {
      return el.attributes[name] ?? null;
    },
    removeAttribute(name) {
      delete el.attributes[name];
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    focus() {},
    select() {},
    setSelectionRange() {},
    setRangeText() {},
    dispatchEvent() {},
    click() {},
    scrollIntoView() {},
    getBoundingClientRect() {
      return { top: 0, left: 0, width: 600, height: 400, right: 600, bottom: 400 };
    },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  };
  Object.defineProperty(el, "innerHTML", {
    get() {
      return el._innerHTML || "";
    },
    set(value) {
      el._innerHTML = String(value);
      if (value === "") el.replaceChildren();
    },
  });
  Object.defineProperty(el, "childNodes", {
    get() {
      return el.children;
    },
  });
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

function boot(treeEntries, diffPayload, shellItems = []) {
  const all = [];
  const els = {};
  const urls = [];
  const posts = [];
  const doc = {
    createElement: () => makeEl(all),
    createTextNode: (text) => {
      const el = makeEl(all);
      el.textContent = String(text);
      return el;
    },
    getElementById: (id) => {
      if (!els[id]) els[id] = makeEl(all);
      return els[id];
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    body: null,
    title: "",
    activeElement: null,
    addEventListener() {},
  };
  doc.body = makeEl(all);
  const loc = {
    search: "",
    hash: "",
    pathname: "/",
    origin: "http://127.0.0.1:1",
    reloads: 0,
    reload() {
      loc.reloads++;
    },
  };
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
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v);
      },
    },
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
    setTimeout: (...a) => {
      const t = setTimeout(...a);
      if (t?.unref) {
        try {
          t.unref();
        } catch {}
      }
      return t;
    },
    clearTimeout: (...a) => clearTimeout(...a),
    setInterval: (...a) => {
      const t = setInterval(...a);
      if (t?.unref) {
        try {
          t.unref();
        } catch {}
      }
      return t;
    },
    clearInterval: (...a) => clearInterval(...a),
    fetch: async (url, opts) => {
      urls.push(String(url));
      const u = String(url);
      let body = {};
      if (u.includes("/shell/live")) body = { items: shellItems };
      else if (u.includes("/shell") && opts && opts.method === "POST") {
        const parsed = opts.body ? JSON.parse(opts.body) : {};
        posts.push({ url: u, body: parsed });
        body = { ok: true, taskId: "t3", deadline: Date.now() + 90000 };
      } else if (u.includes("/workspace/tree")) body = { path: ".", entries: treeEntries, workspace: "/ws" };
      else if (u.includes("/workspace/file") && opts?.method !== "POST") body = { path: "a.ts", content: "const x = 1;\n", mtimeMs: 1 };
      else if (u.includes("/msg") && opts?.method === "POST") {
        posts.push({ url: u, body: opts.body ? JSON.parse(opts.body) : {} });
        body = { queued: true };
      } else if (u.includes("/code/diff") && !u.includes("/hunk")) body = diffPayload;
      else if (u.includes("/git/status"))
        body = { sync: { branch: "feature/live-status", upstream: "origin/feature/live-status", ahead: 2, behind: 1 } };
      else if (u.includes("/git/blame")) body = { result: "abc123 Ada Lovelace 2026-10-01 | const x = 1;" };
      else if (u.includes("/status"))
        body = {
          state: { mode: "edit" },
          workItems: [
            {
              id: "w_test",
              title: "Shared project task",
              area: "IDE",
              priority: "high",
              status: "open",
              notes: "",
              due: null,
              acceptanceCriteria: "Project tests pass",
            },
          ],
        };
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
    setTimeout: context.setTimeout,
    clearTimeout: context.clearTimeout,
    innerWidth: 1400,
    innerHeight: 900,
    matchMedia: () => ({ matches: false }),
    getSelection: () => "",
  };
  vm.createContext(context);
  vm.runInContext(CLIENT_JS, context, { filename: "client.js" });
  const classes = () => {
    const out = new Set();
    for (const e of all) {
      if (e.className) {
        for (const c of String(e.className).split(/\s+/)) {
          if (c) out.add(c);
        }
      }
    }
    return out;
  };
  const errors = () => (els.smolerror?.textContent ? els.smolerror.textContent : "");
  const flush = async (ms = 120) => new Promise((r) => setTimeout(r, ms));
  return { context, els, urls, posts, classes, errors, flush, es: () => esInstance, allElements: () => all };
}

const TREE = [
  { name: "src", path: "src", dir: true },
  { name: "a.ts", path: "a.ts", dir: false, status: "M" },
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
        {
          path: "/ws",
          name: "ws",
          display: "~/ws",
          last: 1,
          sessions: [
            {
              id: sid,
              title: "t",
              status: "idle",
              live: true,
              createdAt: 1,
              updatedAt: 1,
              model: "m",
              terminals: [],
              viewers: [],
              plan: "Plan 1/2 · beta",
              editing: [],
            },
          ],
        },
      ],
    }),
  });
}

test("client template contains no bare backticks", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "web", "client.ts"), "utf8");
  const bad = [];
  src.split("\n").forEach((t, i) => {
    if (/String\.raw`$/.test(t) || /^\s*`;\s*$/.test(t)) return;
    if (t.replace(/\\`/g, "").includes("`")) bad.push(`${i + 1}:${t.slice(0, 80)}`);
  });
  assert.deepEqual(bad, [], "bare backticks terminate the String.raw template");
});

test("workspace summary cards are outside the chat composer", () => {
  const sideAt = PAGE_HTML.indexOf('id="side"');
  const workspacesAt = PAGE_HTML.indexOf('id="wslist"');
  const summaryAt = PAGE_HTML.indexOf('id="sessionstats"');
  const mainAt = PAGE_HTML.indexOf('id="main"');
  const activityAt = PAGE_HTML.indexOf('id="activitybar"');
  const composerAt = PAGE_HTML.indexOf('id="inputbox"');
  assert.ok(
    sideAt < workspacesAt && workspacesAt < summaryAt && summaryAt < mainAt,
    "cards are in the sidebar after workspaces, not the header or chat"
  );
  assert.ok(activityAt < composerAt, "the transcript remains separate from the composer");
  assert.match(PAGE_HTML.slice(summaryAt, mainAt), /sessionstat-changes[\s\S]*sessionstat-background[\s\S]*sessionstat-artifacts/);
  assert.match(PAGE_HTML, /\.sysmetric\[data-health="good"\][^{]*\{[^}]*#3fb950/);
  assert.match(PAGE_HTML, /\.sysmetric\[data-health="warn"\][^{]*\{[^}]*#f0883e/);
  assert.match(PAGE_HTML, /\.sysmetric\[data-health="high"\][^{]*\{[^}]*#f85149/);
});

test("messages can be marked and unmarked with a persistent bookmark", async () => {
  const c = boot(TREE, DIFF);
  emitHub(c);
  await c.flush();
  c.es().onmessage({ data: JSON.stringify({ t: "user", sid: "s1", s: "Keep this decision" }) });
  c.es().onmessage({ data: JSON.stringify({ t: "token", sid: "s1", s: "Keep this answer" }) });
  const markers = c.allElements().filter((element) => element.className.includes("msgbookmark"));
  assert.equal(markers.length, 2, "user and assistant messages both have a marker");
  const [userMarker, assistantMarker] = markers;
  assert.equal(userMarker.getAttribute("aria-pressed"), "false");
  userMarker.onclick({ stopPropagation() {} });
  assert.match(userMarker.className, /marked/);
  assert.equal(userMarker.getAttribute("aria-pressed"), "true");
  assert.ok(c.context.localStorage.getItem("smolcoder.bookmarks:s1"), "marker state is saved for this conversation");
  userMarker.onclick({ stopPropagation() {} });
  assert.doesNotMatch(userMarker.className, /marked/);
  assistantMarker.onclick({ stopPropagation() {} });
  assert.match(assistantMarker.className, /marked/);
});

test("files tab builds, fetches the tree and renders rows", async () => {
  const c = boot(TREE, DIFF);
  emitHub(c);
  await c.flush();
  assert.equal(c.errors(), "", "no page error during boot + snapshot");
  c.els.btnfiles.onclick();
  await c.flush(200);
  assert.equal(c.errors(), "", "no page error while opening the files tab");
  assert.ok(
    c.urls.some((u) => u.includes("/workspace/tree")),
    "tree endpoint was hit"
  );
  const cls = c.classes();
  assert.ok(cls.has("treetoggle"), "folder toggles rendered");
  assert.ok(cls.has("fileitem"), "file rows rendered");
});

test("status bar reads the active branch, cached upstream delta, and real line blame", async () => {
  const c = boot(TREE, DIFF);
  emitHub(c);
  await c.flush();
  assert.ok(
    c.urls.some((url) => url.includes("/git/status")),
    "active session requests Git status"
  );
  assert.equal(c.els["sb-branch-name"].textContent, "feature/live-status");
  assert.equal(c.els["sb-sync-text"].textContent, "1↓ 2↑");
  assert.doesNotMatch(c.els["sb-branch"].title, /main/);
  assert.doesNotMatch(c.els["sb-sync"].title, /41 sortants/);

  c.els.btnfiles.onclick();
  await c.flush(200);
  const file = c.allElements().find((element) => String(element.className).includes("fileitem") && element.title === "a.ts");
  assert.ok(file, "project file row is available");
  const badge = c.allElements().find((element) => String(element.className).includes("fileitem-badge") && element.textContent === "M");
  assert.ok(badge, "Git status badge is visible");
  const filenameButton = badge.parent.children.find((child) => child.className === "fileitem");
  assert.ok(filenameButton, "the status badge shares a row with the file name");
  const rowClasses = badge.parent.children.map((child) => child.className);
  assert.ok(
    rowClasses.indexOf("fileitem-badge status-m") > rowClasses.indexOf("fileitem"),
    "Git status badge is placed after the file name"
  );
  assert.match(PAGE_HTML, /\.fileitem-badge::before\s*\{[^}]*border-radius:\s*50%/);
  file.onclick();
  await c.flush(200);
  assert.ok(
    c.urls.some((url) => url.includes("/workspace/file") && url.includes("path=a.ts")),
    c.urls.join("\n")
  );
  c.els["sb-blame"].onclick();
  await c.flush(200);
  assert.ok(
    c.urls.some((url) => url.includes("/git/blame") && url.includes("path=a.ts")),
    "blame API receives active file path"
  );
  assert.match(c.els["sb-blame-text"].textContent, /Ada Lovelace/);
});

test("line hover opens a compact prompt and sends file, line and code context to the agent", async () => {
  const c = boot(TREE, DIFF);
  emitHub(c);
  await c.flush();
  c.els.btnfiles.onclick();
  await c.flush(200);
  const file = c.allElements().find((element) => String(element.className).includes("fileitem") && element.title === "a.ts");
  assert.ok(file);
  await file.onclick();
  await c.flush(200);
  assert.ok(
    c.urls.some((url) => url.includes("/workspace/file") && url.includes("path=a.ts")),
    c.urls.join("\n")
  );
  const editor = c.allElements().find((element) => element.className === "fileeditor");
  editor.value = "const x = 1;\n";
  const move = editor.listeners.pointermove?.[0];
  assert.equal(typeof move, "function", "editor tracks hovered code lines");
  move({ clientY: 40 });
  const plus = c.allElements().find((element) => element.className === "fileline-plus");
  assert.ok(plus && !plus.hidden);
  assert.match(plus.title, /ligne 2/);
  plus.onclick();
  const form = c.allElements().find((element) => element.className === "fileline-popup");
  form.children[0].value = "Explique cette ligne sans modifier le code.";
  form.onsubmit({ preventDefault() {} });
  await c.flush(50);
  const sent = c.posts.find((entry) => entry.url.includes("/msg"));
  assert.ok(sent, "the instruction is sent to the active agent");
  assert.match(sent.body.text, /fichier a\.ts, traite la ligne 2/);
  assert.match(sent.body.text, /Contexte du code \(lignes 1 à 2\)/);
  assert.match(sent.body.text, /const x = 1;/);
});

test("review tab builds and renders colored hunks", async () => {
  const c = boot(TREE, DIFF);
  emitHub(c);
  await c.flush();
  c.els.btnreview.onclick();
  await c.flush(200);
  assert.equal(c.errors(), "", "no page error while opening the review tab");
  assert.ok(
    c.urls.some((u) => u.includes("/code/diff?")),
    "diff endpoint was hit"
  );
  const cls = c.classes();
  assert.ok(cls.has("reviewpatch"), "review patch rendered");
  assert.ok(cls.has("add") && cls.has("del"), "hunk lines carry add/del classes");
});

test("review staged view offers Unstage, never a Stage that would do nothing", async () => {
  const c = boot(TREE, DIFF);
  emitHub(c);
  await c.flush();
  c.els.btnreview.onclick();
  await c.flush(200);
  const texts = () => {
    const out = [];
    const walk = (el) => {
      if (!el) return;
      if (el.textContent) out.push(String(el.textContent));
      for (const ch of el.children || []) walk(ch);
    };
    for (const id of Object.keys(c.els)) walk(c.els[id]);
    return out;
  };
  assert.ok(
    texts().some((t) => t === "Stage file"),
    "the unstaged view stages"
  );

  const toggle = c.allElements().find((e) => e.title === "show staged changes instead of unstaged");
  assert.ok(toggle, "the staged toggle exists");
  toggle.onclick();
  await c.flush(200);
  assert.equal(c.errors(), "", "no page error toggling to the staged view");
  assert.ok(
    c.urls.some((u) => u.includes("staged=1")),
    "the staged diff was requested"
  );
  const now = texts();
  assert.ok(
    now.some((t) => t === "Unstage"),
    "staged content offers Unstage"
  );
  assert.ok(!now.some((t) => t === "Stage file"), "no Stage that would be a no-op");
  assert.ok(!now.some((t) => t === "Revert"), "no Revert on the index behind the user's back");
  assert.ok(!now.some((t) => t === "Stage ✓"), "no line staging while staged");
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
  assert.ok(
    texts.some((t) => /session/i.test(t)),
    "user is told to open a session first"
  );
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
  const titles = c
    .allElements()
    .map((e) => e.title)
    .filter(Boolean);
  assert.ok(titles.includes("Previous change") && titles.includes("Next change"), "hunk navigation present");
});

test("control centre exposes the shared Cowork board and project tasks", async () => {
  const c = boot(TREE, DIFF);
  emitHub(c);
  await c.flush();
  c.els.cc.hidden = true;
  c.els.btnstatus.onclick();
  await c.flush(150);
  const tab =
    c.allElements().find((e) => e.className === "cc-tab on" && e.textContent === "Cowork") ||
    c.allElements().find((e) => e.className === "cc-tab" && e.textContent === "Cowork");
  assert.ok(tab, "Cowork control-centre tab exists");
  tab.onclick();
  await c.flush(500);
  assert.ok(c.classes().has("cc-workitem"), "shared work item renders in the board");
  assert.ok(
    c.allElements().some((e) => e.textContent === "Shared project task"),
    "project task title is visible"
  );
  assert.ok(
    c.allElements().some((e) => e.placeholder === "Nouvelle tâche cowork…"),
    "new work item form is available"
  );
  const execute = c.allElements().find((element) => element.textContent === "Exécuter avec l’agent");
  assert.ok(execute, "each open work item offers a direct execution action");
  execute.onclick();
  await c.flush(150);
  const dispatched = c.posts.find((post) => post.url.includes("/msg"));
  assert.match(dispatched.body.text, /w_test/);
  assert.equal(dispatched.body.workItemId, "w_test", "the actual session turn is correlated with this work item");
  assert.match(dispatched.body.text, /Critères d'acceptation/);
  assert.match(dispatched.body.text, /rapport factuel via l'outil work/);
  assert.match(dispatched.body.text, /statut et la complétion sont mis à jour par le runtime/);
});

test("agent file activity shows live and refreshes review", async () => {
  const c = boot(TREE, DIFF);
  emitHub(c);
  await c.flush();
  c.els.btnfiles.onclick();
  await c.flush(200);
  const file = c.allElements().find((element) => String(element.className).includes("fileitem") && element.title === "a.ts");
  assert.ok(file, "project file row is available");
  file.onclick();
  await c.flush(200);
  const initialFileReads = c.urls.filter((url) => url.includes("/workspace/file") && url.includes("path=a.ts")).length;
  assert.equal(initialFileReads, 1, "the file is open in a clean editor buffer");
  c.es().onmessage({ data: JSON.stringify({ t: "tool", sid: "s1", name: "write_file", summary: "a.ts" }) });
  await c.flush(120);
  const texts = [];
  for (const e of c.allElements()) if (e.textContent) texts.push(e.textContent);
  assert.ok(
    texts.some((t) => t.includes("🤖 write_file")),
    "agent chip shows the live tool call"
  );

  // The reload happens when the tool FINISHES — the tool event alone used to
  // leave the panel frozen on the pre-change state (the abandoned panel).
  const beforeTree = () => c.urls.filter((u) => u.includes("/workspace/tree")).length;
  const atStart = beforeTree();
  c.es().onmessage({ data: JSON.stringify({ t: "result", sid: "s1", line: "done", body: "done" }) });
  await c.flush(1500);
  assert.ok(beforeTree() > atStart, "the tree reloads when the write finishes");
  assert.ok(
    c.urls.filter((url) => url.includes("/workspace/file") && url.includes("path=a.ts")).length > initialFileReads,
    "the open file is fetched again after the agent writes it"
  );

  // A move through the new shape tool follows the same path.
  const afterWrite = beforeTree();
  c.es().onmessage({ data: JSON.stringify({ t: "tool", sid: "s1", name: "move_path", summary: "a.ts → src/a.ts" }) });
  c.es().onmessage({ data: JSON.stringify({ t: "result", sid: "s1", line: "Moved file a.ts", body: "Moved file a.ts" }) });
  await c.flush(1500);
  assert.ok(beforeTree() > afterWrite, "a move also reloads the tree");
});

test("file tree marks live agent operations and keeps the marker until concurrent work finishes", async () => {
  const c = boot(TREE, DIFF);
  emitHub(c);
  await c.flush();
  c.els.btnfiles.onclick();
  await c.flush(200);
  c.es().onmessage({ data: JSON.stringify({ t: "tool", sid: "s1", executionId: "read-one", name: "read_file", summary: "a.ts" }) });
  await c.flush(250);
  const badges = () => c.allElements().filter((element) => element.className === "fileitem-agent-badge");
  assert.ok(badges().length >= 1, "active tool creates a live workspace-file marker");
  assert.match(badges().at(-1).title, /read_file/);
  const activityLine = () => c.allElements().find((element) => element.className === "filemeta" && element.textContent.startsWith("🤖"));
  assert.match(activityLine().textContent, /a\.ts/);

  c.es().onmessage({ data: JSON.stringify({ t: "tool", sid: "s1", executionId: "read-two", name: "read_file", summary: "a.ts" }) });
  c.es().onmessage({ data: JSON.stringify({ t: "result", sid: "s1", executionId: "read-one", line: "source", body: "source" }) });
  await c.flush(250);
  assert.match(
    activityLine().textContent,
    /1 opération\(s\) fichier en cours/,
    "finishing one overlapping operation does not clear the other"
  );
  c.es().onmessage({ data: JSON.stringify({ t: "result", sid: "s1", executionId: "read-two", line: "source", body: "source" }) });
  await c.flush(250);
  assert.match(
    c.allElements().find((element) => element.className === "filemeta" && element.textContent.includes("terminé")).textContent,
    /read_file terminé/
  );
  assert.equal(c.errors(), "", "the live tree refresh remains error-free");
});

test("tool cards and activity results stay paired across nested sub-agent calls", async () => {
  const c = boot(TREE, DIFF);
  emitHub(c);
  await c.flush();
  c.es().onmessage({
    data: JSON.stringify({ t: "tool", sid: "s1", executionId: "parent-1", name: "run_command", command: "npm test", summary: "npm test" }),
  });
  c.es().onmessage({
    data: JSON.stringify({
      t: "tool",
      sid: "s1",
      executionId: "child-1",
      name: "read_file",
      category: "observation",
      summary: "src/app.ts",
    }),
  });
  c.es().onmessage({
    data: JSON.stringify({
      t: "tool",
      sid: "s1",
      executionId: "verify-1",
      name: "verification",
      category: "verification",
      summary: "npm test",
    }),
  });
  c.es().onmessage({
    data: JSON.stringify({
      t: "result",
      sid: "s1",
      executionId: "parent-1",
      line: "Error: test failed",
      body: "Error: test failed\n[exit code 1 in 10ms]",
      err: true,
    }),
  });
  c.es().onmessage({ data: JSON.stringify({ t: "result", sid: "s1", executionId: "child-1", line: "source", body: "source" }) });
  c.es().onmessage({
    data: JSON.stringify({
      t: "result",
      sid: "s1",
      executionId: "verify-1",
      line: "tests failed",
      body: "tests failed\n[exit code 1 in 10ms]",
    }),
  });
  await c.flush();

  const parent = c.allElements().find((element) => element._toolMeta?.executionId === "parent-1");
  const child = c.allElements().find((element) => element._toolMeta?.executionId === "child-1");
  const verification = c.allElements().find((element) => element._toolMeta?.executionId === "verify-1");
  assert.ok(parent && child && verification, "independently identified tool cards are retained");
  assert.equal(parent._toolOutcome.textContent, "Échec", "parent error result closes the parent tool");
  assert.equal(child._toolOutcome.textContent, "Terminé", "child success result closes the child tool");
  assert.equal(verification._toolOutcome.textContent, "Échec", "non-zero verification exit is not reported as success");
  assert.notEqual(parent.open, true, "failed command output stays collapsed until the user opens it");
  assert.ok(
    parent.children.some((element) => element.className.includes("result")),
    "parent result is attached to parent card"
  );
  assert.ok(
    child.children.some((element) => element.className.includes("result")),
    "child result is attached to child card"
  );
  assert.ok(
    parent.children[0].children.some((element) => element.className.includes("cmd-badge")),
    "command exit badge stays on the parent command card"
  );
  assert.ok(
    !verification.children[0].children.some((element) => element.className.includes("cmd-badge")),
    "nested verification card does not receive another command's exit badge"
  );
  assert.equal(c.errors(), "", "nested tool lifecycle causes no client errors");
});

test("sub-agent halo reports live tool work and renders its factual completion report", async () => {
  const c = boot(TREE, DIFF);
  emitHub(c);
  await c.flush();
  c.es().onmessage({ data: JSON.stringify({ t: "sub", sid: "s1", phase: "start", label: "implementer: Fix login flow" }) });
  const card = c.allElements().find((element) => element.className === "subagent");
  assert.ok(card?.open, "the live sub-agent card is visible and expanded");
  assert.ok(
    card.children[0].children.some((element) => element.className === "subagent-halo"),
    "the card includes an animated halo"
  );

  c.es().onmessage({
    data: JSON.stringify({ t: "tool", sid: "s1", executionId: "child-run-1", name: "read_file", summary: "src/login.ts" }),
  });
  assert.equal(card._progress.textContent, "1 action", "the live counter follows actual child tool calls");
  c.es().onmessage({ data: JSON.stringify({ t: "result", sid: "s1", executionId: "child-run-1", line: "source", body: "source" }) });
  c.es().onmessage({
    data: JSON.stringify({
      t: "sub",
      sid: "s1",
      phase: "done",
      label: "completed: 1 action",
      details: {
        outcome: "completed",
        verification: "passed",
        report: "Updated the login guard and confirmed the regression test passes.",
        filesTouched: ["src/login.ts", "test/login.test.js"],
        toolCalls: 1,
      },
    }),
  });
  assert.match(card.className, /finished/);
  assert.match(card._halo.textContent, /✓/);
  const meta = card.children.find((element) => element.className === "subagent-meta");
  assert.ok(meta, "completion metadata is appended");
  assert.match(meta.textContent, /passed/, "verification result is visible in the completion metadata");
  assert.ok(card.children.some((element) => element.className === "subagent-files" && /src\/login\.ts/.test(element.textContent)));
  assert.ok(card.children.some((element) => element.className === "subagent-report" && /regression test passes/.test(element.textContent)));
  assert.ok(
    card.children.some((element) => element.className === "tool"),
    "the detailed tool trace stays inside the sub-agent card"
  );
  assert.equal(c.errors(), "");
});

test("cancelling a turn closes pending tool cards and clears live file markers", async () => {
  const c = boot(TREE, DIFF);
  emitHub(c);
  await c.flush();
  c.els.btnfiles.onclick();
  await c.flush(200);
  c.es().onmessage({
    data: JSON.stringify({ t: "tool", sid: "s1", executionId: "cancelled-write", name: "write_file", summary: "src/app.ts" }),
  });
  await c.flush(150);
  c.es().onmessage({ data: JSON.stringify({ t: "turn_cancelled", sid: "s1" }) });
  await c.flush(150);

  const card = c.allElements().find((element) => element._toolMeta?.executionId === "cancelled-write");
  assert.equal(card._toolOutcome.textContent, "Annulé");
  assert.equal(card._toolOutcome.className, "tool-outcome cancelled");
  assert.ok(!card.className.includes("pending"));
  assert.match(
    c.allElements().find((element) => element.className === "filemeta" && element.textContent.includes("annulée")).textContent,
    /opération.*annulée/i
  );
  assert.equal(c.errors(), "");
});

test("side-by-side toggle renders paired columns", async () => {
  const c = boot(TREE, DIFF);
  emitHub(c);
  await c.flush();
  c.els.btnreview.onclick();
  await c.flush(200);
  const toggle = c.allElements().find((e) => e.title?.includes("side-by-side view"));
  assert.ok(toggle, "sbs toggle present");
  toggle.onclick();
  await c.flush(200);
  assert.equal(c.errors(), "", "no page error in side-by-side");
  // Original test checked for sbsgrid class - our implementation uses flex-direction on reviewpanes
  // and toggles sbsgrid on body. Check that the toggle button state changed.
  const toggleAfter = c.allElements().find((e) => e.title === "unified view");
  assert.ok(toggleAfter, "toggle switched to unified view");
});

test("split opens a second files panel loading the tree again", async () => {
  const c = boot(TREE, DIFF);
  emitHub(c);
  await c.flush();
  c.els.btnfiles.onclick();
  await c.flush(200);
  const before = c.urls.filter((u) => u.includes("/workspace/tree")).length;
  assert.ok(before >= 1);
  const split = c.allElements().find((e) => e.title === "split: second files panel");
  assert.ok(split, "split button present");
  split.onclick();
  await c.flush(200);
  assert.equal(c.errors(), "", "no page error on split");
  const after = c.urls.filter((u) => u.includes("/workspace/tree")).length;
  assert.ok(after > before, "second panel loads its own tree");
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

const OFFLOAD_COMMAND = 'node -e "long build"';
function startRun(c) {
  c.es().onmessage({ data: JSON.stringify({ t: "tool", sid: "s1", name: "run_command", summary: OFFLOAD_COMMAND }) });
}

const cardsOf = (c) =>
  c.allElements().filter(
    (e) =>
      String(e.className || "")
        .split(/\s+/)
        .indexOf("offload-card") >= 0
  );
const buttonsOf = (card) => (card.children[2] ? card.children[2].children : []);

test("the offload card shows the real countdown and detach really moves the run", async () => {
  const c = boot(TREE, DIFF, [{ command: OFFLOAD_COMMAND, startedAt: Date.now() - 2000, deadline: Date.now() + 500 }]);
  emitHub(c);
  await c.flush();
  startRun(c);
  await c.flush(250);
  const cards = cardsOf(c);
  assert.equal(cards.length, 1, "the card appears when the deadline is close");
  const card = cards[0];
  const lines = card.children.map((x) => [x, ...x.children].map((y) => y.textContent).join(" "));
  assert.ok(
    lines.some((t) => /Tool running longer — about to offload/.test(t)),
    "copilot-style title"
  );
  assert.ok(
    lines.some((t) => /Detaching in \d+s/.test(t)),
    "a live countdown against the server deadline"
  );
  assert.deepEqual(
    buttonsOf(card).map((b) => b.textContent),
    ["Move to background now", "Don't auto-offload", "Delay offload", "Extend timeout", "Cancel"],
    "all five actions"
  );
  assert.ok(card.parent && card.parent.open === true, "the card forces its tool entry open");

  buttonsOf(card)[0].onclick();
  await c.flush(150);
  const det = c.posts.find((p) => p.body && p.body.action === "detach");
  assert.ok(det, "the primary button calls the server");
  assert.equal(det.body.command, OFFLOAD_COMMAND, "for the command that owns the card");
  assert.ok(/task t3/.test(card.children[1].textContent), "the card reports where it went");

  c.es().onmessage({ data: JSON.stringify({ t: "result", sid: "s1", line: "moved", body: "moved" }) });
  await c.flush(150);
  assert.equal(card.parent, null, "the card leaves with the tool result");
});

test("Extend timeout pushes the deadline and Don't auto-offload stands down", async () => {
  const c = boot(TREE, DIFF, [{ command: OFFLOAD_COMMAND, startedAt: Date.now(), deadline: Date.now() + 400 }]);
  emitHub(c);
  await c.flush();
  startRun(c);
  await c.flush(250);
  const card = cardsOf(c)[0];
  assert.ok(card, "the card is up");
  buttonsOf(card)[3].onclick();
  await c.flush(150);
  const ext = c.posts.filter((p) => p.body.action === "extend").pop();
  assert.ok(ext && ext.body.ms === 120000, "extend asks for two more minutes");
  assert.match(card.children[1].textContent, /Detaching in 8[0-9]s|Detaching in 9[0-9]s/, "countdown follows the new deadline");

  buttonsOf(card)[1].onclick();
  await c.flush(50);
  assert.equal(card.parent, null, "the user stood down: the card is gone");
  c.es().onmessage({ data: JSON.stringify({ t: "result", sid: "s1", line: "ok", body: "ok" }) });
  await c.flush(120);
  assert.equal(cardsOf(c).filter((e) => e.parent).length, 0, "and it stays gone");
});

test("pro inline editor features include cursor-style ctrl+k, chips, and keyboard navigation", () => {
  assert.ok(CLIENT_JS.includes("fileinlinechips"), "quick action chips container is present");
  assert.ok(CLIENT_JS.includes("Refactoriser"), "refactor chip is present");
  assert.ok(CLIENT_JS.includes("Corriger bugs"), "bugfix chip is present");
  assert.ok(CLIENT_JS.includes("Accepter (Entrée)"), "accept button with enter shortcut is present");
  assert.ok(CLIENT_JS.includes("Refuser (Échap)"), "reject button with escape shortcut is present");
  assert.ok(CLIENT_JS.includes("inlineAccept.click()"), "keyboard shortcut triggers inlineAccept");
});

test("unified activity center timeline exposes subagents, tools, skills, mcps, files, and durations", () => {
  assert.ok(CLIENT_JS.includes("activitybar"), "activity bar container is present");
  assert.ok(CLIENT_JS.includes("actpulse"), "activity live pulse is present");
  assert.ok(CLIENT_JS.includes("acttimeline"), "activity timeline container is present");
  assert.ok(CLIENT_JS.includes("recordActivity"), "recordActivity helper is implemented");
  assert.ok(CLIENT_JS.includes("renderActivity"), "renderActivity helper is implemented");
  assert.ok(CLIENT_JS.includes("startToolActivity"), "tool lifecycle starts activity tracking");
  assert.ok(CLIENT_JS.includes("finishToolActivity"), "tool lifecycle settles activity duration and status");
});

// Model routing: parsing, transient detection, and failover between fake providers.
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseFallbacks, isTransientError, RoutingProvider, routeProvider } = require("../dist/router");

const okProvider = (label) => ({
  label,
  modelId: "m",
  contextWindow: 8000,
  maxOutputTokens: 500,
  setEffort() {},
  effortLabel: () => null,
  chat: async () => ({ content: `from ${label}`, toolCalls: [] }),
});
const failProvider = (label, msg) => ({
  ...okProvider(label),
  chat: async () => {
    throw new Error(msg);
  },
});
const models = [{ backend: "lmstudio", id: "model-b", baseUrl: "http://127.0.0.1:1234", contextWindow: 8000 }];

test("parseFallbacks keeps colons inside model ids", () => {
  assert.deepEqual(parseFallbacks("ollama:qwen3:8b, glm-4 ,lmstudio:"), [
    { backend: "ollama", id: "qwen3:8b" },
    { backend: "", id: "glm-4" },
  ]);
  assert.deepEqual(parseFallbacks(""), []);
  assert.deepEqual(parseFallbacks(undefined), []);
});

test("isTransientError separates transport from model failures", () => {
  assert.ok(isTransientError(new Error("connect ECONNREFUSED 127.0.0.1:11434")));
  assert.ok(isTransientError(new Error("request failed with status 503")));
  assert.ok(isTransientError(new Error("429 too many requests")));
  assert.ok(isTransientError(new Error("operation timed out after 120000ms")));
  assert.ok(!isTransientError(new Error("invalid JSON in tool args")));
  assert.ok(!isTransientError(new Error("empty reply")));
});

test("router fails over on transient errors only", async () => {
  const notes = [];
  const router = new RoutingProvider(
    failProvider("A", "connect ECONNREFUSED 127.0.0.1:11434"),
    [{ backend: "lmstudio", id: "model-b" }],
    async () => models,
    () => okProvider("B"),
    (m) => notes.push(m)
  );
  const r = await router.chat([], []);
  assert.equal(r.content, "from B");
  assert.equal(router.snapshot().current, 1);
  assert.equal(router.snapshot().failures.length, 1);
  assert.match(notes.join(" "), /failed.*trying B/);
  assert.match(router.describe(), /Route: A → B/);
  assert.match(router.describe(), /Serving: B/);
});

test("router rethrows model-behavior failures without failover", async () => {
  const router = new RoutingProvider(
    failProvider("A", "invalid JSON in tool args"),
    [{ backend: "lmstudio", id: "model-b" }],
    async () => models,
    () => okProvider("B")
  );
  await assert.rejects(router.chat([], []), /invalid JSON/);
  assert.equal(router.snapshot().current, 0);
});

test("router without specs returns the primary untouched", () => {
  const p = okProvider("A");
  assert.equal(
    routeProvider(
      p,
      "",
      async () => [],
      () => p
    ),
    p
  );
  assert.equal(
    routeProvider(
      p,
      undefined,
      async () => [],
      () => p
    ),
    p
  );
  const routed = routeProvider(
    p,
    "lmstudio:model-b",
    async () => [],
    () => p
  );
  assert.ok(routed instanceof RoutingProvider);
  assert.match(routed.describe(), /No fallbacks configured|Route: A/);
});

test("router forwards effort to every provider", async () => {
  const seen = [];
  const mk = (label) => ({ ...okProvider(label), setEffort: (e) => seen.push([label, e]) });
  const router = new RoutingProvider(
    mk("A"),
    [{ backend: "", id: "b" }],
    async () => models,
    () => mk("B")
  );
  router.setEffort("low");
  assert.deepEqual(seen, [["A", "low"]]);
  await router.chat([], []);
  router.setEffort("off");
  assert.ok(seen.some(([l, e]) => l === "B" && e === "off"));
});

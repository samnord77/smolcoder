// Auto-Copilot INLINE COMPLETION: prompt construction, echo stripping, path
// safety, fast failure without a model, and a full round-trip against a fake
// OpenAI-compatible server (no network, no external model).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { aiComplete, buildCompletionPrompt, stripEchoedPrefix } = require("../dist/ai-complete");

function scratch(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-ai-complete-"));
  const file = path.join(dir, "work.ts");
  fs.writeFileSync(file, content, "utf8");
  return { dir, file };
}

test("buildCompletionPrompt embeds the context and the current prefix", () => {
  const prompt = buildCompletionPrompt("const a = 1;\nconst b = 2;", "const c = ");
  assert.match(prompt, /const a = 1;/);
  assert.match(prompt, /const c = /);
  assert.match(prompt, /Complétion :/);
  const empty = buildCompletionPrompt("", "x");
  assert.match(empty, /début de fichier/);
});

test("stripEchoedPrefix removes a repeated trailing word, never the rest", () => {
  assert.equal(stripEchoedPrefix("res.toFixed(2)", "const x = res"), ".toFixed(2)");
  assert.equal(stripEchoedPrefix("return this", "function f() {"), "return this");
  assert.equal(stripEchoedPrefix("x = 1", "  "), "x = 1");
  assert.equal(stripEchoedPrefix("res", "const x = res"), "");
  assert.equal(stripEchoedPrefix("result = 1", "const x = res"), "result = 1");
});

test("aiComplete rejects invalid positions and unsafe paths fast", async () => {
  const { dir } = scratch("line one\nline two\n");
  const invalid = await aiComplete(dir, "work.ts", 0, 1);
  assert.equal(invalid.ok, false);
  const traversal = await aiComplete(dir, "../outside.txt", 1, 2);
  assert.equal(traversal.ok, false);
  assert.match(String(traversal.error), /chemin/);
  const missing = await aiComplete(dir, "nope.ts", 1, 2);
  assert.equal(missing.ok, false);
  assert.match(String(missing.error), /fichier/);
});

test("aiComplete refuses an empty current line", async () => {
  const { dir } = scratch("\n");
  const r = await aiComplete(dir, "work.ts", 1, 1);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /ligne vide/);
});

test("aiComplete fails fast when the configured endpoint is unreachable", async () => {
  const { dir } = scratch("const x = res\n");
  process.env.SMOLCODER_COMPLETION_BASE = "http://127.0.0.1:1";
  delete process.env.SMOLCODER_COMPLETION_KEY;
  delete process.env.SMOLCODER_COMPLETION_MODEL;
  try {
    const started = Date.now();
    const r = await aiComplete(dir, "work.ts", 1, 14, { timeoutMs: 1500 });
    assert.equal(r.ok, false);
    assert.ok(Date.now() - started < 2500, "doit échouer vite, pas attendre le timeout");
  } finally {
    delete process.env.SMOLCODER_COMPLETION_BASE;
  }
});

test("aiComplete round-trip against a fake OpenAI-compatible server", async () => {
  const { dir } = scratch("const a = 1;\nconst b = 2;\nconst c = res\n");
  let seenBody = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seenBody = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "res.toFixed(2)" } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  process.env.SMOLCODER_COMPLETION_BASE = `http://127.0.0.1:${port}`;
  process.env.SMOLCODER_COMPLETION_MODEL = "fake-model";
  delete process.env.SMOLCODER_COMPLETION_KEY;
  try {
    const r = await aiComplete(dir, "work.ts", 3, 14);
    assert.equal(r.ok, true);
    assert.equal(r.continuation, ".toFixed(2)");
    assert.equal(r.model, "fake-model");
    assert.equal(seenBody.model, "fake-model");
    assert.match(String(seenBody.messages[1].content), /const a = 1/);
    assert.match(String(seenBody.messages[1].content), /const c = res/);
  } finally {
    delete process.env.SMOLCODER_COMPLETION_BASE;
    delete process.env.SMOLCODER_COMPLETION_MODEL;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("pickCompletionModel keeps the router out and keeps local servers in", () => {
  const { pickCompletionModel } = require("../dist/ai-complete");
  assert.equal(pickCompletionModel([{ backend: "flagship", id: "gpt-6-astra" }]), undefined);
  assert.equal(pickCompletionModel([{ backend: "flagship" }, { backend: "lmstudio", id: "qwen" }]).id, "qwen");
  assert.equal(pickCompletionModel([{ backend: "ollama", id: "qwen3" }]).id, "qwen3");
  assert.equal(pickCompletionModel([]), undefined);
});

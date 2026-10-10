// Unit tests for the provider layer (run: npm test). Pure functions only —
// nothing here talks to a backend.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { mapEffort } = require("../dist/providers/lmstudio");
const { OllamaProvider, toWire } = require("../dist/providers/ollama");
const { estimateReplayTokens, lastUserIndex } = require("../dist/providers/types");
const { parseLmStudioV1 } = require("../dist/detect");

const qwenInfo = { allowed: ["off", "low", "medium", "xhigh", "on"], default: "xhigh" };

test("mapEffort: off is sent as the API value none", () => {
  assert.equal(mapEffort("off", qwenInfo), "none");
  assert.equal(mapEffort("off", undefined), "none");
});

test("mapEffort: default leaves the backend alone", () => {
  assert.equal(mapEffort(null, qwenInfo), undefined);
});

test("mapEffort: supported levels pass through", () => {
  assert.equal(mapEffort("low", qwenInfo), "low");
  assert.equal(mapEffort("medium", qwenInfo), "medium");
});

test("mapEffort: unsupported level snaps to the nearest one the model has (ties go lower)", () => {
  // high sits between medium and xhigh — the cheaper one wins.
  assert.equal(mapEffort("high", qwenInfo), "medium");
  assert.equal(mapEffort("high", { allowed: ["off", "xhigh"] }), "xhigh");
  assert.equal(mapEffort("low", { allowed: ["off", "medium", "high"] }), "medium");
});

test("mapEffort: no model info → send what was asked", () => {
  assert.equal(mapEffort("high", undefined), "high");
  assert.equal(mapEffort("low", { allowed: [] }), "low");
});

test("ollama toWire: thinking is replayed only for the current user turn", () => {
  const msgs = [
    { role: "system", content: "s" },
    { role: "user", content: "first task" },
    { role: "assistant", content: "", thinking: "OLD THOUGHT", toolCalls: [{ id: "c1", name: "read_file", args: { path: "a" } }] },
    { role: "tool", content: "x", toolCallId: "c1", toolName: "read_file" },
    { role: "assistant", content: "done" },
    { role: "user", content: "second task" },
    { role: "assistant", content: "", thinking: "NEW THOUGHT", toolCalls: [{ id: "c2", name: "read_file", args: { path: "b" } }] },
    { role: "tool", content: "y", toolCallId: "c2", toolName: "read_file" },
  ];
  const wire = toWire(msgs);
  assert.equal(wire[2].thinking, undefined, "old turn's thinking must be dropped");
  assert.equal(wire[6].thinking, "NEW THOUGHT", "current turn's thinking must travel");
  assert.equal(wire[3].tool_name, "read_file");
  assert.equal(lastUserIndex(msgs), 5);
});

test("ollama toWire: compaction notes do not count as the turn start", () => {
  const msgs = [
    { role: "system", content: "s" },
    { role: "user", content: "task" },
    { role: "assistant", content: "", thinking: "T1", toolCalls: [{ id: "c1", name: "plan", args: { action: "show" } }] },
    { role: "tool", content: "x", toolCallId: "c1", toolName: "plan" },
    { role: "user", content: "[compacted]", compactNote: true },
    { role: "assistant", content: "", thinking: "T2", toolCalls: [{ id: "c2", name: "plan", args: { action: "show" } }] },
  ];
  const wire = toWire(msgs);
  assert.equal(wire[2].thinking, "T1");
  assert.equal(wire[5].thinking, "T2");
});

test("estimateReplayTokens counts the visible reply and tool-call JSON only", () => {
  const n = estimateReplayTokens("hello world", [{ id: "1", name: "read_file", args: { path: "a.js" } }]);
  assert.ok(n > 3 && n < 40, `got ${n}`);
  assert.equal(estimateReplayTokens("", []), 0);
});

test("parseLmStudioV1 reads loaded context, id, and reasoning options", () => {
  const models = parseLmStudioV1({
    models: [
      {
        type: "llm",
        key: "qwen/qwen3.8-27b",
        loaded_instances: [{ id: "qwen/qwen3.8-27b", config: { context_length: 128000 } }],
        max_context_length: 262144,
        capabilities: { reasoning: { allowed_options: ["off", "low", "medium", "xhigh", "on"], default: "xhigh" } },
      },
      { type: "embedding", key: "nomic" },
      { type: "llm", key: "other/model", loaded_instances: [], max_context_length: 32768 },
    ],
  });
  assert.equal(models.length, 2);
  assert.equal(models[0].id, "qwen/qwen3.8-27b");
  assert.equal(models[0].contextWindow, 128000);
  assert.equal(models[0].loaded, true);
  assert.deepEqual(models[0].reasoning, { allowed: ["off", "low", "medium", "xhigh", "on"], default: "xhigh" });
  assert.equal(models[1].loaded, false);
  assert.equal(models[1].contextWindow, 4096);
  assert.ok(models[1].note);
  assert.equal(parseLmStudioV1({ data: [] }), null, "v0 shape is not accepted");
});

// --- Ollama HTTP fallbacks -------------------------------------------------
// The transport reports rejections as HttpError (status field + French text),
// so the provider ladder must key on the status, never on message wording.
// Regression: matching /returned 4xx/ silently disabled every fallback once
// the message became "Ollama : erreur 400 — ...".

function fakeOllama(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => handler(JSON.parse(body || "{}"), res));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function ollamaOk(res) {
  res.writeHead(200, { "content-type": "application/x-ndjson" });
  res.end(JSON.stringify({ message: { content: "OK" }, done: true, prompt_eval_count: 1, eval_count: 1 }) + "\n");
}

function ollamaReject(res, message) {
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

test("ollama: a model without a thinking switch is retried without the think param", async () => {
  const seen = [];
  const { server, port } = await fakeOllama((body, res) => {
    seen.push(body);
    if (body.think !== undefined) return ollamaReject(res, '"fake-model" does not support thinking');
    ollamaOk(res);
  });
  try {
    const provider = new OllamaProvider(`http://127.0.0.1:${port}`, "fake-model", 32768);
    provider.setEffort("high");
    const result = await provider.chat([{ role: "user", content: "salut" }], []);
    assert.equal(result.content, "OK");
    assert.equal(seen.length, 2, "one rejection, then one retry");
    assert.equal(seen[0].think, true, "thinking is requested first");
    assert.ok(!("think" in seen[1]), "the retry drops the think param");
    assert.match(String(provider.effortLabel()), /no thinking switch/);

    // The model is remembered as thinking-unsupported: no third probe.
    const again = await provider.chat([{ role: "user", content: "encore" }], []);
    assert.equal(again.content, "OK");
    assert.equal(seen.length, 3);
    assert.ok(!("think" in seen[2]), "later turns skip the rejected param");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("ollama: a 4xx on a streaming request is retried without streaming", async () => {
  const seen = [];
  const { server, port } = await fakeOllama((body, res) => {
    seen.push(body);
    if (body.stream === true) return ollamaReject(res, "cannot use tools with stream");
    ollamaOk(res);
  });
  try {
    const provider = new OllamaProvider(`http://127.0.0.1:${port}`, "fake-model", 32768);
    const tools = [{ name: "read_file", description: "lit un fichier", parameters: { type: "object", properties: {} } }];
    const result = await provider.chat([{ role: "user", content: "salut" }], tools);
    assert.equal(result.content, "OK");
    assert.equal(seen.length, 2);
    assert.equal(seen[0].stream, true);
    assert.equal(seen[1].stream, false, "the retry is non-streaming");
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// VRAM calibration script: pure parsers, offline, deterministic.
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseNvidiaSmi, parseOllamaPs, recommendCtx, DEFAULT_CAP, FLOOR } = require("../scripts/vram-check.cjs");

test("nvidia-smi output parses, garbage returns null", () => {
  assert.deepEqual(parseNvidiaSmi("24564, 3126\n"), { totalMB: 24564, usedMB: 3126, freeMB: 21438 });
  assert.equal(parseNvidiaSmi("nope"), null);
  assert.equal(parseNvidiaSmi(""), null);
});

test("ollama ps lists loaded models with their context", () => {
  assert.deepEqual(parseOllamaPs({ models: [{ name: "qwen3", context_length: 8192 }, { model: "x" }] }), [
    { name: "qwen3", context: 8192 },
    { name: "x", context: null },
  ]);
  assert.deepEqual(parseOllamaPs(null), []);
  assert.deepEqual(parseOllamaPs({}), []);
});

test("recommendation respects the loaded window, floor and ceiling", () => {
  assert.equal(recommendCtx({ loadedCtx: 12000 }).ctx, 12000);
  assert.equal(recommendCtx({}).ctx, 8192);
  assert.equal(recommendCtx({ loadedCtx: 200000 }).ctx, DEFAULT_CAP);
  assert.equal(recommendCtx({ loadedCtx: 100 }).ctx, FLOOR);
  assert.equal(recommendCtx({ loadedCtx: 16384, vramFreeMB: 2000 }).ctx, FLOOR);
});

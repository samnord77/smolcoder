const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { checkSyntax, findTargetedTest, formatVisualRail, validateChange } = require("../dist/continuous-validation");

test("continuous validation: checkSyntax validates valid and invalid JS", () => {
  const valid = checkSyntax("test.js", "const a = 1; function test() { return a + 1; }");
  assert.equal(valid.ok, true);

  const invalid = checkSyntax("test.js", "const a = ; function ( { return }");
  assert.equal(invalid.ok, false);
  assert.ok(invalid.error.includes("Erreur syntaxe JS"));
});

test("continuous validation: checkSyntax validates JSON", () => {
  const valid = checkSyntax("data.json", '{"name": "smolcoder", "version": "0.7.1"}');
  assert.equal(valid.ok, true);

  const invalid = checkSyntax("data.json", '{"name": "smolcoder",, "version":}');
  assert.equal(invalid.ok, false);
  assert.ok(invalid.error.includes("JSON"));
});

test("continuous validation: checkSyntax catches unbalanced braces in TypeScript", () => {
  const valid = checkSyntax("test.ts", "export interface Foo { bar: string; baz: () => void; }");
  assert.equal(valid.ok, true);

  const invalid = checkSyntax("test.ts", "export class Bar { constructor() { if (true) { console.log('oops'); }");
  assert.equal(invalid.ok, false);
  assert.ok(invalid.error.includes("Erreur syntaxe TS"));
});

test("continuous validation: findTargetedTest locates matching test file", () => {
  const root = path.resolve(__dirname, "..");
  const found = findTargetedTest("src/orchestrator.ts", root);
  assert.ok(found, "should find test/orchestrator.test.js");
  assert.ok(found.includes("orchestrator.test.js"));
});

test("continuous validation: formatVisualRail produces informative rail status", () => {
  const okResult = {
    file: "src/agent.ts",
    ok: true,
    syntaxOk: true,
    typecheckOk: true,
    diagnostics: [],
    durationMs: 42,
    visualRail: "",
  };
  const rail = formatVisualRail(okResult);
  assert.ok(rail.includes("Rails de validation"));
  assert.ok(rail.includes("agent.ts"));
  assert.ok(rail.includes("syntaxe OK"));

  const errorResult = {
    file: "src/broken.ts",
    ok: false,
    syntaxOk: false,
    syntaxError: "Délimiteur non fermé '{'",
    typecheckOk: false,
    diagnostics: [{ line: 12, message: "Délimiteur non fermé", severity: "error" }],
    durationMs: 15,
    visualRail: "",
  };
  const errorRail = formatVisualRail(errorResult);
  assert.ok(errorRail.includes("ERREUR"));
  assert.ok(errorRail.includes("broken.ts"));
});

test("continuous validation: validateChange runs on an actual source file", async () => {
  const root = path.resolve(__dirname, "..");
  const result = await validateChange("src/orchestrator.ts", root, { runTargetedTests: true });
  assert.equal(result.syntaxOk, true);
  assert.equal(result.ok, true);
  assert.ok(result.visualRail.length > 0);
  if (result.targetedTest) {
    assert.equal(result.targetedTest.passed, true);
  }
});

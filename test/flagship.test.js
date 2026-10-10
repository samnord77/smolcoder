// FlagshipRouter — the local free-model gateway (http://127.0.0.1:20128).
// One OpenAI-compatible endpoint in front of every free provider, so smolcoder
// probes it, labels its models "flagshiprouter" and routes chats through the
// same compatible transport as any other OpenAI-compatible server.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { envKeyFor, flagshipBaseUrls, identifyServer, isFlagshipBase } = require("../dist/detect");
const { backendLabel, makeProvider, modelOptions, sessionLine } = require("../dist/session");

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  let out;
  try {
    out = fn();
  } catch (err) {
    restore();
    throw err;
  }
  // Async bodies (identifyServer) must keep the environment until they settle.
  if (out && typeof out.then === "function") return out.finally(restore);
  restore();
  return out;
}

/** A fake gateway: only /v1/models answers, like FlagshipRouter. */
async function serveGateway(models) {
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: models }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("flagshipBaseUrls: the gateway port by default, configurable, disableable", () => {
  withEnv({ FLAGSHIPROUTER_BASE: undefined, FLAGSHIPROUTER_URL: undefined, SMOLCODER_FLAGSHIP: undefined }, () => {
    assert.deepEqual(flagshipBaseUrls(), ["http://127.0.0.1:20128"]);
  });
  // A caller may paste the /v1 endpoint a tool config uses; probes append their
  // own paths, so the /v1 suffix must be stripped exactly once.
  withEnv({ FLAGSHIPROUTER_BASE: "http://192.168.1.9:20128/v1", SMOLCODER_FLAGSHIP: undefined }, () => {
    assert.deepEqual(flagshipBaseUrls(), ["http://192.168.1.9:20128"]);
    assert.deepEqual(flagshipBaseUrls("http://box:20128/"), ["http://box:20128"]);
  });
  withEnv({ FLAGSHIPROUTER_BASE: undefined, SMOLCODER_FLAGSHIP: "0" }, () => {
    assert.deepEqual(flagshipBaseUrls(), []);
  });
});

test("isFlagshipBase matches the gateway spelling, not LM Studio", () => {
  withEnv({ FLAGSHIPROUTER_BASE: undefined, SMOLCODER_FLAGSHIP: undefined }, () => {
    assert.equal(isFlagshipBase("http://127.0.0.1:20128"), true);
    assert.equal(isFlagshipBase("http://127.0.0.1:20128/"), true);
    assert.equal(isFlagshipBase("http://127.0.0.1:20128/v1"), true);
    assert.equal(isFlagshipBase("http://127.0.0.1:1234"), false);
    assert.equal(isFlagshipBase("http://127.0.0.1:11434"), false);
  });
});

test("envKeyFor hands the gateway key to the gateway only", () => {
  withEnv({ FLAGSHIPROUTER_KEY: "fr-secret", FLAGSHIPROUTER_BASE: undefined, SMOLCODER_FLAGSHIP: undefined }, () => {
    assert.equal(envKeyFor("http://127.0.0.1:20128"), "fr-secret");
    assert.equal(envKeyFor("http://127.0.0.1:1234"), undefined, "a plain LM Studio stays keyless");
  });
  withEnv({ FLAGSHIPROUTER_KEY: "fr-secret", FLAGSHIPROUTER_BASE: "http://192.168.1.9:20128" }, () => {
    assert.equal(envKeyFor("http://192.168.1.9:20128"), "fr-secret");
    assert.equal(envKeyFor("http://127.0.0.1:20128"), undefined, "another address is not the configured gateway");
  });
});

test("identifyServer names the gateway and keeps its 137 models apart from LM Studio", async () => {
  const gateway = await serveGateway([{ id: "gpt-6-astra", context_length: 200000 }, { id: "byteplus/seed-2-0-mini-260215" }]);
  const base = `http://127.0.0.1:${gateway.port}`;
  try {
    await withEnv({ FLAGSHIPROUTER_BASE: base }, async () => {
      const info = await identifyServer(base, 3000);
      assert.equal(info.backend, "flagship");
      assert.equal(info.baseUrl, base);
      assert.deepEqual(
        info.models.map((m) => m.backend),
        ["flagship", "flagship"]
      );
      assert.equal(info.models[0].id, "gpt-6-astra");
      assert.equal(info.models[0].contextWindow, 200000);
      assert.equal(info.models[1].contextWindow, 4096);
      assert.match(String(info.models[1].note), /contexte|context/);
    });
  } finally {
    await gateway.close();
  }
});

test("a gateway model reads as flagshiprouter everywhere a name is shown", () => {
  const model = {
    id: "gpt-6-astra",
    backend: "flagship",
    baseUrl: "http://127.0.0.1:20128",
    contextWindow: 200000,
  };
  assert.equal(backendLabel(model), "flagshiprouter");
  assert.equal(backendLabel({ ...model, host: "gpu-box" }), "flagshiprouter @ gpu-box");
  assert.match(sessionLine(model, "edit"), /flagshiprouter · .*gpt-6-astra/);
  assert.equal(makeProvider(model).label, "FlagshipRouter · gpt-6-astra");
  assert.deepEqual(
    modelOptions([model]).map((r) => r.hint),
    ["flagshiprouter · 200\u202f000 ctx"]
  );
});

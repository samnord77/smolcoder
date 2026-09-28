// smol --vram helper: what the GPU and Ollama can actually hold, so the
// context window stops guessing. `node scripts/vram-check.cjs [--model qwen3]`
// Pure parsers are exported for tests; the script body only runs as main.
const { execFileSync } = require("node:child_process");

const DEFAULT_CAP = 32768; // same ceiling as detect.ts resolveContextWindow
const FLOOR = 4096;

/** Parse `nvidia-smi --query-gpu=memory.total,memory.used --format=csv,noheader,nounits`. */
function parseNvidiaSmi(text) {
  const m = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(
    String(text ?? "")
      .trim()
      .split("\n")[0] ?? ""
  );
  if (!m) return null;
  const total = Number(m[1]);
  const used = Number(m[2]);
  if (!total) return null;
  return { totalMB: total, usedMB: used, freeMB: Math.max(0, total - used) };
}

/** Parse Ollama /api/ps into [{ name, context }] (missing = unknown). */
function parseOllamaPs(data) {
  if (!data || !Array.isArray(data.models)) return [];
  return data.models.map((m) => ({
    name: String(m?.name ?? m?.model ?? "unknown"),
    context: typeof m?.context_length === "number" ? m.context_length : null,
  }));
}

/** Recommend a --ctx: the loaded allocation when known, else a safe default,
 * always within [FLOOR, DEFAULT_CAP]. Never throws. */
function recommendCtx({ loadedCtx, vramFreeMB } = {}) {
  let ctx = Number.isSafeInteger(loadedCtx) && loadedCtx > 0 ? loadedCtx : 8192;
  let note =
    Number.isSafeInteger(loadedCtx) && loadedCtx > 0
      ? "model already loaded at this context"
      : "no model loaded — default; rerun after loading your model";
  if (typeof vramFreeMB === "number" && vramFreeMB > 0 && vramFreeMB < 4000 && ctx > FLOOR) {
    ctx = FLOOR;
    note += "; tight VRAM, staying at the floor";
  }
  ctx = Math.min(DEFAULT_CAP, Math.max(FLOOR, ctx));
  return { ctx, note };
}

function tryJson(url, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        clearTimeout(timer);
        resolve(j);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
  });
}

async function main() {
  const lines = [];
  let gpu = null;
  try {
    const out = execFileSync("nvidia-smi", ["--query-gpu=memory.total,memory.used", "--format=csv,noheader,nounits"], {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
    });
    gpu = parseNvidiaSmi(out);
  } catch {
    gpu = null;
  }
  lines.push(gpu ? `GPU: ${gpu.freeMB} MB free / ${gpu.totalMB} MB total` : "GPU: no NVIDIA driver answering (CPU or other vendor?)");
  const base =
    process.env.OLLAMA_HOST && /^https?:\/\//.test(process.env.OLLAMA_HOST)
      ? process.env.OLLAMA_HOST.replace(/\/$/, "")
      : "http://127.0.0.1:11434";
  const ps = await tryJson(`${base}/api/ps`);
  const models = parseOllamaPs(ps);
  if (!models.length) {
    lines.push("Ollama: no model loaded right now.");
  } else {
    for (const m of models) lines.push(`Ollama: ${m.name} loaded at ctx ${m.context ?? "unknown"}`);
  }
  const firstCtx = models.length ? models[0].context : null;
  const rec = recommendCtx({ loadedCtx: firstCtx ?? undefined, vramFreeMB: gpu?.freeMB });
  lines.push(`Recommended: smol --ctx ${rec.ctx} (${rec.note}).`);
  lines.push("smolcoder itself caps overrides at 32768 and otherwise respects the server allocation.");
  console.log(lines.join("\n"));
  return rec;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err?.message ?? err));
    process.exitCode = 1;
  });
}

module.exports = { parseNvidiaSmi, parseOllamaPs, recommendCtx, DEFAULT_CAP, FLOOR };

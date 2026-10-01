// Pure-Node client for a running smolcoder web hub. No electron dependency,
// so it can be smoke-tested with plain `node`.
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

function dataDir() {
  return path.join(os.homedir(), ".smolcoder");
}

function readHubRecord() {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(dataDir(), "web.json"), "utf8"));
    if (r && typeof r.port === "number" && typeof r.token === "string") return r;
  } catch { /* none */ }
  return null;
}

function api(rec, method, p, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: "127.0.0.1",
        port: rec.port,
        path: `${p}${p.includes("?") ? "&" : "?"}k=${rec.token}`,
        method,
        headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {},
      },
      (res) => {
        let text = "";
        res.on("data", (d) => { text += d; });
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`hub ${p}: ${res.statusCode} ${text.slice(0, 120)}`));
          try {
            resolve(text ? JSON.parse(text) : {});
          } catch {
            reject(new Error(`hub ${p}: bad JSON`));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("hub timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}

/** First SSE message on /events is the full hub snapshot. */
function snapshot(rec) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port: rec.port, path: `/events?k=${rec.token}`, headers: { Accept: "text/event-stream" } },
      (res) => {
        if (res.statusCode !== 200) return reject(new Error(`hub snapshot: ${res.statusCode}`));
        let buf = "";
        res.on("data", (d) => {
          buf += d.toString("utf8");
          const m = /^data: (\{.*\})\n/m.exec(buf);
          if (m) {
            try {
              resolve(JSON.parse(m[1]));
            } catch (e) {
              reject(e);
            }
            res.destroy();
          }
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("hub timeout")));
  });
}

function sessionIdsByRecency(snap) {
  const out = [];
  for (const w of snap.workspaces ?? []) {
    for (const s of w.sessions ?? []) out.push({ id: s.id, at: s.updatedAt || 0 });
  }
  return out.sort((a, b) => b.at - a.at).map((s) => s.id);
}

/** Run fn(sid) on the most recently used LIVE session (tries each in turn). */
async function withLiveSid(rec, fn) {
  const snap = await snapshot(rec);
  const ids = sessionIdsByRecency(snap);
  if (!ids.length) throw new Error("Ouvrez d\u2019abord une session dans la fen\u00eatre principale.");
  let lastErr = null;
  for (const sid of ids) {
    try {
      return await fn(sid);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("Aucune session active.");
}

const sendSlash = (rec, text) => withLiveSid(rec, (sid) => api(rec, "POST", "/msg", { sid, text }));
const cycleMode = (rec) => withLiveSid(rec, (sid) => api(rec, "POST", "/cycle", { sid }));
const cancelTurn = (rec) => withLiveSid(rec, (sid) => api(rec, "POST", "/cancel", { sid }));
const openTerminal = (rec) => withLiveSid(rec, (sid) => api(rec, "POST", "/term/open", { sid }));
/** Ouvre un terminal et y tape une commande (ex: build). */
const runInTerminal = (rec, text) => withLiveSid(rec, async (sid) => {
  const t = await api(rec, "POST", "/term/open", { sid });
  await api(rec, "POST", "/term/input", { sid, tid: t.tid, text: text.endsWith("\n") ? text : `${text}\n` });
  return t;
});
const openTerminalSid = (rec, sid) => api(rec, "POST", "/term/open", { sid });

/** Reprend la session la plus recente, sinon en ouvre une neuve. Retourne son sid. */
async function ensureSession(rec, workspace) {
  const snap = await snapshot(rec);
  const ids = sessionIdsByRecency(snap);
  for (const sid of ids) {
    try {
      await api(rec, "POST", "/sessions/resume", { id: sid });
      return sid;
    } catch { /* essaye la suivante */ }
  }
  const r = await api(rec, "POST", "/sessions/new", { workspace });
  if (!r?.id) throw new Error("Impossible d\u2019ouvrir une session.");
  return r.id;
}

async function ping(rec) {
  try {
    const r = await api(rec, "GET", "/ping", null);
    return !!r?.ok;
  } catch {
    return false;
  }
}

/** Start the hub if none answers, then return its record + base URL.
 * With expectedVersion: refuse to attach to an outdated hub (OLD_HUB error
 * carrying its version/pid) instead of silently serving old code. */
async function ensureHub({ projectDir, distIndex, expectedVersion, allowStale }) {
  let rec = readHubRecord();
  if (rec && (await ping(rec))) {
    if (expectedVersion && !allowStale) {
      try {
        const info = await api(rec, "GET", "/ping", null);
        if (info?.ok && info?.version && info.version !== expectedVersion) {
          const err = new Error(`OLD_HUB ${info.version}`);
          err.code = "OLD_HUB";
          err.hubVersion = info.version;
          err.hubPid = rec.pid;
          err.hubStartedAt = info.startedAt;
          throw err;
        }
      } catch (e) {
        if (e?.code === "OLD_HUB") throw e;
      }
    }
    return { rec, url: hubUrl(rec) };
  }
  const env = { ...process.env };
  if (process.versions?.electron) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  const child = spawn(process.execPath, [distIndex, "--web"], {
    cwd: projectDir,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env,
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    rec = readHubRecord();
    if (rec && (await ping(rec))) return { rec, url: hubUrl(rec) };
  }
  throw new Error("Le serveur smolcoder ne d\u00e9marre pas (v\u00e9rifiez qu\u2019Ollama ou LM Studio tourne).");
}

function hubUrl(rec) {
  return `http://127.0.0.1:${rec.port}/?k=${rec.token}`;
}

module.exports = { dataDir, readHubRecord, api, snapshot, withLiveSid, sendSlash, cycleMode, cancelTurn, openTerminal, openTerminalSid, runInTerminal, ensureSession, ping, ensureHub, hubUrl };

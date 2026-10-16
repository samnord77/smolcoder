"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const { pathToFileURL, fileURLToPath } = require("node:url");

const TRACE = process.env.SMOL_DAP_TRACE === "1";
function trace() {
  if (TRACE) process.stderr.write(`[dap-node] ${Array.prototype.join.call(arguments, " ")}\n`);
}

let seq = 0;
let outBuf = Buffer.alloc(0);

function encode(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"), body]);
}

function respond(req, body) {
  process.stdout.write(
    encode({ seq: ++seq, type: "response", request_seq: req.seq, success: true, command: req.command, body: body || {} })
  );
}

function respondError(req, message) {
  process.stdout.write(
    encode({
      seq: ++seq,
      type: "response",
      request_seq: req.seq,
      success: false,
      command: req.command,
      message: String(message).slice(0, 300),
    })
  );
}

function emitEvent(name, body) {
  process.stdout.write(encode({ seq: ++seq, type: "event", event: name, body: body || {} }));
}

function emitOutput(text) {
  const t = String(text || "").replace(/\r?\n$/, "");
  if (t) emitEvent("output", { category: "stdout", output: `${t}\n` });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (ev) => this.onMessage(ev));
  }

  static connect(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error("inspector websocket timed out"));
      }, timeoutMs || 15000);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new Cdp(ws));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("could not open the inspector websocket"));
      });
    });
  }

  onMessage(ev) {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || "inspector error"));
      else p.resolve(msg.result || {});
      return;
    }
    if (msg.method) {
      this.events.push(msg);
      trace("cdp event:", msg.method, JSON.stringify(msg.params || {}).slice(0, 220));
    }
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
  }

  send(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`inspector timed out on ${method}`));
      }, timeoutMs || 15000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      } catch (err) {
        trace("envoi", method, "ECHEC:", err && err.message);
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  takeEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }
}

let cdp = null;
let child = null;
let pausedFrames = [];
let scopeRefs = new Map();
let nextScopeRef = 1;
const scriptUrls = new Map();
let lastActivity = Date.now();
let stopsDelivered = 0;
const touch = () => {
  lastActivity = Date.now();
};
let stopping = false;
const mainThread = 1;

function scopeRefFor(objectId) {
  if (!objectId) return 0;
  let ref = scopeRefs.get(objectId);
  if (!ref) {
    ref = nextScopeRef++;
    scopeRefs.set(objectId, ref);
  }
  return ref;
}

function urlOf(absPath) {
  return pathToFileURL(absPath).href;
}

function absPathOf(raw) {
  const s = String(raw || "");
  if (!s) return null;
  if (s.startsWith("file://")) {
    try {
      return fileURLToPath(s);
    } catch {
      return null;
    }
  }
  if (/^https?:/.test(s)) return s;
  return path.resolve(s);
}

function parse() {
  for (;;) {
    const headEnd = outBuf.indexOf("\r\n\r\n");
    if (headEnd < 0) return;
    const head = outBuf.slice(0, headEnd).toString("utf8");
    const m = /Content-Length:\s*(\d+)/i.exec(head);
    if (!m) {
      outBuf = outBuf.slice(headEnd + 4);
      continue;
    }
    const len = Number(m[1]);
    if (outBuf.length < headEnd + 4 + len) return;
    const text = outBuf.slice(headEnd + 4, headEnd + 4 + len).toString("utf8");
    outBuf = outBuf.slice(headEnd + 4 + len);
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      continue;
    }
    if (msg && msg.type === "request") handle(msg).catch((err) => respondError(msg, err && err.message ? err.message : String(err)));
  }
}

async function handle(msg) {
  const a = msg.arguments || {};
  switch (msg.command) {
    case "initialize":
      respond(msg, {
        supportsConfigurationDoneRequest: true,
        supportsDoneInOnIsr: false,
        supportsRestartRequest: false,
        supportsTerminateRequest: true,
      });
      return;

    case "launch":
      await doLaunch(msg, a);
      return;

    case "attach":
      respondError(msg, "cet adaptateur lance le programme lui-meme : utilisez launch");
      return;

    case "setBreakpoints":
      doSetBreakpoints(msg, a);
      return;

    case "configurationDone":
      respond(msg, {});
      try {
        await cdp.send("Debugger.resume", {}, 5000);
      } catch (err) {
        trace("configurationDone: resume refuse:", err && err.message, "-> liberation de la cible");
        try {
          await cdp.send("Runtime.runIfWaitingForDebugger", {}, 5000);
        } catch (err2) {
          trace("runIfWaitingForDebugger a echoue:", err2 && err2.message);
          emitOutput(`(reprise impossible : ${err2 && err2.message})`);
        }
      }
      return;

    case "stackTrace": {
      const frames = pausedFrames.map(toDapFrame).filter(Boolean);
      respond(msg, { stackFrames: (frames.length ? frames : pausedFrames.map(toDapFrame).filter(Boolean)).slice(0, 8) });
      return;
    }

    case "scopes": {
      const frame = pausedFrames.find((f) => String(f.callFrameId) === String(a.frameId)) || pausedFrames[0];
      const scopes = (frame && frame.scopeChain ? frame.scopeChain : []).map((s) => ({
        name: s.name || s.type || "scope",
        variablesReference: scopeRefFor(s.objectId),
        expensive: false,
      }));
      respond(msg, { scopes });
      return;
    }

    case "variables": {
      const objectId = [...scopeRefs.entries()].find(([, ref]) => ref === Number(a.variablesReference));
      if (!objectId || !a.variablesReference) {
        respond(msg, { variables: [] });
        return;
      }
      let vars = [];
      try {
        const res = await cdp.send("Runtime.getProperties", {
          objectId: objectId[0],
          ownProperties: true,
          accessorProperties: true,
          generatePreview: true,
        });
        vars = (res.result || []).slice(0, 20).map((p) => ({ name: p.name, value: fmtVal(p) }));
      } catch (err) {
        trace("variables echouees:", err && err.message);
        emitOutput(`(variables indisponibles : ${err && err.message})`);
      }
      respond(msg, { variables: vars });
      return;
    }

    case "threads":
      respond(msg, { threads: [{ id: mainThread, name: "main" }] });
      return;

    case "next":
      respond(msg, {});
      await resume("Debugger.stepOver");
      return;

    case "continue":
      respond(msg, {});
      await resume("Debugger.resume");
      return;

    case "pause":
      respond(msg, {});
      try {
        await cdp.send("Debugger.pause", {}, 5000);
      } catch {}
      return;

    case "disconnect":
      respond(msg, {});
      finish();
      return;

    default:
      respond(msg, {});
  }
}

function fmtVal(p) {
  const v = p.value;
  if (!v) return String(p.description || "undefined").slice(0, 120);
  if (v.value !== undefined) return String(v.value).slice(0, 120);
  if (v.description) return String(v.description).slice(0, 120);
  if (v.unserializableValue) return String(v.unserializableValue).slice(0, 120);
  return String(v.type || "object").slice(0, 120);
}

function toDapFrame(f) {
  const scriptId = f.location && f.location.scriptId;
  const url = f.url || (scriptId ? scriptUrls.get(scriptId) : "");
  if (!url) return null;
  const abs = /^https?:/.test(url) ? url : absPathOf(url);
  if (!abs) return null;
  return {
    id: f.callFrameId,
    name: f.functionName || "(anonymous)",
    line: (f.location ? f.location.lineNumber : 0) + 1,
    column: (f.location ? f.location.columnNumber : 0) + 1,
    source: { name: path.basename(abs), path: abs, origin: "smolcoder" },
  };
}

async function resume(method) {
  if (!cdp || stopping) {
    trace("resume ignore: cdp=", !!cdp, "stopping=", stopping);
    return;
  }
  try {
    const r = await cdp.send(method, {}, 8000);
    trace(method, "-> OK", JSON.stringify(r || {}).slice(0, 120));
  } catch (err) {
    trace(method, "-> ECHEC:", err && err.message);
    emitOutput(`(reprise impossible : ${err && err.message})`);
  }
}

async function doLaunch(msg, a) {
  const program = a.program;
  if (!program || typeof program !== "string") {
    respondError(msg, 'launch a besoin de "program"');
    return;
  }
  const abs = path.resolve(program);
  if (!require("node:fs").existsSync(abs)) {
    respondError(msg, `programme introuvable : ${program}`);
    return;
  }
  const progArgs = (Array.isArray(a.args) ? a.args : []).map(String);

  child = spawn(process.execPath, ["--inspect-brk=0", abs, ...progArgs], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  let wsUrl = "";
  let stderr = "";
  const deadline = Date.now() + 20000;

  await new Promise((resolve) => {
    const onErr = (d) => {
      stderr += d.toString();
      const m = /Debugger listening on (ws:\/\/\S+)/.exec(stderr);
      if (m && !wsUrl) {
        wsUrl = m[1];
        resolve();
      }
    };
    child.stderr.on("data", onErr);
    child.stdout.on("data", (d) => {
      touch();
      if (/Debugger listening on (ws:\/\/\S+)/.exec(d.toString()) && !wsUrl) {
        const m = /Debugger listening on (ws:\/\/\S+)/.exec(d.toString());
        wsUrl = m[1];
        resolve();
      } else {
        emitOutput(d.toString());
      }
    });
    const poll = setInterval(() => {
      if (wsUrl || Date.now() > deadline || child.exitCode !== null) {
        clearInterval(poll);
        resolve();
      }
    }, 200);
    child.on("exit", () => {
      clearInterval(poll);
      resolve();
    });
  });

  if (!wsUrl) {
    respondError(msg, `l'inspecteur Node n'a jamais ouvert son port${stderr ? ` : ${stderr.slice(0, 120)}` : ""}`);
    finish();
    return;
  }

  try {
    cdp = await Cdp.connect(wsUrl, 15000);
  } catch (err) {
    respondError(msg, err && err.message ? err.message : String(err));
    finish();
    return;
  }

  try {
    await cdp.send("Runtime.enable", {}, 8000);
    await cdp.send("Debugger.enable", { maxScriptsCacheSize: 1000000 }, 8000);
  } catch (err) {
    respondError(msg, `activation de l'inspecteur impossible : ${err && err.message}`);
    finish();
    return;
  }

  const onCdpEvent = (m) => {
    if (m.method === "Debugger.paused") {
      const reason = (m.params && m.params.reason) || "pause";
      if (/^Break on start/i.test(reason) && !stopping) {
        trace("pause de demarrage masquee, on enchaine sur les points d'arret");
        resume("Debugger.resume");
        return;
      }
      pausedFrames = m.params && m.params.callFrames ? m.params.callFrames : [];
      scopeRefs = new Map();
      nextScopeRef = 1;
      stopsDelivered++;
      touch();
      emitEvent("stopped", { reason, threadId: mainThread, description: reason });
    } else if (m.method === "Debugger.scriptParsed") {
      if (m.params && m.params.scriptId) scriptUrls.set(m.params.scriptId, m.params.url || "");
    } else if (m.method === "Debugger.resumed") {
      pausedFrames = [];
      touch();
    } else if (m.method === "Runtime.exceptionThrown") {
      const d = m.params && m.params.exceptionDetails;
      emitOutput(`exception : ${(d && ((d.exception && d.exception.description) || d.text)) || "inconnue"}`);
    }
  };
  cdp.ws.addEventListener("message", (ev) => {
    let m;
    try {
      m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    } catch {
      return;
    }
    if (m.method) onCdpEvent(m);
  });

  child.on("exit", (code, signal) => {
    trace("processus enfant termine code=", code, "signal=", signal, "stopping=", stopping);
    if (stopping) return;
    stopping = true;
    emitEvent("exited", { exitCode: code === null ? undefined : code });
    emitEvent("terminated", {});
    setTimeout(() => process.exit(0), 300);
  });

  const idle = setInterval(() => {
    if (stopping || !child || child.exitCode !== null) return;
    if (stopsDelivered > 0 && Date.now() - lastActivity > 2500) {
      trace("aucune activite depuis une reprise -> on ferme l'inspecteur pour laisser le processus se terminer");
      clearInterval(idle);
      try {
        if (cdp) cdp.ws.close();
      } catch {
        /* deja ferme */
      }
    }
  }, 400);

  respond(msg, {});
}

function doSetBreakpoints(msg, a) {
  const src = a.source || {};
  const abs = src.path ? path.resolve(String(src.path)) : null;
  const wanted = (Array.isArray(a.breakpoints) ? a.breakpoints : [])
    .map((b) => Number(b && b.line))
    .filter((n) => Number.isFinite(n) && n >= 1)
    .slice(0, 20);
  if (!abs || !wanted.length) {
    respond(msg, { breakpoints: wanted.map((line) => ({ line, verified: false })) });
    return;
  }
  const url = urlOf(abs);
  const results = wanted.map((line) => ({ line, verified: false, id: undefined }));
  let idx = 0;
  const step = () => {
    if (idx >= wanted.length) {
      respond(msg, { breakpoints: results });
      return;
    }
    const line = wanted[idx];
    cdp
      .send("Debugger.setBreakpointByUrl", { url, lineNumber: line - 1, columnNumber: 0 }, 10000)
      .then((res) => {
        const locs = res.locations || [];
        results[idx] = { line, verified: Boolean(res.breakpointId), id: res.breakpointId };
        if (!locs.length) trace("point d'arret accepte, sera resolu au demarrage :", res.breakpointId);
        idx++;
        step();
      })
      .catch(() => {
        idx++;
        step();
      });
  };
  if (!cdp) {
    respond(msg, { breakpoints: results });
    return;
  }
  step();
}

function finish() {
  stopping = true;
  try {
    if (cdp) cdp.send("Debugger.resume", {}, 1000).catch(() => {});
  } catch {}
  try {
    if (child) child.kill();
  } catch {}
  setTimeout(() => process.exit(0), 250);
}

process.stdin.on("data", (d) => {
  outBuf = Buffer.concat([outBuf, d]);
  parse();
});
process.stdin.on("end", () => finish());
process.stdin.resume();

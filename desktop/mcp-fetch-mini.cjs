#!/usr/bin/env node
"use strict";
// Mini serveur MCP "fetch" autonome (aucune dependance npm).
// Remplace le serveur fetch casse (jsdom incomplet) et fonctionne sans reseau externe.
const http = require("http");
const https = require("https");

const VERSION = "1.0.0";
const MAX_BODY = 2000000;

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function get(url, depth) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      reject(new Error("URL invalide"));
      return;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      reject(new Error(`protocole non supporte: ${u.protocol}`));
      return;
    }
    const lib = u.protocol === "https:" ? https : http;
    const opts = {
      headers: {
        "user-agent": "smolcoder-fetch-mini/1.0",
        accept: "text/html,text/plain,application/json,*/*",
      },
    };
    const req = lib.get(u, opts, (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].indexOf(code) >= 0 && res.headers.location && (depth || 0) < 5) {
        res.resume();
        resolve(get(new URL(res.headers.location, u).href, (depth || 0) + 1));
        return;
      }
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (d) => {
        buf += d;
        if (buf.length > MAX_BODY) req.destroy();
      });
      res.on("end", () => {
        resolve({ status: code, ctype: res.headers["content-type"] || "", body: buf });
      });
    });
    req.on("error", (err) => {
      reject(new Error(`connexion impossible: ${err.message}`));
    });
    req.setTimeout(25000, () => req.destroy(new Error("delai depasse (25s)")));
  });
}
const FETCH_TOOL = {
  name: "fetch",
  description:
    "Recupere une URL (http/https) et renvoie son contenu textuel. Suit jusqu'a 5 redirections.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL absolue a recuperer" },
      max_length: { type: "integer", description: "Nombre max de caracteres renvoyes (defaut 20000)" },
      start_index: { type: "integer", description: "Index de depart dans le contenu" },
      raw: { type: "boolean", description: "Renvoyer le HTML brut sans nettoyage" },
    },
    required: ["url"],
  },
};

async function fetchTool(args) {
  const url = args.url;
  if (!url || typeof url !== "string") {
    throw new Error("argument 'url' requis");
  }
  const res = await get(url, 0);
  const ctype = String(res.ctype || "");
  const raw = args.raw === true;
  let body = String(res.body || "");
  if (!raw && ctype.indexOf("html") >= 0) {
    body = stripHtml(body);
  }
  const maxLength = Number.isFinite(Number(args.max_length)) ? Number(args.max_length) : 20000;
  const startIndex = Number.isFinite(Number(args.start_index))
    ? Math.max(0, Number(args.start_index))
    : 0;
  const sliced = body.slice(startIndex, startIndex + maxLength);
  return `HTTP ${res.status} | ${ctype || "type inconnu"} | ${body.length} caracteres\n\n${sliced}`;
}

async function handle(msg) {
  const id = msg.id;
  const method = msg.method;
  const params = msg.params || {};
  if (method === "initialize") {
    const version = params.protocolVersion || "2024-11-05";
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "smolcoder-fetch-mini", version: VERSION },
      },
    };
  }
  if (method === "notifications/initialized" || method === "initialized") {
    return null;
  }
  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: [FETCH_TOOL] } };
  }
  if (method === "tools/call") {
    if (params.name !== "fetch") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: `Outil inconnu: ${params.name}` }],
        },
      };
    }
    try {
      const out = await fetchTool(params.arguments || {});
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: out }] } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id,
        result: { isError: true, content: [{ type: "text", text: `Echec fetch: ${message}` }] },
      };
    }
  }
  if (id === undefined) {
    return null;
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Methode non supportee: ${method}` } };
}

function dispatch(line) {
  let msg = null;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  handle(msg)
    .then((reply) => {
      if (reply) {
        send(reply);
      }
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      if (msg && msg.id !== undefined) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message } });
      }
    });
}

let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  let idx = pending.indexOf("\n");
  while (idx >= 0) {
    const line = pending.slice(0, idx).trim();
    pending = pending.slice(idx + 1);
    if (line) {
      dispatch(line);
    }
    idx = pending.indexOf("\n");
  }
});
process.stdin.on("end", () => {
  process.exit(0);
});

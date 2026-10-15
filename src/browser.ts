// browser: an agent-driven local browser, spoken to over the Chrome DevTools
// Protocol. No dependency: Node's built-in WebSocket drives a headless
// Chrome/Edge started with --remote-debugging-port=0, and the real port is
// read from the DevToolsActivePort file. One `browser` tool (see
// tools/browser.ts) exposes open/read/click/type/press/shot/back/close;
// read-only mode keeps only the non-mutating actions. The browser starts on
// first use, closes itself after ten idle minutes, and is closed with the
// session.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findCommand } from "./mcp";

export const BROWSER_LAUNCH_TIMEOUT_MS = 20_000;
export const BROWSER_ACTION_TIMEOUT_MS = 15_000;
export const BROWSER_NAV_TIMEOUT_MS = 20_000;
export const BROWSER_IDLE_MS = 10 * 60 * 1000;
export const BROWSER_READ_CAP = 6000;
export const BROWSER_SHOT_DIR = ".smol/screenshots";

/** Absolute paths where Chrome/Edge/Chromium usually live, per platform. */
function browserCandidates(): string[] {
  const env = (name: string) => (process.env[name] ?? "").trim();
  const out: string[] = [];
  if (process.platform === "win32") {
    const pf = env("ProgramFiles") || "C:\\Program Files";
    const pf86 = env("ProgramFiles(x86)") || "C:\\Program Files (x86)";
    const local = env("LOCALAPPDATA");
    out.push(
      path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      local ? path.join(local, "Google", "Chrome", "Application", "chrome.exe") : "",
      path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    );
  } else if (process.platform === "darwin") {
    out.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    );
  } else {
    out.push(
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
    );
  }
  return out.filter(Boolean);
}

/** Locate a Chromium-based browser. SMOLCODER_BROWSER wins; then the usual
 *  install paths; then a PATH lookup. Returns an absolute path, or null. */
export function findBrowser(): string | null {
  const forced = (process.env.SMOLCODER_BROWSER ?? "").trim();
  if (forced) {
    if (fs.existsSync(forced)) return forced;
    return findCommand(forced);
  }
  for (const candidate of browserCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const name of ["chrome", "google-chrome", "google-chrome-stable", "msedge", "microsoft-edge", "chromium", "chromium-browser"]) {
    const found = findCommand(name);
    if (found) return found;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`le navigateur a refusé ${url} (${res.status})`);
  return res.json();
}

/** Poll the DevToolsActivePort file until the browser writes its real port. */
async function waitForPort(file: string, timeoutMs: number, dead: () => boolean): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (dead()) throw new Error("le navigateur s'est arrêté pendant le démarrage");
    try {
      const first = fs.readFileSync(file, "utf8").split(/\r?\n/, 1)[0]?.trim();
      const port = Number(first);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      /* not written yet */
    }
    await sleep(120);
  }
  throw new Error(`le navigateur n'a pas ouvert son port de débogage après ${Math.round(timeoutMs / 1000)} s`);
}

export interface BrowserPageInfo {
  title: string;
  url: string;
}

export interface BrowserRead extends BrowserPageInfo {
  text: string;
  truncated: boolean;
}

export interface BrowserTargetResult {
  ok: boolean;
  tag?: string;
  text?: string;
}

export interface BrowserShot {
  rel: string;
  bytes: number;
}

/** Minimal CDP client: one WebSocket, id-paired replies, named events. */
class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Map<string, Array<{ resolve: (p: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>>();
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      this.route(String((ev as { data?: unknown }).data ?? ""));
    });
    ws.addEventListener("close", () => {
      this.failAll(new Error("navigateur déconnecté"));
    });
    ws.addEventListener("error", () => {
      this.failAll(new Error("erreur WebSocket avec le navigateur"));
    });
  }

  static connect(url: string, timeoutMs: number): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* best effort */
        }
        reject(new Error("connexion au navigateur expirée"));
      }, timeoutMs);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve(new Cdp(ws));
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("connexion au protocole du navigateur impossible"));
        },
        { once: true },
      );
    });
  }

  private route(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const slot = this.pending.get(msg.id);
      if (!slot) return;
      this.pending.delete(msg.id);
      clearTimeout(slot.timer);
      if (msg.error) slot.reject(new Error(String(msg.error.message ?? "erreur CDP")));
      else slot.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg.method === "string") {
      const queue = this.listeners.get(msg.method);
      if (!queue?.length) return;
      const waiter = queue.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(msg.params ?? {});
      }
    }
  }

  send(method: string, params: Record<string, any> = {}, timeoutMs = BROWSER_ACTION_TIMEOUT_MS): Promise<any> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new Error("navigateur fermé"));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`le navigateur n'a pas répondu à ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  waitEvent(method: string, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const list = this.listeners.get(method) ?? [];
      this.listeners.set(method, list);
      let entry: { resolve: (p: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
      const timer = setTimeout(() => {
        const i = list.indexOf(entry);
        if (i >= 0) list.splice(i, 1);
        reject(new Error(`événement ${method} non reçu`));
      }, timeoutMs);
      entry = { resolve, reject, timer };
      list.push(entry);
    });
  }

  private failAll(err: Error): void {
    this.closed = true;
    for (const slot of this.pending.values()) {
      clearTimeout(slot.timer);
      slot.reject(err);
    }
    this.pending.clear();
    for (const list of this.listeners.values()) {
      for (const waiter of list) {
        clearTimeout(waiter.timer);
        waiter.reject(err);
      }
    }
    this.listeners.clear();
  }

  close(): void {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* best effort */
    }
  }
}

/** One browser per session: lazy start, ten idle minutes, polite shutdown. */
export class BrowserSession {
  private child: ChildProcess | null = null;
  private cdp: Cdp | null = null;
  private userDataDir = "";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  get running(): boolean {
    return Boolean(this.cdp && this.child && this.child.exitCode === null);
  }

  /** Start (or reuse) the browser; safe to call before every action. */
  async ensure(): Promise<void> {
    if (this.running) {
      this.touch();
      return;
    }
    await this.launch();
  }

  private async launch(): Promise<void> {
    const exe = findBrowser();
    if (!exe) {
      throw new Error(
        "aucun navigateur compatible trouvé — installez Chrome ou Edge, ou définissez SMOLCODER_BROWSER vers l'exécutable",
      );
    }
    this.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-browser-"));
    const child = spawn(
      exe,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${this.userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-gpu",
        "about:blank",
      ],
      { stdio: "ignore", windowsHide: true },
    );
    this.child = child;
    child.once("exit", () => this.reset());
    try {
      const port = await waitForPort(path.join(this.userDataDir, "DevToolsActivePort"), BROWSER_LAUNCH_TIMEOUT_MS, () => child.exitCode !== null);
      const targets = (await fetchJson(`http://127.0.0.1:${port}/json/list`)) as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl) ?? targets.find((t) => t.webSocketDebuggerUrl);
      if (!page?.webSocketDebuggerUrl) throw new Error("aucune page de débogage exposée par le navigateur");
      this.cdp = await Cdp.connect(page.webSocketDebuggerUrl, BROWSER_LAUNCH_TIMEOUT_MS);
      await this.cdp.send("Page.enable");
      await this.cdp.send("Runtime.enable");
      await this.warmUp();
      this.touch();
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  private reset(): void {
    try {
      this.cdp?.close();
    } catch {
      /* best effort */
    }
    this.cdp = null;
    this.child = null;
    this.clearIdle();
  }

  /** Premier contact à froid : Chrome peut être lent à répondre une fois
   *  lancé (tout premier démarrage, mise à jour en tâche de fond…). Un
   *  échange raté ici ne doit jamais faire échouer la première action. */
  private async warmUp(): Promise<void> {
    const cdp = this.require();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await cdp.send("Runtime.evaluate", { expression: "1", returnByValue: true }, 30_000);
        return;
      } catch {
        if (attempt === 1) throw new Error("le navigateur ne répond pas après son démarrage");
        await sleep(500);
      }
    }
  }

  private touch(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      void this.close();
    }, BROWSER_IDLE_MS);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private require(): Cdp {
    if (!this.cdp) throw new Error('le navigateur n\'est pas démarré — utilisez d\'abord {"action": "open"}');
    return this.cdp;
  }

  private async evaluate(expression: string): Promise<any> {
    const res = await this.require().send("Runtime.evaluate", { expression, returnByValue: true });
    if (res.exceptionDetails) {
      const details = res.exceptionDetails as { exception?: { description?: string }; text?: string };
      const desc = String(details.exception?.description ?? details.text ?? "erreur JavaScript").split("\n")[0];
      throw new Error(desc.slice(0, 200));
    }
    return res.result?.value;
  }

  async open(url: string): Promise<BrowserPageInfo> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`adresse invalide : « ${url} »`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`schéma non supporté (${parsed.protocol}) — http et https seulement`);
    }
    await this.ensure();
    const cdp = this.require();
    const loaded = cdp.waitEvent("Page.loadEventFired", BROWSER_NAV_TIMEOUT_MS).catch(() => null);
    await cdp.send("Page.navigate", { url: parsed.href });
    await loaded;
    // La navigation a pu remplacer le renderer pendant l'échange : un
    // premier échec se rejoue une fois, une fois la page posée.
    const info = await this.pageInfo().catch(async () => {
      await sleep(400);
      return this.pageInfo();
    });
    this.touch();
    return info;
  }

  async pageInfo(): Promise<BrowserPageInfo> {
    const value = await this.evaluate('JSON.stringify({ title: document.title || "", url: location.href })');
    try {
      return JSON.parse(value) as BrowserPageInfo;
    } catch {
      return { title: "", url: "" };
    }
  }

  async read(): Promise<BrowserRead> {
    const value = await this.evaluate(
      `(() => {
        const body = document.body;
        const text = (body ? (body.innerText || "") : "").replace(/\\n{3,}/g, "\\n\\n").trim();
        return JSON.stringify({ title: document.title || "", url: location.href, text: text.slice(0, ${BROWSER_READ_CAP + 1}) });
      })()`,
    );
    let info: { title: string; url: string; text: string };
    try {
      info = JSON.parse(value) as { title: string; url: string; text: string };
    } catch {
      throw new Error("lecture de la page impossible");
    }
    const truncated = info.text.length > BROWSER_READ_CAP;
    this.touch();
    return { ...info, text: truncated ? info.text.slice(0, BROWSER_READ_CAP) : info.text, truncated };
  }

  async click(selector: string): Promise<BrowserTargetResult> {
    const value = await this.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify({ ok: false });
        el.scrollIntoView({ block: "center", inline: "center" });
        const tag = el.tagName.toLowerCase();
        const text = String(el.innerText || el.value || el.getAttribute("aria-label") || "").trim().slice(0, 80);
        el.click();
        return JSON.stringify({ ok: true, tag, text });
      })()`,
    );
    const res = JSON.parse(String(value)) as BrowserTargetResult;
    if (res.ok) this.touch();
    return res;
  }

  async type(selector: string, text: string, submit: boolean): Promise<BrowserTargetResult & { submitted: boolean }> {
    const value = await this.evaluate(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return JSON.stringify({ ok: false });
        el.focus();
        if ("value" in el) {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(el, ${JSON.stringify(text)});
          else el.value = ${JSON.stringify(text)};
        } else {
          el.textContent = ${JSON.stringify(text)};
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return JSON.stringify({ ok: true, tag: el.tagName.toLowerCase() });
      })()`,
    );
    const res = JSON.parse(String(value)) as BrowserTargetResult;
    if (!res.ok) return { ok: false, submitted: false };
    this.touch();
    if (!submit) return { ...res, submitted: false };
    const cdp = this.require();
    const loaded = cdp.waitEvent("Page.loadEventFired", 5000).catch(() => null);
    let submitted = false;
    try {
      submitted = Boolean(
        await this.evaluate(
          `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          if (el.form && typeof el.form.requestSubmit === "function") {
            el.form.requestSubmit();
            return true;
          }
          return false;
        })()`,
        ),
      );
    } catch {
      // La réponse a pu se perdre pendant la navigation déclenchée par la
      // soumission : c'est le signe que le formulaire est parti.
      submitted = true;
    }
    if (submitted) await loaded;
    else await this.press("Enter");
    this.touch();
    return { ...res, submitted: true };
  }

  async press(key: string): Promise<void> {
    const table: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
      Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
      Tab: { key: "Tab", code: "Tab", keyCode: 9 },
      Escape: { key: "Escape", code: "Escape", keyCode: 27 },
      Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
      ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
      ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
      ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
      ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    };
    const spec = table[key] ?? { key, code: key, keyCode: 0 };
    const cdp = this.require();
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
      ...(spec.text ? { text: spec.text } : {}),
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.keyCode,
    });
    this.touch();
  }

  async screenshot(workspace: string): Promise<BrowserShot> {
    const res = await this.require().send("Page.captureScreenshot", { format: "png" }, BROWSER_NAV_TIMEOUT_MS);
    const data = String(res.data ?? "");
    if (!data) throw new Error("capture d'écran vide");
    const buf = Buffer.from(data, "base64");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const rel = `${BROWSER_SHOT_DIR}/browser-${stamp}.png`;
    const abs = path.join(workspace, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    this.touch();
    return { rel, bytes: buf.length };
  }

  async back(): Promise<BrowserPageInfo> {
    const cdp = this.require();
    const loaded = cdp.waitEvent("Page.loadEventFired", 8000).catch(() => null);
    // L'évaluation déclenche la navigation : la réponse CDP peut se perdre
    // (« Inspected target navigated or closed ») — le retour, lui, a eu lieu.
    await this.evaluate("history.back(); true").catch(() => undefined);
    await Promise.race([loaded, sleep(1500)]);
    const info = await this.pageInfo().catch(() => ({ title: "", url: "" }));
    this.touch();
    return info;
  }

  async close(): Promise<void> {
    this.clearIdle();
    const cdp = this.cdp;
    this.cdp = null;
    try {
      cdp?.close();
    } catch {
      /* best effort */
    }
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) {
      if (process.platform === "win32" && child.pid) {
        try {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        } catch {
          /* fall through to child.kill */
        }
      }
      try {
        child.kill();
      } catch {
        /* best effort */
      }
    }
    const dir = this.userDataDir;
    this.userDataDir = "";
    if (dir) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* browser helpers may still hold files; the temp dir is disposable */
      }
    }
  }
}

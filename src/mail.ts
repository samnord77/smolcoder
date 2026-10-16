// Client mail réel — IMAP (lire la boîte) + SMTP (envoyer), écrit avec les
// modules natifs de Node : aucune dépendance externe, aucun faux serveur.
// Les tests utilisent des serveurs scriptés en sockets réels (test/mail.test.js).
import { randomUUID } from "node:crypto";
import * as net from "node:net";
import * as tls from "node:tls";
import { askHidden, askLine, type MailConfig, type MailEndpoint, mailConfig, updateConnectors } from "./connectors";

const CONNECT_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 12 * 1024 * 1024;
const LITERAL_KEEP_BYTES = 1024 * 1024;
const LIST_LIMIT_DEFAULT = 10;
const LIST_LIMIT_MAX = 50;
const BODY_TEXT_CAP = 20_000;

export interface MailSummary {
  uid: number;
  from: string;
  subject: string;
  date: string;
  seen: boolean;
}

export interface MailMessage extends MailSummary {
  to: string;
  text: string;
  bodyTruncated: boolean;
}

export interface MailCheck {
  ok: boolean;
  imap: string;
  smtp: string;
}

export interface SendRequest {
  to: string;
  cc?: string;
  subject: string;
  text: string;
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Bas niveau : tampon de connexion (lignes + littéraux IMAP exacts en octets).
// ---------------------------------------------------------------------------

class Wire {
  private sock: net.Socket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private err: Error | null = null;
  private ended = false;
  private wake: Array<() => void> = [];

  attach(sock: net.Socket): void {
    if (this.sock) this.detach(this.sock);
    this.sock = sock;
    sock.on("data", (chunk: Buffer) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      if (this.buf.length > MAX_BUFFER_BYTES) {
        this.err = new Error("réponse serveur trop volumineuse (pièce jointe géante ?) — opération interrompue");
      }
      this.notify();
    });
    sock.on("end", () => {
      this.ended = true;
      this.notify();
    });
    sock.on("close", () => {
      this.ended = true;
      this.notify();
    });
    sock.on("error", (e: Error) => {
      this.err = e;
      this.notify();
    });
  }

  detach(sock: net.Socket): void {
    sock.removeAllListeners("data");
    sock.removeAllListeners("end");
    sock.removeAllListeners("close");
    sock.removeAllListeners("error");
    if (this.sock === sock) this.sock = null;
  }

  destroy(): void {
    if (this.sock) {
      this.detach(this.sock);
      try {
        this.sock.destroy();
      } catch {
        // déjà fermé
      }
    }
    this.ended = true;
    this.notify();
  }

  private notify(): void {
    const waiting = this.wake;
    this.wake = [];
    for (const wake of waiting) wake();
  }

  private async waitFor(enough: () => boolean, deadline: number): Promise<void> {
    for (;;) {
      if (enough()) return;
      if (this.err) throw this.err;
      if (this.ended) throw new Error("connexion fermée par le serveur (réponse incomplète)");
      const remain = deadline - Date.now();
      if (remain <= 0) throw new Error("délai dépassé en attendant le serveur");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          const i = this.wake.indexOf(fn);
          if (i >= 0) this.wake.splice(i, 1);
          resolve();
        }, Math.min(remain, 400));
        const fn = () => {
          clearTimeout(timer);
          resolve();
        };
        this.wake.push(fn);
      });
    }
  }

  async line(deadline: number): Promise<string> {
    await this.waitFor(() => this.buf.indexOf("\r\n") >= 0, deadline);
    const end = this.buf.indexOf("\r\n");
    const line = this.buf.subarray(0, end).toString("utf8");
    this.buf = this.buf.subarray(end + 2);
    return line;
  }

  async exact(n: number, deadline: number, keepMax = LITERAL_KEEP_BYTES): Promise<{ data: Buffer; truncated: boolean }> {
    await this.waitFor(() => this.buf.length >= n, deadline);
    const keep = Math.min(n, keepMax);
    const data = Buffer.from(this.buf.subarray(0, keep));
    this.buf = this.buf.subarray(n);
    return { data, truncated: n > keep };
  }
}

function connectSocket(ep: MailEndpoint, deadline: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const timeoutMs = Math.max(1000, deadline - Date.now());
    let sock: net.Socket;
    try {
      sock = ep.secure
        ? tls.connect({ host: ep.host, port: ep.port, servername: ep.host })
        : net.connect({ host: ep.host, port: ep.port });
    } catch (e) {
      reject(new Error(msgOf(e)));
      return;
    }
    const ready = ep.secure ? "secureConnect" : "connect";
    const cleanup = () => {
      clearTimeout(timer);
      sock.off("error", onError);
      sock.off(ready, onReady);
    };
    const onError = (e: Error) => {
      cleanup();
      reject(new Error(msgOf(e)));
    };
    const onReady = () => {
      cleanup();
      resolve(sock);
    };
    const timer = setTimeout(() => {
      cleanup();
      sock.destroy();
      reject(new Error("délai de connexion dépassé"));
    }, timeoutMs);
    sock.once("error", onError);
    sock.once(ready, onReady);
  });
}

function upgradeToTls(sock: net.Socket, host: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const t = tls.connect({ socket: sock, servername: host });
    const timer = setTimeout(() => {
      t.destroy();
      reject(new Error("délai de négociation TLS dépassé"));
    }, CONNECT_TIMEOUT_MS);
    t.once("secureConnect", () => {
      clearTimeout(timer);
      resolve(t);
    });
    t.once("error", (e: Error) => {
      clearTimeout(timer);
      reject(new Error(msgOf(e)));
    });
  });
}

// ---------------------------------------------------------------------------
// Décodage MIME (en-têtes RFC 2047, quoted-printable, base64, multipart, HTML).
// ---------------------------------------------------------------------------

function decodeCharset(buf: Buffer, charset: string): string {
  const cs = charset.trim().toLowerCase().replace(/^"|"$/g, "");
  if (cs === "" || cs === "utf-8" || cs === "utf8" || cs === "us-ascii" || cs === "ascii") {
    return buf.toString("utf8");
  }
  if (cs.startsWith("iso-8859") || cs === "latin1" || cs === "windows-1252" || cs === "cp1252") {
    return buf.toString("latin1");
  }
  return buf.toString("utf8");
}

export function qpDecode(input: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const b = input[i];
    if (b === 0x3d) {
      // '=' : fin de ligne douce ou séquence =XX
      if (i + 1 < input.length && input[i + 1] === 0x0d && i + 2 < input.length && input[i + 2] === 0x0a) {
        i += 2;
        continue;
      }
      if (i + 1 < input.length && input[i + 1] === 0x0a) {
        i += 1;
        continue;
      }
      if (i + 2 < input.length) {
        const hex = input.subarray(i + 1, i + 3).toString("latin1");
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out.push(Number.parseInt(hex, 16));
          i += 2;
          continue;
        }
      }
    }
    out.push(b);
  }
  return Buffer.from(out);
}

export function decodeEncodedWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset: string, enc: string, data: string) => {
    try {
      const buf =
        enc.toUpperCase() === "B"
          ? Buffer.from(data, "base64")
          : qpDecode(Buffer.from(data.replace(/_/g, " "), "latin1"));
      return decodeCharset(buf, charset);
    } catch {
      return whole;
    }
  });
}

export function parseHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  let current = "";
  for (const line of raw.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && current) {
      out[current] = `${out[current]} ${line.trim()}`;
      continue;
    }
    const m = /^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/.exec(line);
    if (m) {
      current = m[1].toLowerCase();
      out[current] = out[current] ? `${out[current]} ${m[2]}` : m[2];
    }
  }
  return out;
}

function contentTypeOf(headers: Record<string, string>): { mime: string; params: Record<string, string> } {
  const ct = headers["content-type"] ?? "text/plain; charset=utf-8";
  const [mime, ...rest] = ct.split(";");
  const params: Record<string, string> = {};
  const re = /\s*([\w-]+)\s*=\s*(?:"([^"]*)"|([^;]*))/g;
  const joined = rest.join(";");
  for (let m = re.exec(joined); m !== null; m = re.exec(joined)) {
    params[m[1].toLowerCase()] = (m[2] ?? m[3] ?? "").trim();
  }
  return { mime: mime.trim().toLowerCase(), params };
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface MimePart {
  headers: string;
  body: Buffer;
}

function splitMultipart(body: Buffer, boundary: string): MimePart[] {
  const text = body.toString("latin1"); // aller-retour octet-exact
  const marker = `--${boundary}`;
  const segments = text.split(marker);
  const parts: MimePart[] = [];
  for (let i = 1; i < segments.length; i++) {
    let seg = segments[i];
    if (seg.startsWith("--")) break; // frontière finale
    seg = seg.replace(/^\r?\n/, "");
    const sep = seg.search(/\r?\n\r?\n/);
    if (sep < 0) continue;
    const headers = seg.slice(0, sep);
    const bodyText = seg.slice(sep).replace(/^\r?\n\r?\n/, "").replace(/\r?\n$/, "");
    parts.push({ headers, body: Buffer.from(bodyText, "latin1") });
  }
  return parts;
}

function extractPart(rawHeaders: string, rawBody: Buffer): { text: string; html: boolean } {
  const headers = parseHeaders(rawHeaders);
  const { mime, params } = contentTypeOf(headers);
  const enc = (headers["content-transfer-encoding"] ?? "").trim().toLowerCase();
  if (mime.startsWith("multipart/") && params.boundary) {
    let html = "";
    for (const part of splitMultipart(rawBody, params.boundary)) {
      const got = extractPart(part.headers, part.body);
      if (got.text && !got.html) return got;
      if (got.text && !html) html = got.text;
    }
    return { text: html, html: html !== "" };
  }
  let buf = rawBody;
  if (enc === "base64") {
    buf = Buffer.from(rawBody.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  } else if (enc === "quoted-printable") {
    buf = qpDecode(rawBody);
  }
  const text = decodeCharset(buf, params.charset ?? "utf-8");
  if (mime === "text/html") return { text: htmlToText(text), html: true };
  return { text, html: false };
}

// ---------------------------------------------------------------------------
// IMAP : lecture de la boîte.
// ---------------------------------------------------------------------------

function imapQuote(value: string): string {
  return value.replace(/[\\"]/g, "\\$&");
}

class ImapClient {
  private wire = new Wire();
  private sock: net.Socket | null = null;
  private tagSeq = 0;

  async connect(ep: MailEndpoint): Promise<void> {
    this.sock = await connectSocket(ep, Date.now() + CONNECT_TIMEOUT_MS);
    this.wire.attach(this.sock);
    const greeting = await this.wire.line(Date.now() + COMMAND_TIMEOUT_MS);
    if (!/^\* OK/i.test(greeting)) throw new Error(`accueil IMAP inattendu : ${greeting.slice(0, 160)}`);
  }

  private async command(text: string, literals?: Array<{ data: Buffer; truncated: boolean }>): Promise<string[]> {
    if (!this.sock) throw new Error("connexion IMAP absente");
    const tag = `A${++this.tagSeq}`;
    this.sock.write(`${tag} ${text}\r\n`);
    const deadline = Date.now() + COMMAND_TIMEOUT_MS;
    const lines: string[] = [];
    for (;;) {
      const line = await this.wire.line(deadline);
      const marker = /\{(\d+)\}$/.exec(line);
      if (marker) {
        const size = Number(marker[1]);
        const got = await this.wire.exact(size, Date.now() + COMMAND_TIMEOUT_MS);
        if (literals) literals.push(got);
        lines.push(`${line} <${size} octets>`);
        continue;
      }
      lines.push(line);
      if (new RegExp(`^${tag} `).test(line)) break;
      if (/^\* BYE\b/i.test(line)) throw new Error(`le serveur a fermé la session : ${line.slice(0, 160)}`);
    }
    const tagged = lines[lines.length - 1];
    if (!new RegExp(`^${tag} OK`, "i").test(tagged)) {
      throw new Error(tagged.replace(new RegExp(`^${tag} (?:NO|BAD)\\s*`, "i"), "") || "commande IMAP refusée");
    }
    return lines;
  }

  async login(user: string, password: string): Promise<void> {
    await this.command(`LOGIN "${imapQuote(user)}" "${imapQuote(password)}"`);
  }

  async select(mailbox: string): Promise<number> {
    const lines = await this.command(`SELECT "${imapQuote(mailbox)}"`);
    const m = /^\* (\d+) EXISTS/im.exec(lines.join("\n"));
    return m ? Number(m[1]) : 0;
  }

  async searchAll(): Promise<number[]> {
    const lines = await this.command("UID SEARCH ALL");
    const line = lines.find((l) => /^\* SEARCH\b/i.test(l));
    if (!line) return [];
    return line
      .split(/\s+/)
      .slice(2)
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n));
  }

  async fetch(uids: number[]): Promise<{ text: string; literals: Array<{ data: Buffer; truncated: boolean }> }> {
    const literals: Array<{ data: Buffer; truncated: boolean }> = [];
    const lines = await this.command(
      `UID FETCH ${uids.join(",")} (UID FLAGS BODY.PEEK[HEADER] BODY.PEEK[TEXT])`,
      literals
    );
    return { text: lines.join("\n"), literals };
  }

  async logout(): Promise<void> {
    try {
      await this.command("LOGOUT");
    } catch {
      // le serveur a déjà coupé : sans conséquence
    }
    this.wire.destroy();
  }
}

function splitFetchBlocks(text: string): string[] {
  return text.split(/(?=^\* \d+ FETCH)/m).filter((b) => /^\* \d+ FETCH/i.test(b));
}

function uidFlagsOf(block: string): { uid: number; seen: boolean } {
  const u = /\bUID (\d+)\b/i.exec(block);
  const f = /\bFLAGS \(([^)]*)\)/i.exec(block);
  return { uid: u ? Number(u[1]) : 0, seen: f ? /\\Seen\b/i.test(f[1]) : false };
}

// ---------------------------------------------------------------------------
// SMTP : envoi réel.
// ---------------------------------------------------------------------------

function cleanHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function cleanAddress(value: string): string {
  const v = cleanHeaderValue(value);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error(`adresse e-mail invalide : « ${value.slice(0, 80)} »`);
  return v;
}

export function encodeHeaderWord(value: string): string {
  const v = cleanHeaderValue(value);
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  return `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

function buildMessage(o: { from: string; to: string[]; cc: string[]; subject: string; text: string }): Buffer {
  const domain = o.from.includes("@") ? o.from.split("@")[1] : "smolcoder.local";
  const headers = [
    `From: ${o.from}`,
    `To: ${o.to.join(", ")}`,
    ...(o.cc.length ? [`Cc: ${o.cc.join(", ")}`] : []),
    `Subject: ${encodeHeaderWord(o.subject)}`,
    `Date: ${new Date().toUTCString().replace(/GMT$/, "+0000")}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
  ];
  const body = Buffer.from(o.text, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}\r\n`, "utf8");
}

class SmtpClient {
  private wire = new Wire();
  private sock: net.Socket | null = null;
  private capabilities = "";

  private async expect(deadline: number, okCodes: string[]): Promise<string> {
    const all: string[] = [];
    let last = await this.wire.line(deadline);
    all.push(last);
    while (/^\d{3}-/.test(last)) {
      last = await this.wire.line(deadline);
      all.push(last);
    }
    const code = last.slice(0, 3);
    if (!okCodes.includes(code)) {
      throw new Error(`SMTP ${code} : ${all.join(" ").slice(0, 300)}`);
    }
    return all.join("\n");
  }

  private async send(cmd: string, okCodes: string[]): Promise<string> {
    if (!this.sock) throw new Error("connexion SMTP absente");
    this.sock.write(`${cmd}\r\n`);
    return this.expect(Date.now() + COMMAND_TIMEOUT_MS, okCodes);
  }

  async connect(ep: MailEndpoint): Promise<void> {
    this.sock = await connectSocket(ep, Date.now() + CONNECT_TIMEOUT_MS);
    this.wire.attach(this.sock);
    await this.expect(Date.now() + COMMAND_TIMEOUT_MS, ["220"]);
    let ehlo = await this.send(`EHLO smolcoder`, ["250"]);
    if (!ep.secure && /\bSTARTTLS\b/i.test(ehlo)) {
      await this.send("STARTTLS", ["220"]);
      const upgraded = await upgradeToTls(this.sock, ep.host);
      this.wire.attach(upgraded);
      this.sock = upgraded;
      ehlo = await this.send("EHLO smolcoder", ["250"]);
    }
    this.capabilities = ehlo;
  }

  async auth(user: string, password: string): Promise<void> {
    if (!/\bAUTH\b/i.test(this.capabilities)) {
      throw new Error("le serveur n'annonce aucune authentification (vérifiez le port : 465 en TLS direct, ou 587 en STARTTLS)");
    }
    if (/\bPLAIN\b/i.test(this.capabilities)) {
      const token = Buffer.from(`\u0000${user}\u0000${password}`, "utf8").toString("base64");
      await this.send(`AUTH PLAIN ${token}`, ["235"]);
      return;
    }
    await this.send("AUTH LOGIN", ["334"]);
    await this.send(Buffer.from(user, "utf8").toString("base64"), ["334"]);
    await this.send(Buffer.from(password, "utf8").toString("base64"), ["235"]);
  }

  async sendMessage(from: string, to: string[], data: Buffer): Promise<void> {
    await this.send(`MAIL FROM:<${from}>`, ["250"]);
    for (const rcpt of to) await this.send(`RCPT TO:<${rcpt}>`, ["250", "251"]);
    await this.send("DATA", ["354"]);
    if (!this.sock) throw new Error("connexion SMTP absente");
    const stuffed = data.toString("utf8").replace(/^\./gm, "..");
    this.sock.write(stuffed);
    if (!stuffed.endsWith("\r\n")) this.sock.write("\r\n");
    this.sock.write(".\r\n");
    await this.expect(Date.now() + COMMAND_TIMEOUT_MS, ["250"]);
  }

  async quit(): Promise<void> {
    try {
      await this.send("QUIT", ["221"]);
    } catch {
      // sans conséquence
    }
    this.wire.destroy();
  }
}

// ---------------------------------------------------------------------------
// Opérations haut niveau (utilisées par le CLI et l'outil agent).
// ---------------------------------------------------------------------------

export function mailNotConfiguredMessage(): string {
  return "la boîte mail n'est pas configurée — lancez `smol mail setup` (votre mot de passe reste sur cet ordinateur).";
}

function requireMailConfig(): MailConfig {
  const cfg = mailConfig();
  if (!cfg) throw new Error(mailNotConfiguredMessage());
  return cfg;
}

async function withImap<T>(cfg: MailConfig, fn: (imap: ImapClient) => Promise<T>): Promise<T> {
  const imap = new ImapClient();
  try {
    await imap.connect(cfg.imap);
  } catch (e) {
    throw new Error(`IMAP ${cfg.imap.host}:${cfg.imap.port} injoignable — ${msgOf(e)}`);
  }
  try {
    await imap.login(cfg.user, cfg.password).catch((e) => {
      throw new Error(`identification IMAP refusée — ${msgOf(e)}`);
    });
    await imap.select("INBOX");
    return await fn(imap);
  } finally {
    await imap.logout();
  }
}

function summaryOf(uid: number, seen: boolean, headerRaw: string): MailSummary {
  const h = parseHeaders(headerRaw);
  return {
    uid,
    seen,
    from: decodeEncodedWords(h.from ?? "") || "(expéditeur inconnu)",
    subject: decodeEncodedWords(h.subject ?? "") || "(sans objet)",
    date: h.date ?? "",
  };
}

function shortDate(raw: string): string {
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return raw.slice(0, 40);
  return new Date(t).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
}

function shorten(value: string, max: number): string {
  const v = value.replace(/\s+/g, " ").trim();
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

export async function listInbox(limit = LIST_LIMIT_DEFAULT): Promise<MailSummary[]> {
  const cfg = requireMailConfig();
  const cap = Math.max(1, Math.min(LIST_LIMIT_MAX, Math.floor(limit) || LIST_LIMIT_DEFAULT));
  return withImap(cfg, async (imap) => {
    const uids = await imap.searchAll();
    const newest = uids.slice(-cap).reverse();
    if (!newest.length) return [];
    const { text, literals } = await imap.fetch(newest);
    const blocks = splitFetchBlocks(text);
    const byUid = new Map<number, { seen: boolean; header: string }>();
    blocks.forEach((block, i) => {
      const info = uidFlagsOf(block);
      if (info.uid) byUid.set(info.uid, { seen: info.seen, header: literals[i]?.data.toString("utf8") ?? "" });
    });
    return newest
      .filter((uid) => byUid.has(uid))
      .map((uid) => {
        const hit = byUid.get(uid) as { seen: boolean; header: string };
        return summaryOf(uid, hit.seen, hit.header);
      });
  });
}

export async function readMessage(uid: number): Promise<MailMessage> {
  const cfg = requireMailConfig();
  if (!Number.isFinite(uid) || uid <= 0) throw new Error(`numéro de message invalide : « ${uid} »`);
  return withImap(cfg, async (imap) => {
    const { text, literals } = await imap.fetch([uid]);
    if (!literals.length) throw new Error(`le message #${uid} n'existe pas dans la boîte de réception`);
    const headerRaw = literals[0].data.toString("utf8");
    const bodyRaw = literals[1]?.data ?? Buffer.alloc(0);
    const block = splitFetchBlocks(text)[0] ?? "";
    const info = uidFlagsOf(block);
    const base = summaryOf(info.uid || uid, info.seen, headerRaw);
    const h = parseHeaders(headerRaw);
    const extracted = extractPart(headerRaw, bodyRaw);
    const truncated = extracted.text.length > BODY_TEXT_CAP || (literals[1]?.truncated ?? false);
    return {
      ...base,
      to: decodeEncodedWords(h.to ?? ""),
      text: extracted.text.slice(0, BODY_TEXT_CAP),
      bodyTruncated: truncated,
    };
  });
}

export async function sendMailNow(req: SendRequest): Promise<string> {
  const cfg = requireMailConfig();
  const to = cleanAddress(req.to);
  const cc = (req.cc ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean)
    .map(cleanAddress);
  const subject = cleanHeaderValue(req.subject) || "(sans objet)";
  const text = req.text.replace(/\r?\n/g, "\r\n");
  const message = buildMessage({ from: cfg.address, to: [to], cc, subject, text });
  const client = new SmtpClient();
  try {
    await client.connect(cfg.smtp);
    await client.auth(cfg.user, cfg.password);
    await client.sendMessage(cfg.address, [to, ...cc], message);
  } catch (e) {
    const detail = msgOf(e);
    void client.quit();
    throw new Error(`SMTP ${cfg.smtp.host}:${cfg.smtp.port} — envoi refusé : ${detail}`);
  }
  await client.quit();
  return `E-mail envoyé à ${to}${cc.length ? ` (copie à ${cc.join(", ")})` : ""} — objet « ${subject} ».`;
}

export async function checkMail(cfg = mailConfig()): Promise<MailCheck> {
  if (!cfg) throw new Error(mailNotConfiguredMessage());
  let imapLine = "";
  let smtpLine = "";
  let ok = true;
  try {
    const count = await withImap(cfg, async (imap) => imap.select("INBOX"));
    imapLine = `IMAP ${cfg.imap.host} — connexion et identification réussies (${count} message(s) dans la boîte de réception).`;
  } catch (e) {
    ok = false;
    imapLine = `IMAP ${cfg.imap.host} — ${msgOf(e)}`;
  }
  try {
    const client = new SmtpClient();
    await client.connect(cfg.smtp);
    await client.auth(cfg.user, cfg.password);
    await client.quit();
    smtpLine = `SMTP ${cfg.smtp.host} — connexion et authentification réussies (aucun message envoyé).`;
  } catch (e) {
    ok = false;
    smtpLine = `SMTP ${cfg.smtp.host} — ${msgOf(e)}`;
  }
  return { ok, imap: imapLine, smtp: smtpLine };
}

export function formatMailList(items: MailSummary[]): string {
  if (!items.length) return "Boîte de réception : aucun message.";
  const lines = items.map(
    (m) =>
      `${m.seen ? "·" : "•"} #${m.uid}  ${shorten(m.subject, 70)}\n    de ${shorten(m.from, 60)} — ${shortDate(m.date)}`
  );
  return `${items.length} message(s) (les plus récents d'abord ; • = non lu) :\n${lines.join("\n")}`;
}

export function formatMailMessage(m: MailMessage): string {
  const parts = [`#${m.uid}  ${m.subject}`, `De : ${m.from}`];
  if (m.to) parts.push(`À : ${m.to}`);
  parts.push(`Date : ${shortDate(m.date)}`, "", m.text || "(corps vide)");
  if (m.bodyTruncated) parts.push("", "[corps tronqué à 20 000 caractères]");
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// CLI : smol mail setup | check | inbox [n] | read <uid> | send <to> <subject> <body>
// ---------------------------------------------------------------------------

function fail(message: string): void {
  console.error(`  ${message}`);
  process.exitCode = 1;
}

function mailUsage(): string {
  return [
    "Utilisation : smol mail <commande>",
    "  setup                  configurer la boîte (le mot de passe reste sur cet ordinateur)",
    "  check                  tester les connexions IMAP et SMTP (rien n'est envoyé)",
    "  inbox [n]              lister les n derniers messages (défaut 10)",
    "  read <uid>             afficher un message",
    "  send <dest> <objet> <texte>   envoyer un e-mail",
  ].join("\n");
}

async function mailSetupCli(): Promise<void> {
  console.log("Configuration de la boîte mail (tout reste sur cet ordinateur, rien n'est envoyé à un tiers).");
  console.log("Astuce : utilisez un mot de passe d'application (Gmail : Compte Google > Sécurité > Mots de passe des applications).");
  const prev = mailConfig();
  const address = (await askLine(`Adresse e-mail${prev ? ` [${prev.address}]` : ""} : `)) || prev?.address || "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    fail("adresse e-mail invalide.");
    return;
  }
  const domain = address.split("@")[1];
  const imapHost = (await askLine(`Serveur IMAP [imap.${domain}] : `)) || `imap.${domain}`;
  const imapPort = Number(await askLine("Port IMAP [993] : ")) || 993;
  const smtpHost = (await askLine(`Serveur SMTP [smtp.${domain}] : `)) || `smtp.${domain}`;
  const smtpPort = Number(await askLine("Port SMTP [465 ; 587 = STARTTLS] : ")) || 465;
  const user = (await askLine(`Identifiant${prev ? ` [${prev.user}]` : ` [${address}]`} : `)) || prev?.user || address;
  const password = await askHidden("Mot de passe (saisie masquée) : ");
  if (!password) {
    fail("mot de passe vide — configuration annulée.");
    return;
  }
  const cfg: MailConfig = {
    address,
    user,
    password,
    imap: { host: imapHost, port: imapPort, secure: imapPort !== 143 },
    smtp: { host: smtpHost, port: smtpPort, secure: smtpPort !== 587 },
  };
  updateConnectors({ mail: cfg });
  console.log(`Configuration enregistrée dans ${"~/.smolcoder/connectors.json"}.`);
  console.log("Test réel des connexions (aucun message n'est envoyé)…");
  const report = await checkMail(cfg);
  console.log(`  ${report.imap}`);
  console.log(`  ${report.smtp}`);
  if (!report.ok) {
    console.log("Certaines connexions ont échoué — corrigez avec `smol mail setup`, ou retestez avec `smol mail check`.");
    process.exitCode = 1;
  } else {
    console.log("Boîte mail prête.");
  }
}

export async function runMailCli(argv: string[]): Promise<void> {
  const sub = (argv[0] ?? "").trim().toLowerCase();
  const rest = argv.slice(1);
  try {
    if (sub === "setup") {
      await mailSetupCli();
      return;
    }
    if (sub === "check") {
      const report = await checkMail();
      console.log(report.imap);
      console.log(report.smtp);
      if (!report.ok) process.exitCode = 1;
      return;
    }
    if (sub === "inbox") {
      const limit = Number(rest[0]) || LIST_LIMIT_DEFAULT;
      console.log(formatMailList(await listInbox(limit)));
      return;
    }
    if (sub === "read") {
      const uid = Number(rest[0]);
      if (!Number.isFinite(uid) || uid <= 0) {
        fail("numéro de message requis — exemple : smol mail read 42");
        return;
      }
      console.log(formatMailMessage(await readMessage(uid)));
      return;
    }
    if (sub === "send") {
      const [to, subject, ...bodyParts] = rest;
      const body = bodyParts.join(" ").trim();
      if (!to || !subject || !body) {
        fail("trois arguments requis — exemple : smol mail send a@b.fr « Rapport » « Bonjour, voici… »");
        return;
      }
      console.log(await sendMailNow({ to, subject, text: body }));
      return;
    }
    console.error(mailUsage());
    process.exitCode = 1;
  } catch (e) {
    fail(msgOf(e));
  }
}

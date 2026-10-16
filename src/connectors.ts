// Configuration locale des connecteurs (mail, agenda) : un seul fichier
// ~/.smolcoder/connectors.json, hors de tout dépôt. Les mots de passe ne
// quittent jamais cet ordinateur et ne sont affichés nulle part.
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { DATA_DIR } from "./config";

export interface MailEndpoint {
  host: string;
  port: number;
  secure: boolean;
}

export interface MailConfig {
  address: string;
  user: string;
  password: string;
  imap: MailEndpoint;
  smtp: MailEndpoint;
}

export interface CalendarConfig {
  url: string;
  user: string;
  password: string;
}

export interface ConnectorConfig {
  mail?: MailConfig;
  calendar?: CalendarConfig;
}

/** Lu par appel (les tests pointent SMOLCODER_DATA_DIR vers un dossier scratch). */
export function dataDir(): string {
  return process.env.SMOLCODER_DATA_DIR || DATA_DIR;
}

export function connectorsFilePath(): string {
  return path.join(dataDir(), "connectors.json");
}

export function readConnectors(): ConnectorConfig {
  try {
    const raw = fs.readFileSync(connectorsFilePath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as ConnectorConfig) : {};
  } catch {
    return {};
  }
}

export function writeConnectors(cfg: ConnectorConfig): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(connectorsFilePath(), `${JSON.stringify(cfg, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function updateConnectors(patch: ConnectorConfig): ConnectorConfig {
  const cfg = { ...readConnectors(), ...patch };
  writeConnectors(cfg);
  return cfg;
}

function endpointOf(value: unknown, defaultPort: number): MailEndpoint | null {
  if (!value || typeof value !== "object") return null;
  const e = value as Partial<MailEndpoint>;
  if (typeof e.host !== "string" || !e.host.trim()) return null;
  const port = Number.isFinite(e.port) && (e.port as number) > 0 ? (e.port as number) : defaultPort;
  return { host: e.host.trim(), port, secure: e.secure !== false };
}

/** Configuration mail utilisable, champs normalisés, ou null si absente/incomplète. */
export function mailConfig(): MailConfig | null {
  const m = readConnectors().mail;
  if (!m) return null;
  if (typeof m.address !== "string" || !m.address.trim()) return null;
  if (typeof m.user !== "string" || !m.user) return null;
  if (typeof m.password !== "string" || !m.password) return null;
  const imap = endpointOf(m.imap, 993);
  const smtp = endpointOf(m.smtp, 465);
  if (!imap || !smtp) return null;
  return { address: m.address.trim(), user: m.user, password: m.password, imap, smtp };
}

export function calendarConfig(): CalendarConfig | null {
  const c = readConnectors().calendar;
  if (!c) return null;
  if (typeof c.url !== "string" || !/^https?:\/\//i.test(c.url.trim())) return null;
  if (typeof c.user !== "string" || !c.user) return null;
  if (typeof c.password !== "string" || !c.password) return null;
  return { url: c.url.trim(), user: c.user, password: c.password };
}

/** Question simple sur l'entrée standard (réponse nettoyée). */
export async function askLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    return answer.trim();
  } finally {
    rl.close();
  }
}

/** Saisie masquée (étoiles). Replie honnêtement sur une saisie visible hors terminal. */
export async function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    console.log("  (saisie masquée indisponible ici — la saisie restera visible)");
    return askLine(question);
  }
  process.stdout.write(question);
  return new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw === true;
    stdin.setRawMode(true);
    stdin.resume();
    let value = "";
    const cleanup = () => {
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.off("data", onData);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Saisie interrompue (Ctrl+C)."));
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        if (ch >= " ") {
          value += ch;
          process.stdout.write("*");
        }
      }
    };
    stdin.on("data", onData);
  });
}

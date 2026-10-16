// Client agenda réel — CalDAV (fetch natif) + ICS écrit à la main.
// Aucune dépendance externe : le rapport d'analyse reste 100 % local.
import { randomUUID } from "node:crypto";
import { askHidden, askLine, type CalendarConfig, calendarConfig, updateConnectors } from "./connectors";

const REQUEST_TIMEOUT_MS = 20_000;
const LIST_DEFAULT_DAYS = 7;
const LIST_MAX_DAYS = 90;
const LIST_MAX_EVENTS = 100;
const RESPONSE_CAP = 2_000_000;

export interface CalendarEvent {
  uid: string;
  summary: string;
  start: string;
  end: string;
  startMs: number;
  allDay: boolean;
  location?: string;
}

export interface CalendarInfo {
  url: string;
  name: string;
  supportsEvents: boolean;
}

export interface NewEventRequest {
  summary: string;
  start: string;
  end?: string;
  location?: string;
  description?: string;
}

function msgOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function notConfiguredMessage(): string {
  return "l'agenda n'est pas configuré — lancez `smol calendar setup` (votre mot de passe reste sur cet ordinateur).";
}

function requireCalendarConfig(): CalendarConfig {
  const cfg = calendarConfig();
  if (!cfg) throw new Error(notConfiguredMessage());
  return cfg;
}

// ---------------------------------------------------------------------------
// ICS : lecture et écriture (RFC 5545, sous-ensemble raisonnable).
// ---------------------------------------------------------------------------

function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function unfoldIcs(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(raw) && lines.length > 0) {
      lines[lines.length - 1] += raw.slice(1);
    } else {
      lines.push(raw);
    }
  }
  return lines;
}

/** "20261016T090000Z" → epoch ; "20261016T090000" → heure locale ; "20261016" → minuit local. */
export function icsParseDate(value: string): number | null {
  const v = value.trim();
  let m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i.exec(v);
  if (m) {
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(v);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
  }
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  }
  return null;
}

function icsProp(lines: string[], name: string): { value: string; params: string } | null {
  const prefix = `${name.toUpperCase()}`;
  for (const line of lines) {
    const m = /^([A-Za-z-]+)((?:;[^:]*)?):([\s\S]*)$/.exec(line);
    if (!m) continue;
    if (m[1].toUpperCase() === prefix) return { value: m[3], params: m[2] ?? "" };
  }
  return null;
}

export interface ParsedIcsEvent {
  uid: string;
  summary: string;
  startMs: number | null;
  endMs: number | null;
  allDay: boolean;
  location?: string;
  description?: string;
}

export function icsParseEvents(text: string): ParsedIcsEvent[] {
  const lines = unfoldIcs(text);
  const events: ParsedIcsEvent[] = [];
  let inEvent = false;
  let current: string[] = [];
  for (const line of lines) {
    if (/^BEGIN:VEVENT$/i.test(line)) {
      inEvent = true;
      current = [];
      continue;
    }
    if (/^END:VEVENT$/i.test(line)) {
      inEvent = false;
      const start = icsProp(current, "DTSTART");
      const end = icsProp(current, "DTEND");
      const summary = icsProp(current, "SUMMARY");
      const uid = icsProp(current, "UID");
      const location = icsProp(current, "LOCATION");
      const description = icsProp(current, "DESCRIPTION");
      const allDay = start ? /VALUE=DATE/i.test(start.params) || /^\d{8}$/.test(start.value.trim()) : false;
      events.push({
        uid: uid ? uid.value.trim() : "",
        summary: summary ? unescapeIcsText(summary.value) : "(sans titre)",
        startMs: start ? icsParseDate(start.value) : null,
        endMs: end ? icsParseDate(end.value) : null,
        allDay,
        location: location ? unescapeIcsText(location.value) : undefined,
        description: description ? unescapeIcsText(description.value) : undefined,
      });
      continue;
    }
    if (inEvent) current.push(line);
  }
  return events;
}

function toUtcStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function toDateStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function foldLine(line: string): string[] {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest, "utf8") > 73) {
    let cut = 73;
    while (cut > 1 && Buffer.byteLength(rest.slice(0, cut), "utf8") > 73) cut -= 1;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out;
}

export function icsBuildEvent(o: {
  uid: string;
  summary: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  location?: string;
  description?: string;
}): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Smolcoder//Agenda//FR",
    "BEGIN:VEVENT",
    `UID:${o.uid}`,
    `DTSTAMP:${toUtcStamp(Date.now())}`,
  ];
  if (o.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${toDateStamp(o.startMs)}`);
    lines.push(`DTEND;VALUE=DATE:${toDateStamp(o.endMs)}`);
  } else {
    lines.push(`DTSTART:${toUtcStamp(o.startMs)}`);
    lines.push(`DTEND:${toUtcStamp(o.endMs)}`);
  }
  lines.push(`SUMMARY:${escapeIcsText(o.summary)}`);
  if (o.location) lines.push(`LOCATION:${escapeIcsText(o.location)}`);
  if (o.description) lines.push(`DESCRIPTION:${escapeIcsText(o.description)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return `${lines.flatMap(foldLine).join("\r\n")}\r\n`;
}

/** Saisie utilisateur : "2026-10-16", "2026-10-16 09:00", "2026-10-16T09:00", ISO complet. */
export function parseLocalInput(value: string): { ms: number; allDay: boolean } | null {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, mo, d] = v.split("-").map(Number);
    const ms = new Date(y, mo - 1, d).getTime();
    return Number.isFinite(ms) ? { ms, allDay: true } : null;
  }
  const normalized = v.includes("T") ? v : v.replace(" ", "T");
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) return null;
  return { ms: parsed.getTime(), allDay: false };
}

function formatEventTime(ms: number, allDay: boolean): string {
  const d = new Date(ms);
  if (allDay) {
    return d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  }
  return d.toLocaleString("fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// CalDAV : découverte + listing + création, via fetch natif.
// ---------------------------------------------------------------------------

interface DavOptions {
  depth?: number;
  contentType?: string;
  ifNoneMatch?: string;
}

async function davFetch(
  cfg: CalendarConfig,
  url: string,
  method: string,
  body?: string,
  opts: DavOptions = {}
): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.password}`, "utf8").toString("base64")}`,
        "Content-Type": opts.contentType ?? "application/xml; charset=utf-8",
        ...(opts.depth !== undefined ? { Depth: String(opts.depth) } : {}),
        ...(opts.ifNoneMatch ? { "If-None-Match": opts.ifNoneMatch } : {}),
      },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    return { status: res.status, text: text.slice(0, RESPONSE_CAP) };
  } finally {
    clearTimeout(timer);
  }
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, "&");
}

function xmlHrefs(xml: string): string[] {
  const out: string[] = [];
  const re = /<(?:[A-Za-z0-9]+:)?href[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?href>/gi;
  for (let m = re.exec(xml); m !== null; m = re.exec(xml)) out.push(xmlUnescape(m[1]).trim());
  return out;
}

function splitDavResponses(xml: string): string[] {
  return xml.split(/(?=<(?:[A-Za-z0-9]+:)?response[\s>])/i).filter((b) => /<(?:[A-Za-z0-9]+:)?response[\s>]/i.test(b));
}

function absoluteHref(base: string, href: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

async function propfindHref(cfg: CalendarConfig, url: string, prop: string): Promise<string | null> {
  const body = `<?xml version="1.0" encoding="utf-8"?>\n<d:propfind xmlns:d="DAV:"><d:prop>${prop}</d:prop></d:propfind>`;
  const res = await davFetch(cfg, url, "PROPFIND", body, { depth: 0 });
  if (res.status !== 207) throw new Error(`CalDAV ${url} — PROPFIND a répondu ${res.status} (identifiants ou URL ?)`);
  const hrefs = xmlHrefs(res.text);
  return hrefs.length > 0 ? absoluteHref(url, hrefs[hrefs.length - 1]) : null;
}

export async function discoverCalendars(cfg: CalendarConfig): Promise<CalendarInfo[]> {
  const principal =
    (await propfindHref(cfg, cfg.url, "<d:current-user-principal/>")) ?? cfg.url;
  const home =
    (await propfindHref(cfg, principal, "<d:calendar-home-set/>")) ?? principal;
  const body =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop>' +
    "<d:resourcetype/><d:displayname/><c:supported-calendar-component-set/>" +
    "</d:prop></d:propfind>";
  const res = await davFetch(cfg, home, "PROPFIND", body, { depth: 1 });
  if (res.status !== 207) throw new Error(`CalDAV ${home} — PROPFIND a répondu ${res.status}`);
  const calendars: CalendarInfo[] = [];
  for (const block of splitDavResponses(res.text)) {
    if (!/<(?:[A-Za-z0-9]+:)?calendar[\s/>]/i.test(block)) continue;
    const href = xmlHrefs(block)[0];
    if (!href) continue;
    const nameMatch = /<(?:[A-Za-z0-9]+:)?displayname[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?displayname>/i.exec(block);
    const supportsEvents = /VEVENT/i.test(block) || !/supported-calendar-component-set/i.test(block);
    calendars.push({
      url: absoluteHref(home, href),
      name: nameMatch ? xmlUnescape(nameMatch[1]).trim() || "Agenda" : "Agenda",
      supportsEvents,
    });
  }
  if (calendars.length === 0) throw new Error("aucun agenda trouvé sur ce serveur CalDAV (vérifiez l'URL de base)");
  return calendars;
}

function pickEventCalendar(calendars: CalendarInfo[]): CalendarInfo {
  return calendars.find((c) => c.supportsEvents) ?? calendars[0];
}

function toCalendarEvent(parsed: ParsedIcsEvent): CalendarEvent | null {
  if (parsed.startMs === null) return null;
  return {
    uid: parsed.uid,
    summary: parsed.summary,
    start: formatEventTime(parsed.startMs, parsed.allDay),
    end: parsed.endMs !== null ? formatEventTime(parsed.endMs, parsed.allDay) : "",
    startMs: parsed.startMs,
    allDay: parsed.allDay,
    location: parsed.location,
  };
}

export async function listEvents(days = LIST_DEFAULT_DAYS): Promise<CalendarEvent[]> {
  const cfg = requireCalendarConfig();
  const span = Math.max(1, Math.min(LIST_MAX_DAYS, Math.floor(days) || LIST_DEFAULT_DAYS));
  const calendars = await discoverCalendars(cfg);
  const calendar = pickEventCalendar(calendars);
  const start = new Date(Date.now() - 86_400_000);
  const end = new Date(Date.now() + span * 86_400_000);
  const body =
    '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
    "<d:prop><d:getetag/><c:calendar-data/></d:prop>" +
    '<c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT">' +
    `<c:time-range start="${toUtcStamp(start.getTime())}" end="${toUtcStamp(end.getTime())}"/>` +
    "</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>";
  const res = await davFetch(cfg, calendar.url, "REPORT", body, { depth: 1 });
  if (res.status !== 207) throw new Error(`agenda « ${calendar.name} » — REPORT a répondu ${res.status}`);
  const events: CalendarEvent[] = [];
  for (const block of splitDavResponses(res.text)) {
    const data = /<(?:[A-Za-z0-9]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9]+:)?calendar-data>/i.exec(block);
    if (!data) continue;
    for (const parsed of icsParseEvents(xmlUnescape(data[1]))) {
      const event = toCalendarEvent(parsed);
      if (event) events.push(event);
    }
  }
  events.sort((a, b) => a.startMs - b.startMs);
  return events.slice(0, LIST_MAX_EVENTS);
}

export async function createEvent(req: NewEventRequest): Promise<string> {
  const cfg = requireCalendarConfig();
  const summary = req.summary.replace(/[\r\n]+/g, " ").trim();
  if (!summary) throw new Error("titre d'événement vide.");
  const start = parseLocalInput(req.start);
  if (!start) {
    throw new Error(`date de début invalide : « ${req.start} » — formats acceptés : 2026-10-16 ou 2026-10-16 09:00`);
  }
  let end = req.end ? parseLocalInput(req.end) : null;
  if (req.end && !end) {
    throw new Error(`date de fin invalide : « ${req.end} » — formats acceptés : 2026-10-16 ou 2026-10-16 10:30`);
  }
  const allDay = start.allDay && (end === null || end.allDay);
  if (end === null) {
    end = { ms: start.ms + (allDay ? 86_400_000 : 3_600_000), allDay };
  }
  if (end.ms <= start.ms) throw new Error("la fin doit être après le début.");
  const calendars = await discoverCalendars(cfg);
  const calendar = pickEventCalendar(calendars);
  const uid = `${randomUUID()}@smolcoder`;
  const ics = icsBuildEvent({
    uid,
    summary,
    startMs: start.ms,
    endMs: end.ms,
    allDay,
    location: req.location,
    description: req.description,
  });
  const base = calendar.url.endsWith("/") ? calendar.url : `${calendar.url}/`;
  const target = `${base}${uid}.ics`;
  const res = await davFetch(cfg, target, "PUT", ics, {
    contentType: "text/calendar; charset=utf-8",
    ifNoneMatch: "*",
  });
  if (res.status !== 201 && res.status !== 204 && res.status !== 200) {
    throw new Error(`création refusée par le serveur (${res.status}) — ${res.text.slice(0, 180)}`);
  }
  const when = `${formatEventTime(start.ms, allDay)}${end ? ` → ${formatEventTime(end.ms, allDay)}` : ""}`;
  return `Événement créé : « ${summary} » — ${when} (agenda « ${calendar.name} »).`;
}

export interface CalendarCheck {
  ok: boolean;
  line: string;
  calendars: CalendarInfo[];
}

export async function checkCalendar(cfg = calendarConfig()): Promise<CalendarCheck> {
  if (!cfg) throw new Error(notConfiguredMessage());
  try {
    const calendars = await discoverCalendars(cfg);
    const names = calendars.map((c) => c.name).join(", ");
    return {
      ok: true,
      line: `CalDAV ${cfg.url} — connexion réussie. Agendas : ${names}.`,
      calendars,
    };
  } catch (e) {
    return { ok: false, line: `CalDAV ${cfg.url} — ${msgOf(e)}`, calendars: [] };
  }
}

export function formatEventList(events: CalendarEvent[]): string {
  if (!events.length) return "Aucun événement sur cette période.";
  const lines = events.map((e) => {
    const loc = e.location ? ` — ${e.location}` : "";
    return `• ${e.start}${e.end && e.end !== e.start ? ` → ${e.end}` : ""}  ${e.summary}${loc}`;
  });
  return `${events.length} événement(s) :\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// CLI : smol calendar setup | check | list [jours] | add <titre> <début> <fin> [lieu]
// ---------------------------------------------------------------------------

function fail(message: string): void {
  console.error(`  ${message}`);
  process.exitCode = 1;
}

function calendarUsage(): string {
  return [
    "Utilisation : smol calendar <commande>",
    "  setup                          configurer l'agenda CalDAV (le mot de passe reste sur cet ordinateur)",
    "  check                          tester la connexion et lister les agendas",
    "  list [jours]                   prochains événements (défaut 7 jours)",
    "  add <titre> <début> <fin> [lieu]   créer un événement (dates : 2026-10-16 ou « 2026-10-16 09:00 »)",
  ].join("\n");
}

async function calendarSetupCli(): Promise<void> {
  console.log("Configuration de l'agenda CalDAV (tout reste sur cet ordinateur).");
  console.log("Exemples d'URL : Nextcloud https://cloud.exemple.fr/remote.php/dav/ · Fastmail https://caldav.fastmail.com/");
  const prev = calendarConfig();
  const url = (await askLine(`URL CalDAV${prev ? ` [${prev.url}]` : ""} : `)) || prev?.url || "";
  if (!/^https?:\/\//i.test(url)) {
    fail("URL invalide — elle doit commencer par http:// ou https://.");
    return;
  }
  const user = (await askLine(`Identifiant${prev ? ` [${prev.user}]` : ""} : `)) || prev?.user || "";
  if (!user) {
    fail("identifiant vide — configuration annulée.");
    return;
  }
  const password = await askHidden("Mot de passe (saisie masquée) : ");
  if (!password) {
    fail("mot de passe vide — configuration annulée.");
    return;
  }
  const cfg: CalendarConfig = { url, user, password };
  updateConnectors({ calendar: cfg });
  console.log("Configuration enregistrée dans ~/.smolcoder/connectors.json.");
  console.log("Test réel de la connexion…");
  const report = await checkCalendar(cfg);
  console.log(`  ${report.line}`);
  if (!report.ok) {
    process.exitCode = 1;
    console.log("Connexion impossible — corrigez avec `smol calendar setup`, ou retestez avec `smol calendar check`.");
  } else {
    console.log("Agenda prêt.");
  }
}

export async function runCalendarCli(argv: string[]): Promise<void> {
  const sub = (argv[0] ?? "").trim().toLowerCase();
  const rest = argv.slice(1);
  try {
    if (sub === "setup") {
      await calendarSetupCli();
      return;
    }
    if (sub === "check") {
      const report = await checkCalendar();
      console.log(report.line);
      if (!report.ok) process.exitCode = 1;
      return;
    }
    if (sub === "list") {
      const days = Number(rest[0]) || LIST_DEFAULT_DAYS;
      console.log(formatEventList(await listEvents(days)));
      return;
    }
    if (sub === "add") {
      const [summary, start, end, ...locationParts] = rest;
      if (!summary || !start) {
        fail("arguments requis — exemple : smol calendar add « Réunion équipe » « 2026-10-16 09:00 » « 2026-10-16 10:00 »");
        return;
      }
      console.log(
        await createEvent({
          summary,
          start,
          end: end || undefined,
          location: locationParts.join(" ").trim() || undefined,
        })
      );
      return;
    }
    console.error(calendarUsage());
    process.exitCode = 1;
  } catch (e) {
    fail(msgOf(e));
  }
}


// Tests du VRAI client agenda (dist/calendar.js) contre un serveur CalDAV
// scripté en HTTP local : découverte, listing REPORT, création PUT — et les
// codecs ICS internes (aller-retour, saisies utilisateur).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const BASE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "smol-cal-"));
process.env.SMOLCODER_DATA_DIR = BASE_DATA;

const calendar = require("../dist/calendar");
const { writeConnectors } = require("../dist/connectors");
const { runCalendar } = require("../dist/tools/calendar");

function isolatedData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-cal-case-"));
  process.env.SMOLCODER_DATA_DIR = dir;
  t.after(() => {
    process.env.SMOLCODER_DATA_DIR = BASE_DATA;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function xmlEscape(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function caldavServer(state) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      state.requests.push({ method: req.method, url: req.url, body, headers: req.headers });
      const send = (status, xml) => {
        res.writeHead(status, { "Content-Type": "application/xml; charset=utf-8" });
        res.end(xml);
      };
      if (req.method === "PROPFIND" && body.includes("current-user-principal")) {
        return send(
          207,
          '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/caldav/</d:href><d:propstat><d:prop>' +
            "<d:current-user-principal><d:href>/principals/me/</d:href></d:current-user-principal>" +
            "</d:prop></d:propstat></d:response></d:multistatus>"
        );
      }
      if (req.method === "PROPFIND" && body.includes("calendar-home-set")) {
        return send(
          207,
          '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/principals/me/</d:href><d:propstat><d:prop>' +
            "<c:calendar-home-set xmlns:c=\"urn:ietf:params:xml:ns:caldav\"><d:href>/calendars/me/</d:href></c:calendar-home-set>" +
            "</d:prop></d:propstat></d:response></d:multistatus>"
        );
      }
      if (req.method === "PROPFIND" && body.includes("resourcetype")) {
        return send(
          207,
          '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
            "<d:response><d:href>/calendars/me/agenda/</d:href><d:propstat><d:prop>" +
            "<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>" +
            "<d:displayname>Agenda perso</d:displayname>" +
            "<c:supported-calendar-component-set><c:comp name=\"VEVENT\"/></c:supported-calendar-component-set>" +
            "</d:prop></d:propstat></d:response></d:multistatus>"
        );
      }
      if (req.method === "REPORT") {
        const ics =
          "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:evt-1@test\r\n" +
          "DTSTART:20261016T090000Z\r\nDTEND:20261016T100000Z\r\n" +
          "SUMMARY:Réunion équipe\r\nLOCATION:Bureau\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        return send(
          207,
          '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
            "<d:response><d:href>/calendars/me/agenda/evt-1.ics</d:href><d:propstat><d:prop>" +
            `<c:calendar-data>${xmlEscape(ics)}</c:calendar-data>` +
            "</d:prop></d:propstat></d:response></d:multistatus>"
        );
      }
      if (req.method === "PUT") {
        state.put = { url: req.url, body, headers: req.headers };
        res.writeHead(201, { "Content-Type": "text/calendar; charset=utf-8" });
        res.end();
        return;
      }
      send(404, "<html>inattendu</html>");
    });
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function configureCalendar(port) {
  writeConnectors({ calendar: { url: `http://127.0.0.1:${port}/caldav/`, user: "moi", password: "secret-cal" } });
}

test("codecs ICS : aller-retour, saisies utilisateur, journée entière", () => {
  const built = calendar.icsBuildEvent({
    uid: "u1@test",
    summary: "Déjeuner; équipe, élargie",
    startMs: new Date(2026, 9, 20, 12, 0).getTime(),
    endMs: new Date(2026, 9, 20, 13, 0).getTime(),
    allDay: false,
    location: "Bureau",
  });
  const roundTrip = calendar.icsParseEvents(built);
  assert.equal(roundTrip.length, 1);
  assert.equal(roundTrip[0].summary, "Déjeuner; équipe, élargie");
  assert.equal(roundTrip[0].startMs, new Date(2026, 9, 20, 12, 0).getTime());
  assert.equal(roundTrip[0].location, "Bureau");

  const allDay = calendar.parseLocalInput("2026-10-16");
  assert.deepEqual(allDay, { ms: new Date(2026, 9, 16).getTime(), allDay: true });
  const timed = calendar.parseLocalInput("2026-10-16 09:30");
  assert.deepEqual(timed, { ms: new Date(2026, 9, 16, 9, 30).getTime(), allDay: false });
  assert.equal(calendar.parseLocalInput("pas une date"), null);
});

test("listEvents : découverte CalDAV puis REPORT, événement réel affiché", async (t) => {
  isolatedData(t);
  const state = { requests: [] };
  const server = caldavServer(state);
  t.after(() => server.close());
  configureCalendar(await listen(server));

  const events = await calendar.listEvents(7);
  assert.equal(events.length, 1);
  assert.equal(events[0].summary, "Réunion équipe");
  assert.equal(events[0].startMs, Date.UTC(2026, 9, 16, 9, 0));
  assert.equal(events[0].location, "Bureau");
  assert.ok(state.requests.some((r) => r.method === "REPORT"));
  const auth = state.requests[0].headers.authorization;
  assert.equal(auth, `Basic ${Buffer.from("moi:secret-cal", "utf8").toString("base64")}`);
});

test("createEvent : PUT réel dans l'agenda, ICS complet envoyé", async (t) => {
  isolatedData(t);
  const state = { requests: [] };
  const server = caldavServer(state);
  t.after(() => server.close());
  configureCalendar(await listen(server));

  const startMs = new Date(2026, 9, 20, 12, 0).getTime();
  const expectedStamp = new Date(startMs).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const result = await calendar.createEvent({ summary: "Déjeuner", start: "2026-10-20 12:00", end: "2026-10-20 13:00" });
  assert.ok(result.includes("Déjeuner"), result);
  assert.ok(result.includes("Agenda perso"), result);
  assert.ok(state.put, "PUT attendu");
  assert.match(state.put.url, /\.ics$/);
  assert.equal(state.put.headers["if-none-match"], "*");
  assert.ok(state.put.body.includes("SUMMARY:Déjeuner"));
  assert.ok(state.put.body.includes(`DTSTART:${expectedStamp}`), state.put.body);
  assert.ok(state.put.body.includes("BEGIN:VCALENDAR"));
});

test("honnêteté : agenda non configuré, erreurs de saisie", async (t) => {
  isolatedData(t);
  const message = await runCalendar({ action: "list" });
  assert.ok(message.includes("n'est pas configuré"), message);
  assert.ok(!message.startsWith("Error"));
  configureCalendar("http://127.0.0.1:9/");
  await assert.rejects(() => calendar.createEvent({ summary: "x", start: "pas une date" }), /date de début invalide/);
});

test("CLI : check sans configuration → exit 1 et conseil setup ; commande inconnue → exit 1", (t) => {
  const dir = isolatedData(t);
  const run = (args) =>
    spawnSync(process.execPath, [path.join(ROOT, "dist", "index.js"), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, SMOLCODER_DATA_DIR: dir },
    });
  const check = run(["calendar", "check"]);
  assert.equal(check.status, 1);
  assert.ok(`${check.stdout}${check.stderr}`.includes("smol calendar setup"), check.stdout + check.stderr);
  const unknown = run(["calendar", "wat"]);
  assert.equal(unknown.status, 1);
  assert.ok(`${unknown.stdout}${unknown.stderr}`.includes("smol calendar"), unknown.stdout + unknown.stderr);
});

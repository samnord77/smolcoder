const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseCadence, describeCadence, computeNext, RoutineBook } = require("../dist/routines");
const { Session } = require("../dist/session");

test("parseCadence accepts English cadences", () => {
  assert.equal(parseCadence("every 30m"), "every 30m");
  assert.equal(parseCadence("every 2 hours"), "every 2h");
  assert.equal(parseCadence("hourly"), "hourly");
  assert.equal(parseCadence("every day at 09:00"), "daily 09:00");
  assert.equal(parseCadence("daily"), "daily 09:00");
  assert.equal(parseCadence("weekdays at 08:30"), "weekdays 08:30");
  assert.equal(parseCadence("every monday at 10:00"), "weekly mon 10:00");
});

test("parseCadence accepts French cadences", () => {
  assert.equal(parseCadence("toutes les 30 minutes"), "every 30m");
  assert.equal(parseCadence("toutes les 2 heures"), "every 2h");
  assert.equal(parseCadence("chaque heure"), "hourly");
  assert.equal(parseCadence("tous les jours à 09:00"), "daily 09:00");
  assert.equal(parseCadence("en semaine à 08:00"), "weekdays 08:00");
  assert.equal(parseCadence("chaque lundi à 10:00"), "weekly mon 10:00");
  assert.equal(parseCadence("tous les mardis"), "weekly tue 09:00");
});

test("parseCadence refuses nonsense and out-of-range values", () => {
  for (const bad of [
    "",
    "   ",
    "every 0m",
    "every 2000m",
    "every 400h",
    "daily 25:00",
    "daily 09:70",
    "toutes les bananes",
    "every blue moon",
  ]) {
    assert.equal(parseCadence(bad), null, JSON.stringify(bad));
  }
});

test("describeCadence speaks French", () => {
  assert.equal(describeCadence("every 30m"), "toutes les 30 min");
  assert.equal(describeCadence("every 2h"), "toutes les 2 h");
  assert.equal(describeCadence("hourly"), "chaque heure");
  assert.equal(describeCadence("daily 09:00"), "chaque jour à 09:00");
  assert.equal(describeCadence("weekdays 08:30"), "en semaine à 08:30");
  assert.equal(describeCadence("weekly mon 10:00"), "chaque lundi à 10:00");
});

test("computeNext: intervals and hourly", () => {
  const t = new Date(2026, 9, 15, 8, 0, 0, 0).getTime();
  assert.equal(computeNext("every 30m", t), t + 30 * 60_000);
  assert.equal(computeNext("every 2h", t), t + 2 * 3_600_000);
  const from = new Date(2026, 9, 15, 10, 37, 0, 0).getTime();
  const top = new Date(2026, 9, 15, 11, 0, 0, 0).getTime();
  assert.equal(computeNext("hourly", from), top);
});

test("computeNext: daily is strictly after the reference instant", () => {
  const before = new Date(2026, 9, 15, 8, 0, 0, 0).getTime();
  assert.equal(computeNext("daily 09:00", before), new Date(2026, 9, 15, 9, 0, 0, 0).getTime());
  const exact = new Date(2026, 9, 15, 9, 0, 0, 0).getTime();
  assert.equal(computeNext("daily 09:00", exact), new Date(2026, 9, 16, 9, 0, 0, 0).getTime());
  const after = new Date(2026, 9, 15, 10, 0, 0, 0).getTime();
  assert.equal(computeNext("daily 09:00", after), new Date(2026, 9, 16, 9, 0, 0, 0).getTime());
});

test("computeNext: weekdays skip the weekend", () => {
  // 2026-10-16 is a Friday, 2026-10-19 the next Monday.
  const fridayAfter = new Date(2026, 9, 16, 15, 0, 0, 0).getTime();
  assert.equal(computeNext("weekdays 08:30", fridayAfter), new Date(2026, 9, 19, 8, 30, 0, 0).getTime());
  const saturday = new Date(2026, 9, 17, 10, 0, 0, 0).getTime();
  assert.equal(computeNext("weekdays 08:30", saturday), new Date(2026, 9, 19, 8, 30, 0, 0).getTime());
});

test("computeNext: weekly lands on the right day", () => {
  const thursday = new Date(2026, 9, 15, 12, 0, 0, 0).getTime();
  assert.equal(computeNext("weekly mon 10:00", thursday), new Date(2026, 9, 19, 10, 0, 0, 0).getTime());
  const mondayMorning = new Date(2026, 9, 19, 8, 0, 0, 0).getTime();
  assert.equal(computeNext("weekly mon 10:00", mondayMorning), new Date(2026, 9, 19, 10, 0, 0, 0).getTime());
});

function makeBook() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "smol-routines-"));
  return new RoutineBook(ws);
}

test("RoutineBook: add, list, resolve by number and id prefix", async () => {
  const book = makeBook();
  const first = await book.add("every 30m", "verifie le build");
  assert.equal(first.ok, true);
  const second = await book.add("chaque lundi à 10:00", "resume la semaine");
  assert.equal(second.ok, true);
  const items = book.listSorted();
  assert.equal(items.length, 2);
  assert.equal(items[0].id, first.routine.id);
  assert.equal(book.resolve("1").id, first.routine.id);
  assert.equal(book.resolve("2").id, second.routine.id);
  assert.equal(book.resolve(first.routine.id.slice(0, 12)).id, first.routine.id);
  assert.equal(book.resolve("nope"), null);
});

test("RoutineBook: persistence across instances", async () => {
  const book = makeBook();
  await book.add("daily 09:00", "lis les issues");
  const again = new RoutineBook(book.workspace);
  const items = again.listSorted();
  assert.equal(items.length, 1);
  assert.equal(items[0].prompt, "lis les issues");
  assert.equal(items[0].cadence, "daily 09:00");
});

test("RoutineBook: rejects bad cadence and empty prompt", async () => {
  const book = makeBook();
  assert.equal((await book.add("every blue moon", "x")).ok, false);
  assert.equal((await book.add("every 30m", "   ")).ok, false);
});

test("RoutineBook: remove, enable and disable", async () => {
  const book = makeBook();
  const added = await book.add("every 1h", "tache");
  assert.equal(added.ok, true);
  assert.match(await book.setEnabled("1", false), /mise en pause/);
  assert.equal(book.listSorted()[0].enabled, false);
  assert.match(await book.setEnabled("1", true), /réactivée/);
  assert.equal(book.listSorted()[0].enabled, true);
  assert.match(await book.remove("1"), /supprimée/);
  assert.equal(book.listSorted().length, 0);
  assert.match(await book.remove("1"), /^Error: /);
});

test("RoutineBook: claimDue takes each occurrence exactly once", async () => {
  const book = makeBook();
  const added = await book.add("every 30m", "tache", 1_000_000);
  assert.equal(added.ok, true);
  assert.equal(await book.claimDue(1_000_000), null, "not due yet");
  const first = await book.claimDue(1_000_000 + 30 * 60_000);
  assert.ok(first);
  assert.equal(first.id, added.routine.id);
  assert.equal(await book.claimDue(1_000_000 + 30 * 60_000), null, "a claim advances the schedule");
  const second = await book.claimDue(1_000_000 + 60 * 60_000);
  assert.ok(second, "the next occurrence is claimable");
});

test("RoutineBook: a disabled routine is never claimed", async () => {
  const book = makeBook();
  await book.add("every 30m", "tache", 1_000_000);
  await book.setEnabled("1", false);
  assert.equal(await book.claimDue(1_000_000 + 3_600_000), null);
});

test("RoutineBook: markResult records a short status", async () => {
  const book = makeBook();
  const added = await book.add("every 30m", "tache", 1_000_000);
  assert.equal(added.ok, true);
  await book.markResult(added.routine.id, "ok");
  assert.equal(book.listSorted()[0].lastStatus, "ok");
});

test("RoutineBook: a corrupted file is reported, never silently overwritten", async () => {
  const book = makeBook();
  fs.mkdirSync(path.join(book.workspace, ".smol"), { recursive: true });
  fs.writeFileSync(path.join(book.workspace, ".smol", "routines.json"), "{not json");
  assert.throws(() => book.listSorted(), /JSON invalide/);
  await assert.rejects(() => book.claimDue(Date.now()), /JSON invalide/);
});

function createRoutineHarness(workspace) {
  const session = Object.create(Session.prototype);
  session.workspace = workspace;
  session.routines = new RoutineBook(workspace);
  session.handled = [];
  session.lines = [];
  session.agent = { outcome: "idle" };
  session.handleUserMessage = async (input) => {
    session.handled.push(input);
    session.agent.outcome = "completed";
  };
  session.ui = {
    error(message) {
      throw new Error(message);
    },
    warn(message) {
      session.lines.push("warn: " + message);
    },
    status(message) {
      session.lines.push("status: " + message);
    },
    println(message) {
      session.lines.push("out: " + message);
    },
  };
  return session;
}

test("session /routine add, list and remove round-trip", async () => {
  const session = createRoutineHarness(makeBook().workspace);
  await session.routineCommand(["add", "every 30m |", "relis les issues"]);
  assert.equal(session.routines.listSorted().length, 1);
  assert.match(session.lines.join("\n"), /routine ajoutée — toutes les 30 min/);
  session.lines.length = 0;
  await session.routineCommand([]);
  assert.match(session.lines.join("\n"), /1\. toutes les 30 min → « relis les issues »/);
  await session.routineCommand(["remove", "1"]);
  assert.equal(session.routines.listSorted().length, 0);
});

function forceDue(workspace, next = 1) {
  const file = path.join(workspace, ".smol", "routines.json");
  const items = JSON.parse(fs.readFileSync(file, "utf8"));
  items[0].next = next;
  fs.writeFileSync(file, JSON.stringify(items));
}

test("the routine tick runs a due routine through the normal turn path", async () => {
  const session = createRoutineHarness(makeBook().workspace);
  const added = await session.routines.add("every 30m", "verifie le build", 1_000_000);
  assert.equal(added.ok, true);
  forceDue(session.workspace);

  await session.routineTick();
  assert.deepEqual(session.handled, ["verifie le build"]);
  assert.equal(session.routines.listSorted()[0].lastStatus, "ok");
  assert.match(session.lines.join("\n"), /⏰ routine toutes les 30 min/);

  session.lines.length = 0;
  await session.routineTick();
  assert.equal(session.handled.length, 1, "the occurrence is not replayed");
});

test("the routine tick waits while a turn is running", async () => {
  const session = createRoutineHarness(makeBook().workspace);
  const added = await session.routines.add("every 30m", "tache", 1_000_000);
  assert.equal(added.ok, true);
  forceDue(session.workspace);

  session.agent.outcome = "running";
  await session.routineTick();
  assert.equal(session.handled.length, 0);
  assert.equal(session.routines.listSorted()[0].next, 1, "the schedule is untouched");
});

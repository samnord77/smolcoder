// Tests du VRAI client mail (dist/mail.js) contre de vrais serveurs IMAP et
// SMTP scriptés en sockets TCP : aucune boîte externe, aucune simulation côté
// produit — seuls les serveurs de test sont des doubles, comme partout ici.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const BASE_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "smol-mail-"));
process.env.SMOLCODER_DATA_DIR = BASE_DATA;

const mail = require("../dist/mail");
const { writeConnectors } = require("../dist/connectors");
const { runMail } = require("../dist/tools/mail");

function isolatedData(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smol-mail-case-"));
  process.env.SMOLCODER_DATA_DIR = dir;
  t.after(() => {
    process.env.SMOLCODER_DATA_DIR = BASE_DATA;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function imapServer(handler) {
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    let buf = "";
    sock.write("* OK [CAPABILITY IMAP4rev1] serveur de test prêt\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        const idx = buf.indexOf("\r\n");
        if (idx < 0) break;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        handler(line, sock);
      }
    });
  });
  const close = server.close.bind(server);
  server.close = (cb) => {
    for (const s of sockets) s.destroy();
    return close(cb);
  };
  return server;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function configureMail(port) {
  writeConnectors({
    mail: {
      address: "moi@exemple.fr",
      user: "moi@exemple.fr",
      password: "secret-app",
      imap: { host: "127.0.0.1", port, secure: false },
      smtp: { host: "127.0.0.1", port, secure: false },
    },
  });
}

test("listInbox : dialogue IMAP réel, sujets RFC 2047 décodés, plus récents d'abord", async (t) => {
  isolatedData(t);
  const h1 = Buffer.from(
    "From: =?UTF-8?B?QWxpY2UgTcOpbsOocw==?= <alice@exemple.fr>\r\nSubject: =?UTF-8?B?UsOpdW5pb24=?=\r\nDate: Thu, 16 Oct 2026 09:30:00 +0000\r\n\r\n"
  );
  const h2 = Buffer.from("From: bob@exemple.fr\r\nSubject: Rapport\r\nDate: Fri, 17 Oct 2026 08:00:00 +0000\r\n\r\n");
  const server = imapServer((line, sock) => {
    const tag = line.split(" ")[0];
    const cmd = line.slice(tag.length + 1).toUpperCase();
    if (cmd.startsWith("LOGIN")) return void sock.write(`${tag} OK LOGIN done\r\n`);
    if (cmd.startsWith("SELECT")) return void sock.write(`* 2 EXISTS\r\n* OK [UIDVALIDITY 1]\r\n${tag} OK [READ-WRITE] done\r\n`);
    if (cmd.startsWith("UID SEARCH")) return void sock.write(`* SEARCH 1 2\r\n${tag} OK done\r\n`);
    if (cmd.startsWith("UID FETCH")) {
      sock.write(`* 1 FETCH (UID 1 FLAGS (\\Seen) BODY[HEADER] {${h1.length}}\r\n`);
      sock.write(h1);
      sock.write(")\r\n");
      sock.write(`* 2 FETCH (UID 2 FLAGS () BODY[HEADER] {${h2.length}}\r\n`);
      sock.write(h2);
      sock.write(")\r\n");
      return void sock.write(`${tag} OK FETCH done\r\n`);
    }
    if (cmd.startsWith("LOGOUT")) return void sock.write(`* BYE\r\n${tag} OK done\r\n`);
    sock.write(`${tag} BAD commande inattendue\r\n`);
  });
  t.after(() => server.close());
  configureMail(await listen(server));

  const items = await mail.listInbox(10);
  assert.equal(items.length, 2);
  assert.equal(items[0].uid, 2); // le plus récent d'abord
  assert.equal(items[0].subject, "Rapport");
  assert.equal(items[0].seen, false);
  assert.equal(items[1].uid, 1);
  assert.equal(items[1].subject, "Réunion");
  assert.ok(items[1].from.includes("Alice Ménès"), `from décodé : ${items[1].from}`);
  assert.equal(items[1].seen, true);
  const formatted = mail.formatMailList(items);
  assert.ok(formatted.includes("• #2"), formatted);
  assert.ok(formatted.includes("Rapport"));
});

test("readMessage : corps multipart/alternative, text/plain préféré, base64 décodé", async (t) => {
  isolatedData(t);
  const header = Buffer.from('Content-Type: multipart/alternative; boundary="b1"\r\nFrom: carol@exemple.fr\r\nSubject: Test MIME\r\n\r\n');
  const body = Buffer.from(
    [
      "--b1",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("Bonjour depuis le test.", "utf8").toString("base64"),
      "--b1",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Bonjour <b>HTML</b></p>",
      "--b1--",
      "",
    ].join("\r\n")
  );
  const server = imapServer((line, sock) => {
    const tag = line.split(" ")[0];
    const cmd = line.slice(tag.length + 1).toUpperCase();
    if (cmd.startsWith("LOGIN")) return void sock.write(`${tag} OK done\r\n`);
    if (cmd.startsWith("SELECT")) return void sock.write(`* 1 EXISTS\r\n${tag} OK done\r\n`);
    if (cmd.startsWith("UID FETCH")) {
      sock.write(`* 1 FETCH (UID 7 FLAGS (\\Seen) BODY[HEADER] {${header.length}}\r\n`);
      sock.write(header);
      sock.write(` BODY[TEXT] {${body.length}}\r\n`);
      sock.write(body);
      sock.write(`)\r\n${tag} OK done\r\n`);
      return;
    }
    if (cmd.startsWith("LOGOUT")) return void sock.write(`* BYE\r\n${tag} OK done\r\n`);
    sock.write(`${tag} BAD\r\n`);
  });
  t.after(() => server.close());
  configureMail(await listen(server));

  const message = await mail.readMessage(7);
  assert.equal(message.uid, 7);
  assert.equal(message.subject, "Test MIME");
  assert.equal(message.text, "Bonjour depuis le test.");
  assert.equal(message.bodyTruncated, false);
});

test("sendMailNow : dialogue SMTP réel, message complet capturé et décodé", async (t) => {
  isolatedData(t);
  const captured = { auth: "", data: "" };
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    let buf = "";
    let inData = false;
    sock.write("220 serveur de test prêt\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          captured.data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          sock.write("250 message accepté\r\n");
          continue;
        }
        const idx = buf.indexOf("\r\n");
        if (idx < 0) return;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const cmd = line.toUpperCase();
        if (cmd.startsWith("EHLO")) {
          sock.write("250-serveur\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n");
        } else if (cmd.startsWith("AUTH PLAIN ")) {
          captured.auth = Buffer.from(line.split(" ")[2], "base64").toString("utf8");
          sock.write("235 authentifié\r\n");
        } else if (cmd.startsWith("MAIL FROM") || cmd.startsWith("RCPT TO")) {
          sock.write("250 OK\r\n");
        } else if (cmd === "DATA") {
          inData = true;
          sock.write("354 finir par <CRLF>.<CRLF>\r\n");
        } else if (cmd === "QUIT") {
          sock.write("221 au revoir\r\n");
          sock.end();
        } else {
          sock.write("500 inattendu\r\n");
        }
      }
    });
  });
  t.after(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  configureMail(await listen(server));

  const result = await mail.sendMailNow({ to: "dest@exemple.fr", subject: "Réunion demain", text: "Ligne 1\nLigne 2" });
  assert.ok(result.includes("dest@exemple.fr"), result);
  assert.equal(captured.auth, "\u0000moi@exemple.fr\u0000secret-app");
  assert.ok(captured.data.includes("To: dest@exemple.fr"), captured.data);
  assert.ok(captured.data.includes("From: moi@exemple.fr"));
  assert.match(captured.data, /Subject: =\?UTF-8\?B\?/);
  const bodyBase64 = captured.data.split("\r\n\r\n")[1].replace(/\r\n/g, "");
  assert.equal(Buffer.from(bodyBase64, "base64").toString("utf8"), "Ligne 1\r\nLigne 2");
});

test("erreurs honnêtes : adresse invalide, boîte non configurée", async (t) => {
  isolatedData(t);
  configureMail(1);
  await assert.rejects(() => mail.sendMailNow({ to: "pas-une-adresse", subject: "x", text: "y" }), /adresse e-mail invalide/);
  writeConnectors({});
  const message = await runMail({ action: "list" });
  assert.equal(message, mail.mailNotConfiguredMessage());
  assert.ok(!message.startsWith("Error"), "non configuré = message honnête, pas une erreur générique");
});

test("CLI : check sans configuration → exit 1 et conseil setup ; commande inconnue → exit 1", (t) => {
  const dir = isolatedData(t);
  const run = (args) =>
    spawnSync(process.execPath, [path.join(ROOT, "dist", "index.js"), ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, SMOLCODER_DATA_DIR: dir },
    });
  const check = run(["mail", "check"]);
  assert.equal(check.status, 1);
  assert.ok(`${check.stdout}${check.stderr}`.includes("smol mail setup"), check.stdout + check.stderr);
  const unknown = run(["mail", "wat"]);
  assert.equal(unknown.status, 1);
  assert.ok(`${unknown.stdout}${unknown.stderr}`.includes("smol mail"), unknown.stdout + unknown.stderr);
});

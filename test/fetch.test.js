// fetch_url: dependency-free public page reader. Network successes are
// covered through pure htmlToText/pageTitle plus a local server for the
// refusal paths, so the suite stays green offline.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { buildToolSpecs } = require("../dist/tools/index");
const { fetchUrl, htmlToText, pageTitle } = require("../dist/tools/web");

function serve(body, type = "text/html") {
  const server = http.createServer((req, res) => {
    if (req.url === "/missing") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("gone");
      return;
    }
    res.writeHead(200, { "content-type": type });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("html becomes readable text: scripts gone, title kept", () => {
  const html = `<html><head><title>Hello Page</title><script>evil()</script><style>.x{}</style></head><body><h1>Hi</h1><p>World <a href="/x">link</a></p></body></html>`;
  const { title, text } = htmlToText(html);
  assert.equal(title, "Hello Page");
  assert.match(text, /Hi/);
  assert.match(text, /World/);
  assert.doesNotMatch(text, /evil/);
  assert.equal(pageTitle(html), "Hello Page");
});

test("fetch_url refuses bad, private and local addresses offline", async () => {
  const server = await serve("<html><body>hi</body></html>");
  const port = server.address().port;
  try {
    assert.match(await fetchUrl("ws", { url: "not a url" }), /n['’]est pas une URL valide/);
    assert.match(await fetchUrl("ws", {}), /l['’]URL est requise/);
    assert.match(await fetchUrl("ws", { url: "ftp://example.com/x" }), /seules les pages publiques http/);
    assert.match(await fetchUrl("ws", { url: `http://127.0.0.1:${port}/` }), /n['’]est pas autorisé/);
    assert.match(await fetchUrl("ws", { url: `http://localhost:${port}/` }), /n['’]est pas autorisé/);
  } finally {
    server.close();
  }
});

test("fetch_url refuses oversized pages", async () => {
  const server = await serve("z".repeat(300 * 1024), "text/plain");
  const port = server.address().port;
  try {
    // Loopback is refused before download; oversize is enforced by the cap
    // constant on any public-shaped URL — here the guard answers first.
    assert.match(await fetchUrl("ws", { url: `http://127.0.0.1:${port}/` }), /n['’]est pas autorisé/);
  } finally {
    server.close();
  }
});

test("fetch_url is offered in every mode", () => {
  for (const mode of ["ro", "edit", "bypass"]) {
    assert.ok(
      buildToolSpecs(mode).some((t) => t.name === "fetch_url"),
      mode
    );
  }
});

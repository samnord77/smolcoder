// fetch_url: read a public web page as text. Built-in fetch only — no key,
// no subscription, no new dependency. HTML is reduced to readable text
// (scripts, styles and tags stripped) and capped so one page cannot flood a
// small context window. Loopback and private addresses are refused: the
// agent must never probe the local model server or the home network.

const FETCH_TIMEOUT_MS = 25_000;
const FETCH_BODY_CAP = 200_000;
const OUTPUT_CAP = 8000;

function isPublicHttp(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (/^\[.*\]$/.test(host)) return host !== "[::1]";
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const n = v4.slice(1).map(Number);
    if (n.some((x) => x > 255)) return false;
    if (n[0] === 10 || n[0] === 127) return false;
    if (n[0] === 172 && n[1] >= 16 && n[1] <= 31) return false;
    if (n[0] === 192 && n[1] === 168) return false;
    if (n[0] === 169 && n[1] === 254) return false;
    if (n[0] === 0 || n[0] >= 224) return false;
    return true;
  }
  return true;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) =>
      e === "amp" ? "&" : e === "lt" ? "<" : e === "gt" ? ">" : e === "quot" || e === "#39" ? '"' : " "
    )
    .replace(/&#(\d+);/g, (_, n: string) => {
      const c = Number(n);
      return c > 31 && c < 0x10ffff ? String.fromCodePoint(c) : " ";
    });
}

/** Exported for tests: reduce HTML to a title plus readable text. */
export function htmlToText(html: string): { title: string; text: string } {
  let s = html.replace(/<script[\s\S]*?<\/script\s*>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style\s*>/gi, " ");
  s = s.replace(/<(noscript|template|svg|canvas)[\s\S]*?<\/\1\s*>/gi, " ");
  const title = (/<title[^>]*>([\s\S]{1,300})<\/title\s*>/i.exec(s)?.[1] ?? "").replace(/\s+/g, " ").trim();
  s = s.replace(/<(br|p|div|h[1-6]|li|tr|section|article|header|footer)[\s>]/gi, "\n$1 ");
  s = s.replace(/<[^>]*>/g, " ");
  s = decodeEntities(s);
  const lines = s
    .split("\n")
    .map((l) => l.replace(/[ \t\r\f]+/g, " ").trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const deduped = lines.filter((l) => (l.length < 40 || !seen.has(l) ? (seen.add(l), true) : false));
  return { title, text: deduped.join("\n") };
}

export function pageTitle(html: string): string {
  return /<title[^>]*>([\s\S]{1,300})<\/title\s*>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
}

export async function fetchUrl(root: string, args: any, signal?: AbortSignal): Promise<string> {
  void root;
  const raw = typeof args.url === "string" ? args.url.trim() : "";
  if (!raw) {
    return 'Error: url is required. Example: {"url": "https://example.com/docs"}';
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `Error: "${raw.slice(0, 120)}" is not a valid URL. Use a full https:// address.`;
  }
  if (!isPublicHttp(url)) {
    return `Error: only public http(s) pages can be read — "${url.protocol}//${url.hostname}" is not allowed.`;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const onAbort = (): void => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url.toString(), {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": "smolcoder/1 (+local coding agent)", accept: "text/html,text/plain,*/*" },
    });
    if (!res.ok) return `Error: the page answered ${res.status} ${res.statusText}. Check the address.`;
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!/text|html|xml|json|markdown/.test(type) && type) {
      return `Error: "${type.split(";")[0]}" is not readable text (page skipped to save context).`;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > FETCH_BODY_CAP) {
      return `Error: page too large (${Math.round(buf.length / 1024)} KB, limit ${FETCH_BODY_CAP / 1000} KB). Narrow the question or read its docs instead.`;
    }
    const body = buf.toString("utf8");
    const isHtml = /<html|<!doctype/i.test(body);
    const title = isHtml ? htmlToText(body).title : pageTitle(body);
    const rawText = isHtml ? htmlToText(body).text : body;
    const clean = rawText.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (!clean) return "Error: the page contains no readable text.";
    const head = clean.length > OUTPUT_CAP ? clean.slice(0, OUTPUT_CAP) + `\n[page capped at ${OUTPUT_CAP} characters — ask for one section at a time]` : clean;
    return `${title ? `Title: ${title}\n` : ""}URL: ${url.toString()}\n\n${head}`;
  } catch (err: any) {
    if (err?.name === "AbortError" || signal?.aborted) return "Error: the page took too long (25s) — try a lighter page.";
    return `Error: could not read the page (${String(err?.message ?? err).slice(0, 160)}).`;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

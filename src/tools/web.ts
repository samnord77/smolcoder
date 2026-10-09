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
  const deduped = lines.filter((l) => {
    if (l.length < 40) return true;
    if (seen.has(l)) return false;
    seen.add(l);
    return true;
  });
  return { title, text: deduped.join("\n") };
}

export function pageTitle(html: string): string {
  return /<title[^>]*>([\s\S]{1,300})<\/title\s*>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
}

export async function fetchUrl(root: string, args: any, signal?: AbortSignal): Promise<string> {
  void root;
  const raw = typeof args.url === "string" ? args.url.trim() : "";
  if (!raw) {
    return 'Error: l’URL est requise. Exemple : {"url": "https://example.com/docs"}';
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `Error: « ${raw.slice(0, 120)} » n’est pas une URL valide. Utilisez une adresse https:// complète.`;
  }
  if (!isPublicHttp(url)) {
    return `Error: seules les pages publiques http(s) peuvent être lues — « ${url.protocol}//${url.hostname} » n’est pas autorisé.`;
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
    if (!res.ok) return `Error: la page a répondu ${res.status} ${res.statusText}. Vérifiez l’adresse.`;
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!/text|html|xml|json|markdown/.test(type) && type) {
      return `Error: « ${type.split(";")[0]} » n’est pas du texte lisible (page ignorée pour économiser le contexte).`;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > FETCH_BODY_CAP) {
      return `Error: page trop volumineuse (${Math.round(buf.length / 1024)} Ko, limite ${FETCH_BODY_CAP / 1000} Ko). Précisez la question ou lisez plutôt la documentation.`;
    }
    const body = buf.toString("utf8");
    const isHtml = /<html|<!doctype/i.test(body);
    const title = isHtml ? htmlToText(body).title : pageTitle(body);
    const rawText = isHtml ? htmlToText(body).text : body;
    const clean = rawText
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!clean) return "Error: la page ne contient pas de texte lisible.";
    const head =
      clean.length > OUTPUT_CAP
        ? `${clean.slice(0, OUTPUT_CAP)}\n[page plafonnée à ${OUTPUT_CAP} caractères — demandez une section à la fois]`
        : clean;
    return `${title ? `Titre : ${title}\n` : ""}URL : ${url.toString()}\n\n${head}`;
  } catch (err: any) {
    if (err?.name === "AbortError" || signal?.aborted) return "Error: la page a mis trop de temps (25 s) — essayez une page plus légère.";
    return `Error: impossible de lire la page (${String(err?.message ?? err).slice(0, 160)}).`;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

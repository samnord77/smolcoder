import type { ChatOptions } from "./types";

export type BackendTimeoutCode = "BACKEND_IDLE_TIMEOUT" | "BACKEND_REQUEST_TIMEOUT";

export class BackendTimeoutError extends Error {
  constructor(readonly code: BackendTimeoutCode) {
    super(
      code === "BACKEND_IDLE_TIMEOUT"
        ? "Backend timed out waiting for data. Check the model server and available memory."
        : "Backend request timed out. The model did not finish within the request deadline."
    );
    this.name = "BackendTimeoutError";
  }
}

export function isBackendTimeoutError(error: unknown): boolean {
  if (
    error instanceof BackendTimeoutError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "BACKEND_IDLE_TIMEOUT" || error.code === "BACKEND_REQUEST_TIMEOUT"))
  )
    return true;
  const message = String((error as any)?.message ?? error ?? "");
  return /Backend timed out waiting for data|Backend request timed out|backend timeout|timed out waiting for data/i.test(message);
}

/** A local CPU model can need minutes to prefill a prompt. Node's fetch gives up
 * after ~300 s waiting for response headers (UND_ERR_HEADERS_TIMEOUT) long before
 * our own deadline fires; it surfaces to users as a bare `fetch failed` and used to
 * kill the turn. This separates "the server is still working" from a real drop. */
export function isSlowPrefillError(error: unknown): boolean {
  const e: any = error;
  const code = String(e?.cause?.code ?? e?.code ?? "");
  const causeMessage = String(e?.cause?.message ?? "");
  return (
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    /headers timeout error|body timeout error/i.test(causeMessage) ||
    /Headers Timeout Error|Body Timeout Error/i.test(String(e?.message ?? ""))
  );
}

/** A rejected HTTP response (4xx/5xx). The status travels as a field instead
 * of being parsed back out of the message text, so failover ladders and retry
 * policies key on `status` while users read a fully French message. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly serverName: string,
    detail: string
  ) {
    super(`${serverName} : erreur ${status} — ${detail}`);
    this.name = "HttpError";
  }
}

/** True for the 4xx family the shape-fallback ladder may act on. Exported so
 * providers never re-encode HTTP status matching in message regexes. */
export function isHttp4xx(err: unknown): err is HttpError {
  return err instanceof HttpError && err.status >= 400 && err.status < 500;
}

/** Undici reports every network drop as a bare `fetch failed` with the real
 * reason buried in `cause` (DNS miss, refused socket, connect timeout). Attach
 * it so the chat log and the retry loop say WHY the call died. */
export async function fetchOrCause(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err: any) {
    if (err?.name === "AbortError" || isBackendTimeoutError(err)) throw err;
    if (!/fetch failed/i.test(String(err?.message ?? ""))) throw err;
    const cause: any = err?.cause;
    const first: any = Array.isArray(cause?.errors) ? cause.errors[0] : cause;
    const code = String(first?.code ?? cause?.code ?? "");
    const detail = String(first?.message ?? cause?.message ?? first?.name ?? "");
    throw new Error(`fetch failed${code ? ` [${code}]` : ""}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A provider 429/5xx body is a JSON blob whose raw slice is unreadable (and
 * the chat log truncates to 80 chars). Surface the human message and the
 * Retry-After countdown instead; keep the raw body for auth/validation errors. */
export function httpErrorDetail(status: number, text: string, headers?: Headers): string {
  if (status !== 429 && status < 500) return text.slice(0, 300);
  let msg = "";
  try {
    const data = JSON.parse(text);
    const e = Array.isArray(data) ? data?.[0]?.error : data?.error;
    msg = typeof e === "string" ? e : String(e?.message ?? data?.message ?? "");
  } catch {
    // not JSON (HTML error page…) — no extracted message
  }
  const head = status === 429 ? "limite de requêtes atteinte" : "erreur temporaire du serveur";
  const ra = String(headers?.get("retry-after") ?? "");
  const reset = /^\d+$/.test(ra) ? ` (réessayer dans ${ra} s)` : "";
  return `${head}${reset}${msg ? ` — ${msg}` : ""}`.slice(0, 300);
}

/** Fail visibly when a local server accepts a request but stops producing data. */
export async function withDeadline<T>(opts: ChatOptions, run: (signal: AbortSignal, activity: () => void) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort(opts.signal?.reason);
  let idle: NodeJS.Timeout;
  // A local model legitimately sends nothing while it loads into memory and
  // prefills a long prompt: that silence is not a stall. The strict idle
  // window only starts once data has actually flowed.
  const arm = (ms: number) => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new BackendTimeoutError("BACKEND_IDLE_TIMEOUT")), ms);
  };
  const activity = () => arm(opts.idleTimeoutMs ?? 180_000);
  const total = setTimeout(() => controller.abort(new BackendTimeoutError("BACKEND_REQUEST_TIMEOUT")), opts.timeoutMs ?? 1_800_000);
  opts.signal?.addEventListener("abort", cancel, { once: true });
  if (opts.signal?.aborted) cancel();
  // Tests and callers that explicitly tune idleTimeoutMs expect the same
  // deadline before the first byte. Keep a long local-model default only when
  // no timeout was configured at all.
  arm(opts.firstDataTimeoutMs ?? opts.idleTimeoutMs ?? 480_000);
  try {
    return await run(controller.signal, activity);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(idle!);
    clearTimeout(total);
    opts.signal?.removeEventListener("abort", cancel);
  }
}

/** Cancel reads and release the connection even on malformed stream data. */
export async function* responseLines(res: Response, activity: () => void): AsyncGenerator<string> {
  if (!res.body) throw new Error("Le backend a renvoyé une réponse vide (corps HTTP absent).");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      activity();
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 4_000_000) throw new Error("Trame du flux trop volumineuse (plus de 4 Mo) — flux interrompu.");
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        yield buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield buffer.trim();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function streamJson(line: string): any {
  let data: any;
  try {
    data = JSON.parse(line);
  } catch {
    // The English keyword stays in the message: retry policies (TRANSIENT_ERROR,
    // isTransientError) match on it. The French wording is what users read.
    throw new Error("JSON malformé (malformed JSON) dans le flux du backend ; la réponse a été ignorée.");
  }
  // "stream error" stays: TRANSIENT_ERROR retries on that keyword.
  if (data?.error)
    throw new Error(
      `stream error transmis par le backend : ${typeof data.error === "string" ? data.error : (data.error.message ?? JSON.stringify(data.error))}`
    );
  return data;
}

export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

// Model routing with automatic failover: when the primary backend goes down
// mid-turn, the next healthy model answers instead of failing the turn.
// Configure with SMOLCODER_FALLBACKS="ollama:qwen,lmstudio:glm"
// (backend + model id substrings, comma-separated; backend may be omitted).
// Unset = direct provider, zero behavior change. Resolution is lazy: the
// fallback list is detected only after the first transient failure, never
// slowing down a healthy primary. Never throws at construction.
import type { DetectedModel } from "./detect";
import type { ChatOptions, ChatResult, Effort, Msg, Provider, ToolSpec } from "./providers/types";

export interface FallbackSpec {
  backend: string;
  id: string;
}

/** Parse "ollama:qwen3:8b,lmstudio:glm" — the id keeps every colon after the
 * first, so model names with colons survive. Exported for tests. */
export function parseFallbacks(raw: string | undefined): FallbackSpec[] {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const i = entry.indexOf(":");
      if (i < 0) return { backend: "", id: entry };
      return { backend: entry.slice(0, i).trim().toLowerCase(), id: entry.slice(i + 1).trim() };
    })
    .filter((s) => s.id.length > 0);
}

/** Transport-level and overloaded-backend failures are worth a retry
 * elsewhere; model-behavior failures (empty reply, bad args) are not —
 * another model would likely fail the same way. Exported for tests. */
export function isTransientError(err: any): boolean {
  const msg = String(err?.message ?? err).toLowerCase();
  return /econnrefused|etimedout|enotfound|eai_again|econnreset|epipe|socket hang up|timed out|timeout|429|50[0239]|bad gateway|service unavailable|gateway timeout|temporar|overloaded|fetch failed|network error|connection/i.test(
    msg
  );
}

export interface RouteSnapshot {
  chain: string[];
  current: number;
  failures: Array<{ provider: string; error: string }>;
}

export class RoutingProvider implements Provider {
  private fallbacks: Provider[] = [];
  private resolved = false;
  private current = 0;
  private failures: Array<{ provider: string; error: string }> = [];
  private effort: Effort | null = null;

  constructor(
    private primary: Provider,
    private specs: FallbackSpec[],
    private resolve: () => Promise<DetectedModel[]>,
    private build: (m: DetectedModel) => Provider,
    private notify?: (msg: string) => void
  ) {}

  get label(): string {
    return this.primary.label + (this.specs.length ? ` (+${this.specs.length} fallback)` : "");
  }
  get modelId(): string {
    return this.primary.modelId;
  }
  get contextWindow(): number {
    return this.primary.contextWindow;
  }
  get maxOutputTokens(): number {
    return this.primary.maxOutputTokens;
  }
  get vision(): boolean | undefined {
    return this.primary.vision;
  }
  get replaysThinking(): boolean | undefined {
    return this.primary.replaysThinking;
  }
  setEffort(e: Effort | null): void {
    this.effort = e;
    try {
      this.primary.setEffort(e);
    } catch {
      /* keep going */
    }
    this.fallbacks.forEach((p) => {
      try {
        p.setEffort(e);
      } catch {
        /* keep going */
      }
    });
  }
  effortLabel(): string | null {
    return this.active().effortLabel();
  }
  async loadedContextWindow(): Promise<number | undefined> {
    try {
      return await this.active().loadedContextWindow?.();
    } catch {
      return undefined;
    }
  }
  private active(): Provider {
    return this.fallbacks[this.current - 1] ?? this.primary;
  }
  private chain(): Provider[] {
    return [this.primary, ...this.fallbacks];
  }

  private async ensureFallbacks(): Promise<void> {
    if (this.resolved || !this.specs.length) return;
    this.resolved = true;
    let models: DetectedModel[] = [];
    try {
      models = await this.resolve();
    } catch {
      return;
    }
    for (const spec of this.specs) {
      const hit = models.find(
        (m) =>
          (!spec.backend || m.backend.toLowerCase().includes(spec.backend) || (m.host ?? "").toLowerCase().includes(spec.backend)) &&
          m.id.toLowerCase().includes(spec.id.toLowerCase())
      );
      if (!hit) {
        this.failures.push({ provider: `${spec.backend || "?"}:${spec.id}`, error: "not detected" });
        continue;
      }
      try {
        const p = this.build(hit);
        p.setEffort(this.effort);
        if (p.label === this.primary.label || this.fallbacks.some((q) => q.label === p.label)) continue;
        this.fallbacks.push(p);
      } catch (err: any) {
        this.failures.push({ provider: `${spec.backend || "?"}:${spec.id}`, error: String(err?.message ?? err).slice(0, 120) });
      }
    }
  }

  async chat(messages: Msg[], tools: ToolSpec[], opts: ChatOptions = {}): Promise<ChatResult> {
    await this.ensureFallbacks();
    const order = this.chain();
    let lastErr: any = null;
    for (let i = 0; i < order.length; i++) {
      this.current = i;
      try {
        return await order[i].chat(messages, tools, opts);
      } catch (err: any) {
        lastErr = err;
        if (!isTransientError(err) || i === order.length - 1) throw err;
        const msg = String(err?.message ?? err).slice(0, 160);
        this.failures.push({ provider: order[i].label, error: msg });
        try {
          this.notify?.(`· ${order[i].label} failed (${msg}) — trying ${order[i + 1].label}`);
        } catch {
          /* status must never break a turn */
        }
      }
    }
    throw lastErr ?? new Error("no providers available");
  }

  snapshot(): RouteSnapshot {
    return {
      chain: this.chain().map((p) => p.label),
      current: this.current,
      failures: [...this.failures],
    };
  }

  /** Human-readable chain for /route. Never throws. */
  describe(): string {
    const s = this.snapshot();
    const lines = [`Route: ${s.chain.join(" → ") || this.primary.label}`, `Serving: ${s.chain[s.current] ?? this.primary.label}`];
    for (const f of s.failures.slice(-5)) lines.push(`✗ ${f.provider}: ${f.error}`);
    if (!this.specs.length) lines.push('No fallbacks configured — set SMOLCODER_FALLBACKS="ollama:qwen,lmstudio:glm" to add any.');
    return lines.join("\n");
  }
}

/** Wrap the primary when fallbacks are configured; otherwise return it
 * untouched (no behavior change, no detection cost). */
export function routeProvider(
  primary: Provider,
  raw: string | undefined,
  resolve: () => Promise<DetectedModel[]>,
  build: (m: DetectedModel) => Provider,
  notify?: (msg: string) => void
): Provider {
  const specs = parseFallbacks(raw);
  if (!specs.length) return primary;
  return new RoutingProvider(primary, specs, resolve, build, notify);
}

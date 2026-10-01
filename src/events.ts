// Internal lifecycle event bus. Handlers run sequentially and may be async,
// so a pre_request handler can finish compaction before the request goes out.
// Not user-configurable in v1 by design — this is the spine that compaction,
// the context meter, and logging hang off. User-facing hooks can come later.

export type LifecycleEvent =
  | "session_start"
  | "pre_request"
  | "post_tool"
  | "post_verify"
  | "post_progress_check"
  | "context_update"
  | "pre_compact"
  | "post_compact"
  | "validation"
  | "session_end";

type Handler = (payload?: unknown) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<LifecycleEvent, Handler[]>();

  on(event: LifecycleEvent, handler: Handler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  async emit(event: LifecycleEvent, payload?: unknown): Promise<void> {
    const list = this.handlers.get(event);
    if (!list) return;
    for (const h of list) {
      try {
        await h(payload);
      } catch (err) {
        console.error(`[events] ${event} handler failed: ${(err as Error)?.message ?? err}`);
      }
    }
  }
}

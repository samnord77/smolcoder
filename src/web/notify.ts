// Desktop notifications: approvals, turn end, errors. The decision is pure
// (fully tested here); the browser page only asks permission, shows them
// and remembers the bell toggle. Nothing fires when the toggle is off or
// the page is already visible — no spam while you watch.
export type NoticeKind = "confirm" | "turnend" | "error";

export interface NoticeInput {
  kind: NoticeKind;
  /** User enabled the bell. */
  enabled: boolean;
  /** Page visible right now (no need to ping someone who watches). */
  visible: boolean;
  /** Short detail: command, error line or turn label. */
  text: string;
}

export interface Notice {
  title: string;
  body: string;
}

const TITLE: Record<NoticeKind, string> = {
  confirm: "smolcoder — approval needed",
  turnend: "smolcoder — turn finished",
  error: "smolcoder — attention needed",
};

/** What to show, or null for silence. Exported for tests. */
export function decideNotice(input: NoticeInput): Notice | null {
  if (!input.enabled || input.visible) return null;
  const text =
    String(input.text ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 160) || "—";
  return { title: TITLE[input.kind], body: text };
}

/** localStorage key for the bell toggle. */
export const NOTIFY_KEY = "smol-notify";

/** Plain-JavaScript source injected into the web page (same pattern as the
 * CRDT module): the decision logic stays single-sourced in the browser too. */
export const browserNotifySource = [
  `const NOTIFY_TITLE = ${JSON.stringify(TITLE)};`,
  `const ${decideNotice.name} = (${decideNotice.toString().replace(/\bTITLE\b/g, "NOTIFY_TITLE")});`,
].join("\n");

// The `browser` tool: a persistent local browser per session, driven through
// src/browser.ts (headless Chrome/Edge + Chrome DevTools Protocol). Read-only
// mode keeps open/read/shot/back/close and refuses click/type/press — both in
// the tool spec and again at runtime, so a hand-crafted call cannot slip past
// the mode. Messages follow the project's French tool wording.
import { BROWSER_READ_CAP, type BrowserLiveShot, BrowserSession } from "../browser";
import type { ToolSpec } from "../providers/types";

/** The slice of ToolContext the browser tool needs (no circular import). */
export interface BrowserCtx {
  workspace: string;
  canWrite?: boolean;
  browser?: BrowserSession;
  /** Reçoit chaque étape (capture comprise) pour le panneau Navigateur. */
  browserNotify?: (ev: BrowserLiveShot) => void | Promise<void>;
}

const ALL_ACTIONS = ["open", "read", "click", "type", "press", "shot", "back", "close"] as const;
const READ_ONLY_ACTIONS = ["open", "read", "shot", "back", "close"] as const;

export function browserTool(canWrite: boolean): ToolSpec {
  const actions = canWrite ? [...ALL_ACTIONS] : [...READ_ONLY_ACTIONS];
  const description = canWrite
    ? 'Drive a real local browser (headless Chrome or Edge) like a person would: open a page, read its text, click, type, press keys, screenshot. Open: {"action":"open","url":"https://example.com"}. Read the current page: {"action":"read"}. Click: {"action":"click","selector":"#submit"}. Type (submit:true sends the surrounding form): {"action":"type","selector":"input[name=q]","text":"hello","submit":true}. Press a key: {"action":"press","key":"Enter"}. Screenshot: {"action":"shot"}. Back: {"action":"back"}. Close: {"action":"close"}. Local and private addresses are welcome (dev servers); http/https only. The browser closes itself after ten idle minutes.'
    : 'Open and read real pages with a local headless browser (Chrome or Edge). Open: {"action":"open","url":"https://example.com"}. Read the current page: {"action":"read"}. Screenshot: {"action":"shot"}. Back: {"action":"back"}. Close: {"action":"close"}. Local and private addresses are welcome (dev servers); http/https only. Clicking, typing and keys need an editing mode.';
  return {
    name: "browser",
    description,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: actions },
        url: { type: "string", description: 'Page address for "open" (http/https)' },
        selector: { type: "string", description: 'CSS selector for "click" and "type", e.g. "#login" or "input[name=q]"' },
        text: { type: "string", description: 'Text to type (for "type")' },
        key: { type: "string", description: 'Key to press: Enter, Tab, Escape, Backspace or an arrow (for "press")' },
        submit: { type: "boolean", description: 'For "type": submit the surrounding form after filling' },
      },
      required: ["action"],
    },
  };
}

function short(value: unknown, max = 80): string {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Run one browser action. Never throws: failures come back as text. */
export async function runBrowser(ctx: BrowserCtx, args: Record<string, any>): Promise<string> {
  const action = String(args.action ?? "")
    .trim()
    .toLowerCase();
  const mutating = action === "click" || action === "type" || action === "press";
  if (mutating && ctx.canWrite === false) {
    return "Error: cliquer, saisir ou presser modifie la page — indisponible en mode lecture seule. Passez d'abord en mode édition.";
  }
  if (!(ALL_ACTIONS as readonly string[]).includes(action)) {
    return 'Error: l\'action doit être "open", "read", "click", "type", "press", "shot", "back" ou "close". Exemple : {"action": "read"}';
  }
  const url = String(args.url ?? "").trim();
  const selector = String(args.selector ?? "").trim();
  if (action === "open" && !url) {
    return 'Error: "url" est requis pour ouvrir une page. Exemple : {"action": "open", "url": "https://example.com"}';
  }
  if ((action === "click" || action === "type") && !selector) {
    return `Error: "selector" est requis pour l'action ${action}. Exemple : {"action":"click","selector":"#valider"}`;
  }
  if (action === "type" && typeof args.text !== "string") {
    return 'Error: "text" est requis pour l\'action type. Exemple : {"action":"type","selector":"#nom","text":"Jean"}';
  }
  const key = String(args.key ?? "").trim();
  if (action === "press" && !key) {
    return 'Error: "key" est requis pour l\'action press. Exemple : {"action":"press","key":"Enter"}';
  }
  ctx.browser ??= new BrowserSession(ctx.browserNotify);
  const browser = ctx.browser;
  try {
    switch (action) {
      case "open": {
        const info = await browser.open(url);
        return `Page ouverte : « ${info.title || "(sans titre)"} » — ${info.url}\nPour lire son contenu : {"action": "read"}.`;
      }
      case "read": {
        const info = await browser.read();
        const body = info.text || "(page vide)";
        const note = info.truncated ? `\n\n[…texte tronqué à ${BROWSER_READ_CAP} caractères — la page continue au-delà.]` : "";
        return `${info.title || "(sans titre)"} — ${info.url}\n\n${body}${note}`;
      }
      case "click": {
        const res = await browser.click(selector);
        if (!res.ok) return `Error: aucun élément ne correspond à « ${selector} ».`;
        return `Clic effectué sur <${res.tag}>${res.text ? ` « ${res.text} »` : ""}.`;
      }
      case "type": {
        const res = await browser.type(selector, String(args.text), args.submit === true);
        if (!res.ok) return `Error: aucun élément ne correspond à « ${selector} ».`;
        return `Texte saisi dans <${res.tag}>${res.submitted ? " puis formulaire envoyé" : ""}.`;
      }
      case "press": {
        await browser.press(key);
        return `Touche « ${key} » pressée.`;
      }
      case "shot": {
        const shot = await browser.screenshot(ctx.workspace);
        return `Capture d'écran enregistrée : ${shot.rel} (${Math.max(1, Math.round(shot.bytes / 1024))} Ko).`;
      }
      case "back": {
        const info = await browser.back();
        return `Retour arrière : « ${info.title || "(sans titre)"} » — ${info.url}`;
      }
      case "close": {
        await browser.close();
        ctx.browser = undefined;
        return "Navigateur fermé.";
      }
      default:
        return `Error: action inconnue « ${short(action)} ». Exemple : {"action": "read"}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

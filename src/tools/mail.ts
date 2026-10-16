/**
 * Outil `mail` : lire la vraie boîte de réception et envoyer de vrais
 * e-mails via la configuration locale (~/.smolcoder/connectors.json,
 * `smol mail setup`). Aucun compte de démonstration, aucun faux serveur :
 * si la boîte n'est pas configurée, l'outil le dit honnêtement.
 */

import { formatMailList, formatMailMessage, listInbox, mailNotConfiguredMessage, readMessage, sendMailNow } from "../mail";
import type { ToolSpec } from "../providers/types";

export function mailTool(canWrite: boolean): ToolSpec {
  const actions = canWrite ? ["list", "read", "send"] : ["list", "read"];
  return {
    name: "mail",
    description: canWrite
      ? 'Real mailbox (set up via `smol mail setup`): list (inbox newest first), read (message uid), send (asks approval). Unconfigured → relay the setup hint; never invent messages.'
      : 'Read the real mailbox (set up via `smol mail setup`): list, read. Unconfigured → relay the setup hint; never invent messages.',
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: actions },
        uid: { type: "number", description: "Message (read)" },
        limit: { type: "number", description: "Count (list)" },
        to: { type: "string", description: "Recipient" },
        subject: { type: "string" },
        body: { type: "string" },
        cc: { type: "string" },
      },
      required: ["action"],
    },
  };
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runMail(args: Record<string, any>): Promise<string> {
  const action = String(args?.action ?? "").trim();
  try {
    if (action === "list") {
      return formatMailList(await listInbox(Number(args?.limit) || 10));
    }
    if (action === "read") {
      const uid = Number(args?.uid);
      if (!Number.isFinite(uid) || uid <= 0) {
        return 'Error: "uid" is required for read — use the message number from list.';
      }
      return formatMailMessage(await readMessage(uid));
    }
    if (action === "send") {
      const to = String(args?.to ?? "").trim();
      const subject = String(args?.subject ?? "").trim();
      const body = String(args?.body ?? "");
      if (!to || !subject || !body) {
        return 'Error: send needs "to", "subject" and "body".';
      }
      return await sendMailNow({ to, subject, text: body, cc: String(args?.cc ?? "").trim() || undefined });
    }
    return 'Error: l\'action doit être "list", "read" ou "send". Exemple : {"action": "list"}';
  } catch (e) {
    const message = reason(e);
    if (message === mailNotConfiguredMessage()) return message;
    return `Error: ${message}`;
  }
}

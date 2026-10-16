/**
 * Outil `calendar` : consulter et créer de vrais événements sur l'agenda
 * CalDAV configuré (~/.smolcoder/connectors.json, `smol calendar setup`).
 * Si l'agenda n'est pas configuré, l'outil le dit honnêtement.
 */

import { createEvent, formatEventList, listEvents } from "../calendar";
import type { ToolSpec } from "../providers/types";

const NOT_CONFIGURED = "l'agenda n'est pas configuré";

export function calendarTool(canWrite: boolean): ToolSpec {
  const actions = canWrite ? ["list", "create"] : ["list"];
  return {
    name: "calendar",
    description: canWrite
      ? "Real CalDAV agenda (set up via `smol calendar setup`): list (upcoming), create (asks approval). Unconfigured → relay the setup hint; never invent events."
      : "Read the real agenda (set up via `smol calendar setup`): list upcoming. Unconfigured → relay the setup hint; never invent events.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: actions },
        days: { type: "number", description: "Days ahead (def 7)" },
        summary: { type: "string", description: "Title" },
        start: { type: "string", description: 'Start "2026-10-16 [09:00]"' },
        end: { type: "string", description: "End, same form" },
        location: { type: "string" },
        description: { type: "string" },
      },
      required: ["action"],
    },
  };
}

export async function runCalendar(args: Record<string, any>): Promise<string> {
  const action = String(args?.action ?? "").trim();
  try {
    if (action === "list") {
      return formatEventList(await listEvents(Number(args?.days) || 7));
    }
    if (action === "create") {
      const summary = String(args?.summary ?? "").trim();
      const start = String(args?.start ?? "").trim();
      if (!summary || !start) {
        return 'Error: create needs "summary" and "start" (e.g. "2026-10-16 09:00").';
      }
      return await createEvent({
        summary,
        start,
        end: String(args?.end ?? "").trim() || undefined,
        location: String(args?.location ?? "").trim() || undefined,
        description: String(args?.description ?? "").trim() || undefined,
      });
    }
    return 'Error: l\'action doit être "list" ou "create". Exemple : {"action": "list"}';
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.startsWith(NOT_CONFIGURED)) return message;
    return `Error: ${message}`;
  }
}

// AI inline continuation (Auto-Copilot PRO).
//
// One-shot, short, OpenAI-compatible "complete the rest of the line" call used
// as the ghost-text fallback when LSP word completion adds nothing useful. It
// never blocks the editor: the caller aborts or times out, and when no model
// can be reached the call resolves quickly with { ok: false }.
//
// Endpoint resolution order:
//   1. SMOLCODER_COMPLETION_BASE (+ KEY / MODEL) — any OpenAI-compatible
//      server (Kaggle GPU, vLLM, LM Studio remote…).
//   2. OPENROUTER_API_KEY — free ":free"-suffixed models by default.
//   3. GEMINI_API_KEY / GOOGLE_API_KEY — Gemini OpenAI-compatible API.
//   4. Local Ollama / LM Studio discovered by the normal model detector.
// A bearer key is only ever sent to the endpoint it was provided for, and the
// file path is confined to the workspace via the sandbox resolver.

import * as fs from "node:fs";
import { detectAll } from "./detect";
import { resolveInWorkspace } from "./sandbox";

export interface AiCompleteResult {
  ok: boolean;
  continuation?: string;
  source?: string;
  model?: string;
  error?: string;
}

export const AI_CONTEXT_LINES = 24;
export const AI_MAX_TOKENS = 64;
export const AI_TIMEOUT_MS = 1600;
export const AI_TEMPERATURE = 0.15;

export interface AiCompleteOptions {
  timeoutMs?: number;
  maxTokens?: number;
}

interface ResolvedEndpoint {
  /** OpenAI-compatible root, no trailing slash (…/v1). */
  baseUrl: string;
  model: string;
  apiKey?: string;
  source: string;
}

/** Human prompt: complete ONLY the current line, no explanation. */
export function buildCompletionPrompt(contextBefore: string, currentPrefix: string): string {
  return [
    "Tu es un moteur de complétion de code d'IDE. Complète UNIQUEMENT la fin",
    "de la ligne courante. Ne donne aucune explication, aucun commentaire,",
    "aucun bloc de code : réponds uniquement par le texte à insérer, sur UNE",
    "ligne, sans répéter le début déjà tapé.",
    "",
    "Contexte (lignes précédentes) :",
    "---",
    contextBefore === "" ? "(début de fichier)" : contextBefore,
    "---",
    "Ligne courante en cours de frappe :",
    currentPrefix === "" ? "(ligne vide)" : currentPrefix,
    "",
    "Complétion :",
  ].join("\n");
}

function endpointFromEnv(): ResolvedEndpoint | undefined {
  const base = process.env.SMOLCODER_COMPLETION_BASE?.trim();
  if (base) {
    return {
      baseUrl: base.replace(/\/+$/, ""),
      model: process.env.SMOLCODER_COMPLETION_MODEL?.trim() || "local-model",
      apiKey: process.env.SMOLCODER_COMPLETION_KEY?.trim() || undefined,
      source: "serveur configuré",
    };
  }
  const openrouter = process.env.OPENROUTER_API_KEY?.trim();
  if (openrouter) {
    return {
      baseUrl: "https://openrouter.ai/api/v1",
      model: process.env.SMOLCODER_COMPLETION_MODEL?.trim() || "meta-llama/llama-3.1-8b-instruct:free",
      apiKey: openrouter,
      source: "OpenRouter gratuit",
    };
  }
  const gemini = process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  if (gemini) {
    return {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: process.env.SMOLCODER_COMPLETION_MODEL?.trim() || "gemini-2.5-flash",
      apiKey: gemini,
      source: "Google Gemini",
    };
  }
  return undefined;
}

async function endpointFromLocal(): Promise<ResolvedEndpoint | undefined> {
  const models = await detectAll({ fast: true });
  const pick = models.find((m) => m.backend === "ollama" || m.backend === "lmstudio");
  if (!pick) return undefined;
  return {
    baseUrl: `${pick.baseUrl.replace(/\/+$/, "")}/v1`,
    model: pick.id,
    apiKey: pick.apiKey,
    source: pick.backend === "ollama" ? "Ollama local" : "LM Studio local",
  };
}

function cleanContinuation(raw: string): string {
  let s = raw
    .replace(/^\s*```[a-zA-Z-]*\s*/g, "")
    .replace(/\s*```\s*$/g, "")
    .trim();
  const nl = s.indexOf("\n");
  if (nl !== -1) s = s.slice(0, nl).trimEnd();
  s = s.replace(/^["'`]+/, "").replace(/["'`]+$/, "");
  return s.trim();
}

/** Trim a leading repetition of the last typed word when the model echoes it.
 * Only strips when the whole word was echoed back (the remainder is empty or
 * starts with a non-identifier character), so a fragment like "re" never eats
 * the start of a real continuation such as "return". */
export function stripEchoedPrefix(continuation: string, currentPrefix: string): string {
  const lastWord = (currentPrefix.match(/[A-Za-z0-9_$.]+$/) || [""])[0];
  if (lastWord.length >= 3 && continuation.startsWith(lastWord)) {
    const rest = continuation.slice(lastWord.length);
    if (rest === "" || !/^[A-Za-z0-9_$]/.test(rest)) return rest;
  }
  return continuation;
}

export async function aiComplete(
  root: string,
  relPath: string,
  line: number,
  col: number,
  opts: AiCompleteOptions = {}
): Promise<AiCompleteResult> {
  if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(col) || col < 1) {
    return { ok: false, error: "line et col doivent être des entiers >= 1" };
  }
  const timeoutMs = opts.timeoutMs ?? AI_TIMEOUT_MS;
  let abs: string;
  try {
    abs = resolveInWorkspace(root, relPath);
  } catch {
    return { ok: false, error: "chemin refusé" };
  }
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    return { ok: false, error: "fichier introuvable" };
  }
  const text = fs.readFileSync(abs, "utf8");
  const lines = text.split(/\r?\n/);
  const from = Math.max(0, line - 1 - AI_CONTEXT_LINES);
  const contextBefore = lines.slice(from, line - 1).join("\n");
  const currentPrefix = (lines[line - 1] ?? "").slice(0, Math.max(0, col - 1));
  if (!currentPrefix || currentPrefix.trim().length === 0) {
    return { ok: false, error: "ligne vide — rien à compléter" };
  }
  const prompt = buildCompletionPrompt(contextBefore, currentPrefix);

  const endpoint = endpointFromEnv() ?? (await endpointFromLocal());
  if (!endpoint) {
    return {
      ok: false,
      error:
        "aucun modèle de complétion disponible (définissez GEMINI_API_KEY, " +
        "OPENROUTER_API_KEY ou SMOLCODER_COMPLETION_BASE, ou lancez Ollama / LM Studio)",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(300, timeoutMs));
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;
    const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: endpoint.model,
        messages: [
          {
            role: "system",
            content: "Tu es une complétion de code d'IDE. Réponds uniquement par le texte à insérer, jamais d'explication.",
          },
          { role: "user", content: prompt },
        ],
        max_tokens: opts.maxTokens ?? AI_MAX_TOKENS,
        temperature: AI_TEMPERATURE,
        stream: false,
      }),
    });
    if (!res.ok) {
      return { ok: false, error: `modèle indisponible (HTTP ${res.status})`, source: endpoint.source, model: endpoint.model };
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string }; text?: string }>;
    };
    const raw = String(data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "");
    const cleaned = cleanContinuation(raw);
    if (!cleaned) {
      return { ok: false, error: "le modèle n'a rien renvoyé", source: endpoint.source, model: endpoint.model };
    }
    return {
      ok: true,
      continuation: stripEchoedPrefix(cleaned, currentPrefix),
      source: endpoint.source,
      model: endpoint.model,
    };
  } catch (err: any) {
    if (controller.signal.aborted) {
      return { ok: false, error: "délai dépassé", source: endpoint.source, model: endpoint.model };
    }
    return { ok: false, error: String(err?.message ?? err).slice(0, 300), source: endpoint.source, model: endpoint.model };
  } finally {
    clearTimeout(timer);
  }
}

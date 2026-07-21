/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { Step, WireContentPart, WireMessage, CacheControl } from "./types";

const EPHEMERAL: CacheControl = { type: "ephemeral" };

/** Rough token estimate (~4 chars/token) for a single step. */
export function stepTokens(s: Step): number {
  let chars = 0;
  if (s.kind === "user") {
    chars += s.text.length;
    for (const a of s.attachments || []) chars += a.kind === "image" ? 1200 : (a.data?.length || 0);
  } else if (s.kind === "assistant") {
    // thinking is UI-only — never sent on the wire (see buildMessages).
    chars += s.text?.length || 0;
    for (const c of s.calls || []) chars += (c.arguments?.length || 0) + (c.name?.length || 0) + 8;
  } else {
    chars += s.output?.length || 0;
    if (s.image) chars += 1200;
  }
  return Math.ceil(chars / 4) + 4;
}

/**
 * Trim oldest history so the built request fits `budgetTokens`. Always keeps the
 * system prompt and the final user turn (plus everything after it). Drops whole
 * leading steps from the oldest end; never leaves a kept window starting on a
 * tool-result (which would orphan it from its tool_call).
 */
export function fitStepsToBudget(steps: Step[], system: string, budgetTokens: number): Step[] {
  const sysTokens = Math.ceil(system.length / 4);
  let budget = budgetTokens - sysTokens;
  if (budget <= 0) return steps;

  // The last user turn onward is non-negotiable (the current request + its tools).
  let lastUserIdx = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].kind === "user") { lastUserIdx = i; break; }
  }

  const tail = steps.slice(lastUserIdx);
  let used = tail.reduce((n, s) => n + stepTokens(s), 0);

  // Walk backwards through the prefix, keeping recent steps while they fit.
  const kept: Step[] = [];
  for (let i = lastUserIdx - 1; i >= 0; i--) {
    const t = stepTokens(steps[i]);
    if (used + t > budget) break;
    used += t;
    kept.unshift(steps[i]);
  }
  // Don't start the kept prefix on a tool-result (orphaned from its tool_call).
  while (kept.length && kept[0].kind === "tool-result") {
    used -= stepTokens(kept[0]);
    kept.shift();
  }
  return [...kept, ...tail];
}

/** Total rough token estimate for a step list. */
export function stepsTokens(steps: Step[]): number {
  return steps.reduce((n, s) => n + stepTokens(s), 0);
}

/**
 * Split history for auto-compaction: `tail` = the most recent steps that fit
 * `keepTokens` (always at least the last user turn onward), `prefix` = the
 * older steps to summarize. The tail never starts on a tool-result.
 */
export function splitForCompaction(steps: Step[], keepTokens: number): { prefix: Step[]; tail: Step[] } {
  let lastUserIdx = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].kind === "user") { lastUserIdx = i; break; }
  }
  let used = stepsTokens(steps.slice(lastUserIdx));
  let cut = lastUserIdx;
  for (let i = lastUserIdx - 1; i >= 0; i--) {
    const t = stepTokens(steps[i]);
    if (used + t > keepTokens) break;
    used += t;
    cut = i;
  }
  while (cut < steps.length && steps[cut].kind === "tool-result") cut++;
  return { prefix: steps.slice(0, cut), tail: steps.slice(cut) };
}

/** Serialize steps to plain text for the summarizer (tool outputs truncated). */
export function stepsToTranscript(steps: Step[]): string {
  const out: string[] = [];
  for (const s of steps) {
    if (s.kind === "user") {
      out.push(`## User\n${s.text}`);
    } else if (s.kind === "assistant") {
      if (s.text) out.push(`## Assistant\n${s.text}`);
      for (const c of s.calls || []) out.push(`## Assistant tool call: ${c.name}\n${(c.arguments || "").slice(0, 400)}`);
    } else {
      out.push(`## Tool result (${s.name})\n${(s.output || "").slice(0, 600)}`);
    }
  }
  return out.join("\n\n");
}

export interface CursorContextBlocks {
  /** <user_info> + <rules> + <agent_skills> */
  userInfo: string;
  /** <open_and_recently_viewed_files> + <active_selection> */
  openFiles: string;
  /** Mode-specific reminder appended right after the live <user_query>. */
  reminder?: string;
  /** Stable per-run timestamp. A fresh Date each step would invalidate the
   *  cached query block on every model call within the run. */
  timestamp?: string;
}

/**
 * Build wire messages in Cursor's shape:
 * - system as a single cached text block
 * - the CURRENT (last) user turn is split into the cached context blocks
 *   (userInfo, openFiles) followed by a cached <timestamp>+<user_query> block,
 *   matching the exact request Cursor sends.
 */
export function buildMessages(system: string, steps: Step[], ctx?: CursorContextBlocks): WireMessage[] {
  const out: WireMessage[] = [
    { role: "system", content: [{ type: "text", text: system, cache_control: EPHEMERAL }] },
  ];

  // Index of the last user step, which carries the live context blocks.
  let lastUserIdx = -1;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].kind === "user") {
      lastUserIdx = i;
      break;
    }
  }

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind === "user") {
      const images = (s.attachments || []).filter((a) => a.kind === "image");
      const texts = (s.attachments || []).filter((a) => a.kind === "text");
      let textContent = s.text;
      for (const t of texts) {
        textContent += `\n\n<attached_file name="${t.name}">\n${t.data}\n</attached_file>`;
      }

      const isLive = i === lastUserIdx && !!ctx;
      const parts: WireContentPart[] = [];

      if (isLive) {
        if (ctx!.userInfo) {
          parts.push({ type: "text", text: ctx!.userInfo, cache_control: EPHEMERAL });
        }
        if (ctx!.openFiles) {
          parts.push({ type: "text", text: ctx!.openFiles, cache_control: EPHEMERAL });
        }
        parts.push({
          type: "text",
          text: `<timestamp>\n${ctx!.timestamp || new Date().toLocaleString()}\n</timestamp>\n<user_query>\n${textContent}\n</user_query>${ctx!.reminder ? `\n${ctx!.reminder}` : ""}`,
          cache_control: EPHEMERAL,
        });
        for (const img of images) {
          parts.push({ type: "image_url", image_url: { url: img.data } });
        }
        out.push({ role: "user", content: parts });
      } else if (images.length) {
        parts.push({ type: "text", text: textContent || "(see attached images)" });
        for (const img of images) {
          parts.push({ type: "image_url", image_url: { url: img.data } });
        }
        out.push({ role: "user", content: parts });
      } else {
        out.push({ role: "user", content: textContent });
      }
    } else if (s.kind === "assistant") {
      const msg: WireMessage = { role: "assistant", content: s.text || null };
      if (s.calls && s.calls.length) {
        msg.tool_calls = s.calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments || "{}" },
        }));
      }
      out.push(msg);
    } else {
      // Tool result. If it carries an image, send the content as an array
      // (text + image_url); provider.ts renders an Anthropic image block for
      // Anthropic and a trailing user image message for OpenAI.
      if (s.image) {
        const dataUrl = `data:${s.image.mime};base64,${s.image.base64}`;
        out.push({
          role: "tool",
          tool_call_id: s.callId,
          content: [
            { type: "text", text: s.output || "(image)" },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        });
      } else {
        out.push({ role: "tool", tool_call_id: s.callId, content: s.output });
      }
    }
  }
  return out;
}

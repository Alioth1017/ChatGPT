/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

// Conversation turn model + the streaming-event reducer. Shared by the extension
// host (authoritative state, runs in the background) and the webview (pure
// renderer). Keep this DOM/React-free so it can run in the host.

export type Mode = "agent" | "ask" | "plan" | "multitask" | "debug";

export type AgentEvent =
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "tool-call-started"; callId: string; name: string; input: any }
  | { type: "tool-call-args"; callId: string; argsText: string }
  | {
      type: "tool-call-completed";
      callId: string;
      name: string;
      status: "completed" | "error";
      result: string;
      diff?: string;
      startLine?: number;
      endLine?: number;
    }
  | { type: "run-status"; status: "running" | "finished" | "error" | "cancelled" }
  | { type: "usage"; promptTokens: number; completionTokens: number; totalTokens: number }
  | { type: "run-result"; text: string; durationMs: number }
  | { type: "subagent-event"; callId: string; event: AgentEvent }
  | { type: "mode-changed"; mode: Mode }
  | { type: "shell-notify"; message: string }
  | { type: "retry"; attempt: number; max: number; delayMs: number; error: string }
  | { type: "compaction"; status: "running" | "done" | "failed"; summary?: string }
  | { type: "max-steps"; steps: number }
  | { type: "error"; message: string };

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  /** Data URL for images, or raw text for text files. */
  data: string;
  kind: "image" | "text";
}

export interface ToolBlock {
  kind: "tool";
  callId: string;
  name: string;
  input: any;
  status: "running" | "completed" | "error";
  result?: string;
  diff?: string;
  startLine?: number;
  endLine?: number;
  /** For task (subagent) blocks: the nested read-only sub-chat stream. */
  subBlocks?: AssistantBlock[];
  subStatus?: "running" | "finished" | "error" | "cancelled";
}
export interface TextBlock {
  kind: "text";
  text: string;
}
export interface ThinkingBlock {
  kind: "thinking";
  text: string;
  startedAt?: number;
  endedAt?: number;
}
export interface ErrorBlock {
  kind: "error";
  message: string;
  /** When set, the run is retrying; shows a transient "retrying" notice. */
  retrying?: { attempt: number; max: number };
}
/** Context-compaction marker: earlier conversation was auto-summarized. */
export interface CompactionBlock {
  kind: "compaction";
  status: "running" | "done" | "failed";
  /** The generated summary (once done). */
  summary?: string;
}
/** Run paused at the step limit — chat shows a Continue button. */
export interface MaxStepsBlock {
  kind: "max-steps";
  steps: number;
  /** Set once the user continued (hides the button). */
  resumed?: boolean;
}
export type AssistantBlock = TextBlock | ThinkingBlock | ToolBlock | ErrorBlock | CompactionBlock | MaxStepsBlock;

export interface UserTurn {
  role: "user";
  text: string;
  attachments?: Attachment[];
  /** Model id this message was sent with (shown on the bubble). */
  model?: string;
  /** Mode this message was sent in. */
  mode?: string;
}

// Mentions live IN the message text as full self-describing tags:
//   <attached type="doc" title="Dodo" content="docs_dodo" />
// The exact same text is stored, edited, and sent to the AI — no translation.
// UI surfaces only *render* the tag (pill in bubbles/composer, @name in titles).
export const MENTION_TAG_RE = /<attached\s+([^>]*?)\/?>/g;

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const unescAttr = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&amp;/g, "&");

/** Build the <attached /> tag for a mention. */
export function mentionTag(kind: string, name: string, path: string): string {
  return `<attached type="${escAttr(kind)}" title="${escAttr(name)}" content="${escAttr(path)}" />`;
}

function attrsOf(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = unescAttr(m[2]);
  return out;
}

/** Extract mention objects from a message's <attached /> tags. */
export function parseMentionTokens(text: string): { kind: string; name: string; path: string }[] {
  const out: { kind: string; name: string; path: string }[] = [];
  for (const m of text.matchAll(MENTION_TAG_RE)) {
    const a = attrsOf(m[1]);
    out.push({ kind: a.type || "file", name: a.title || a.content || "", path: a.content || "" });
  }
  return out;
}

/**
 * Render <attached /> tags for a UI surface:
 * "html":    inline pill markup inside message bubbles.
 * "display": short plain text "@name" (titles, queue rows, previews).
 * The AI gets the raw text with the tags untouched.
 */
export function renderMentionTokens(text: string, target: "display" | "html" = "display"): string {
  return text.replace(MENTION_TAG_RE, (_s, attrs) => {
    const a = attrsOf(attrs);
    const name = a.title || a.content || "";
    if (target === "html") {
      return `<span class="mention-chip" data-kind="${escAttr(a.type || "file")}" title="${escAttr(a.content || "")}">@${escAttr(name)}</span>`;
    }
    return `@${name}`;
  });
}
export interface AssistantTurn {
  role: "assistant";
  blocks: AssistantBlock[];
}
export type Turn = UserTurn | AssistantTurn;

// Best-effort parse of a partial JSON tool-arg string so the tool card can show
// fields (path, content, command…) as they stream. Falls back to the previous
// input when nothing parseable is available yet.
export function parsePartialArgs(argsText: string, prev: unknown): unknown {
  const t = argsText.trim();
  if (!t) return prev ?? {};
  try {
    return JSON.parse(t);
  } catch {
    try {
      let s = t;
      const quotes = (s.match(/(?<!\\)"/g) || []).length;
      if (quotes % 2 === 1) s += '"';
      const opens = (s.match(/\{/g) || []).length;
      const closes = (s.match(/\}/g) || []).length;
      s += "}".repeat(Math.max(0, opens - closes));
      return JSON.parse(s);
    } catch {
      return prev ?? {};
    }
  }
}

// Merge a streaming event into a flat block list (used for both the main turn
// and a subagent's nested sub-chat). Returns a fresh copy.
export function applyToBlocks(blocksIn: AssistantBlock[], ev: AgentEvent): AssistantBlock[] {
  const blocks = [...blocksIn];
  const last = blocks[blocks.length - 1];
  if (ev.type === "text-delta") {
    if (last && last.kind === "thinking" && !last.endedAt) blocks[blocks.length - 1] = { ...last, endedAt: Date.now() };
    const tail = blocks[blocks.length - 1];
    if (tail && tail.kind === "text") blocks[blocks.length - 1] = { kind: "text", text: tail.text + ev.text };
    else blocks.push({ kind: "text", text: ev.text });
  } else if (ev.type === "thinking-delta") {
    if (last && last.kind === "thinking") blocks[blocks.length - 1] = { ...last, text: last.text + ev.text };
    else blocks.push({ kind: "thinking", text: ev.text, startedAt: Date.now() });
    return blocks;
  } else if (ev.type === "tool-call-started") {
    if (last && last.kind === "thinking" && !last.endedAt) blocks[blocks.length - 1] = { ...last, endedAt: Date.now() };
    const existing = blocks.findIndex((b) => b.kind === "tool" && b.callId === ev.callId);
    if (existing >= 0) blocks[existing] = { ...blocks[existing], name: ev.name, input: ev.input } as AssistantBlock;
    else blocks.push({ kind: "tool", callId: ev.callId, name: ev.name, input: ev.input, status: "running" });
  } else if (ev.type === "tool-call-args") {
    return blocks.map((b) =>
      b.kind === "tool" && b.callId === ev.callId ? { ...b, input: parsePartialArgs(ev.argsText, b.input) } : b
    );
  } else if (ev.type === "tool-call-completed") {
    return blocks.map((b) =>
      b.kind === "tool" && b.callId === ev.callId
        ? { ...b, status: ev.status, result: ev.result, diff: ev.diff, startLine: ev.startLine, endLine: ev.endLine }
        : b
    );
  } else if (ev.type === "retry") {
    const note: ErrorBlock = { kind: "error", message: ev.error, retrying: { attempt: ev.attempt, max: ev.max } };
    if (last && last.kind === "error") blocks[blocks.length - 1] = note;
    else blocks.push(note);
  } else if (ev.type === "error") {
    const note: ErrorBlock = { kind: "error", message: ev.message };
    if (last && last.kind === "error") blocks[blocks.length - 1] = note;
    else blocks.push(note);
  } else if (ev.type === "compaction") {
    const note: CompactionBlock = { kind: "compaction", status: ev.status, summary: ev.summary };
    if (last && last.kind === "compaction" && last.status === "running") blocks[blocks.length - 1] = note;
    else blocks.push(note);
  } else if (ev.type === "max-steps") {
    blocks.push({ kind: "max-steps", steps: ev.steps });
  }
  return blocks;
}

// Apply a streaming agent event to the turns array (immutably).
export function applyEvent(turns: Turn[], ev: AgentEvent): Turn[] {
  const ensureAssistant = (list: Turn[]): { list: Turn[]; turn: AssistantTurn } => {
    const last = list[list.length - 1];
    if (last && last.role === "assistant") {
      const cloned: AssistantTurn = { role: "assistant", blocks: [...last.blocks] };
      return { list: [...list.slice(0, -1), cloned], turn: cloned };
    }
    const turn: AssistantTurn = { role: "assistant", blocks: [] };
    return { list: [...list, turn], turn };
  };

  const dropRetryNote = (turn: AssistantTurn) => {
    const last = turn.blocks[turn.blocks.length - 1];
    if (last && last.kind === "error" && last.retrying) turn.blocks.pop();
  };

  const closeThinking = (turn: AssistantTurn) => {
    const last = turn.blocks[turn.blocks.length - 1];
    if (last && last.kind === "thinking" && !last.endedAt) turn.blocks[turn.blocks.length - 1] = { ...last, endedAt: Date.now() };
  };

  if (ev.type === "text-delta") {
    const { list, turn } = ensureAssistant(turns);
    dropRetryNote(turn);
    closeThinking(turn);
    const lastBlock = turn.blocks[turn.blocks.length - 1];
    if (lastBlock && lastBlock.kind === "text") {
      turn.blocks[turn.blocks.length - 1] = { kind: "text", text: lastBlock.text + ev.text };
    } else {
      turn.blocks.push({ kind: "text", text: ev.text });
    }
    return list;
  }

  if (ev.type === "thinking-delta") {
    const { list, turn } = ensureAssistant(turns);
    dropRetryNote(turn);
    const lastBlock = turn.blocks[turn.blocks.length - 1];
    if (lastBlock && lastBlock.kind === "thinking") {
      turn.blocks[turn.blocks.length - 1] = { ...lastBlock, text: lastBlock.text + ev.text };
    } else {
      turn.blocks.push({ kind: "thinking", text: ev.text, startedAt: Date.now() });
    }
    return list;
  }

  if (ev.type === "tool-call-started") {
    const { list, turn } = ensureAssistant(turns);
    closeThinking(turn);
    const existing = turn.blocks.findIndex((b) => b.kind === "tool" && b.callId === ev.callId);
    if (existing >= 0) {
      turn.blocks[existing] = { ...turn.blocks[existing], name: ev.name, input: ev.input } as AssistantBlock;
    } else {
      turn.blocks.push({ kind: "tool", callId: ev.callId, name: ev.name, input: ev.input, status: "running" });
    }
    return list;
  }

  if (ev.type === "tool-call-args") {
    const { list, turn } = ensureAssistant(turns);
    turn.blocks = turn.blocks.map((b) =>
      b.kind === "tool" && b.callId === ev.callId ? { ...b, input: parsePartialArgs(ev.argsText, b.input) } : b
    );
    return list;
  }

  if (ev.type === "tool-call-completed") {
    const { list, turn } = ensureAssistant(turns);
    turn.blocks = turn.blocks.map((b) =>
      b.kind === "tool" && b.callId === ev.callId
        ? { ...b, status: ev.status, result: ev.result, diff: ev.diff, startLine: ev.startLine, endLine: ev.endLine }
        : b
    );
    return list;
  }

  if (ev.type === "retry") {
    const { list, turn } = ensureAssistant(turns);
    const last = turn.blocks[turn.blocks.length - 1];
    const note = { kind: "error" as const, message: ev.error, retrying: { attempt: ev.attempt, max: ev.max } };
    if (last && last.kind === "error") turn.blocks[turn.blocks.length - 1] = note;
    else turn.blocks.push(note);
    return list;
  }

  if (ev.type === "error") {
    const { list, turn } = ensureAssistant(turns);
    const last = turn.blocks[turn.blocks.length - 1];
    const block = { kind: "error" as const, message: ev.message };
    if (last && last.kind === "error") turn.blocks[turn.blocks.length - 1] = block;
    else turn.blocks.push(block);
    return list;
  }

  if (ev.type === "compaction") {
    const { list, turn } = ensureAssistant(turns);
    const last = turn.blocks[turn.blocks.length - 1];
    const block: CompactionBlock = { kind: "compaction", status: ev.status, summary: ev.summary };
    if (last && last.kind === "compaction" && last.status === "running") turn.blocks[turn.blocks.length - 1] = block;
    else turn.blocks.push(block);
    return list;
  }

  if (ev.type === "max-steps") {
    const { list, turn } = ensureAssistant(turns);
    closeThinking(turn);
    turn.blocks.push({ kind: "max-steps", steps: ev.steps });
    return list;
  }

  if (ev.type === "subagent-event") {
    const { list, turn } = ensureAssistant(turns);
    turn.blocks = turn.blocks.map((b) => {
      if (b.kind !== "tool" || b.callId !== ev.callId) return b;
      const child = ev.event;
      const next = { ...b };
      if (child.type === "run-status") next.subStatus = child.status;
      else if (child.type === "run-result") {/* final summary lands in tool result */}
      else next.subBlocks = applyToBlocks(b.subBlocks ?? [], child);
      return next;
    });
    return list;
  }

  return turns;
}

/** Mark every still-open tool / subagent / thinking block as cancelled or closed. */
export function forceSettleOpenWork(turns: Turn[], reason: "cancelled" | "error" = "cancelled"): Turn[] {
  const msg = reason === "error" ? "(error)" : "(cancelled)";
  const subSt = reason === "error" ? "error" : "cancelled";
  return turns.map((turn) => {
    if (turn.role !== "assistant") return turn;
    let changed = false;
    const blocks = turn.blocks.map((b) => {
      if (b.kind === "thinking" && !b.endedAt) {
        changed = true;
        return { ...b, endedAt: Date.now() };
      }
      if (b.kind === "tool") {
        let next: ToolBlock = b;
        if (b.status === "running") {
          changed = true;
          next = { ...next, status: "error", result: b.result || msg };
        }
        const isTask = b.name === "Task" || b.name === "task";
        if (b.subStatus === "running" || (next.status === "error" && isTask && !b.subStatus)) {
          changed = true;
          next = { ...next, subStatus: subSt as ToolBlock["subStatus"] };
        }
        if (next.subBlocks?.length) {
          const nested = forceSettleOpenWork([{ role: "assistant", blocks: next.subBlocks }], reason)[0] as AssistantTurn;
          if (nested.blocks !== next.subBlocks) {
            changed = true;
            next = { ...next, subBlocks: nested.blocks };
          }
        }
        return next;
      }
      if (b.kind === "compaction" && b.status === "running") {
        changed = true;
        return { ...b, status: "failed" as const };
      }
      return b;
    });
    return changed ? { role: "assistant" as const, blocks } : turn;
  });
}

/** Close any still-open trailing thinking block (run settled). */
export function closeTrailingThinking(turns: Turn[]): Turn[] {
  const lt = turns[turns.length - 1];
  if (lt && lt.role === "assistant") {
    const lb = lt.blocks[lt.blocks.length - 1];
    if (lb && lb.kind === "thinking" && !lb.endedAt) {
      const cloned: AssistantTurn = { role: "assistant", blocks: [...lt.blocks.slice(0, -1), { ...lb, endedAt: Date.now() }] };
      return [...turns.slice(0, -1), cloned];
    }
  }
  return turns;
}

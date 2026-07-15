/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

export type Mode = "agent" | "ask" | "plan" | "multitask" | "debug";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  data: string;
  kind: "image" | "text";
}

/** An image produced by a tool (e.g. Read on a PNG), carried to the model. */
export interface ToolImage {
  mime: string;
  base64: string;
}

export type Step =
  | { kind: "user"; text: string; attachments?: Attachment[] }
  | { kind: "assistant"; text: string; thinking?: string; calls: ToolCall[] }
  | { kind: "tool-result"; callId: string; name: string; output: string; status: "completed" | "error"; image?: ToolImage };

export interface ToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: object };
}

export interface CacheControl {
  type: "ephemeral";
}

export type WireContentPart =
  | { type: "text"; text: string; cache_control?: CacheControl }
  | { type: "image_url"; image_url: { url: string }; cache_control?: CacheControl };

export type WireMessage =
  | { role: "system"; content: string | WireContentPart[] }
  | { role: "user"; content: string | WireContentPart[] }
  | { role: "assistant"; content: string | null; tool_calls?: WireToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string | WireContentPart[] };

export interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ProviderEvent =
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  // Streaming tool-call progress: fires when a call first appears (name known)
  | { type: "tool-call-start"; index: number; id: string; name: string }
  // ...and as its JSON arguments arrive in chunks.
  | { type: "tool-call-args-delta"; index: number; delta: string }
  | { type: "tool-call"; call: ToolCall }
  | { type: "usage"; promptTokens?: number; completionTokens?: number }
  | { type: "done"; finishReason: string };

export type AgentEvent =
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "tool-call-started"; callId: string; name: string; input: unknown; timeoutMs?: number; startedAt?: number }
  // Live JSON-arg streaming for a started call (UI parses partial input).
  | { type: "tool-call-args"; callId: string; argsText: string }
  | { type: "tool-call-completed"; callId: string; name: string; status: "completed" | "error"; result: string; diff?: string; startLine?: number; endLine?: number }
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

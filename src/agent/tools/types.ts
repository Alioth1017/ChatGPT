/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { ToolSchema, Mode } from "../types";
import { TOOL_SPECS } from "./schemas";

export interface ToolResult {
  output: string;
  diff?: string;
  startLine?: number;
  endLine?: number;
  /** An image the tool returns (e.g. Read on a PNG), forwarded to the model. */
  image?: { mime: string; base64: string };
}

/** Per-run context so concurrent agent runs don't clobber each other's hooks. */
export interface ToolContext {
  runSubagent?: SubagentRunner;
  askUser?: QuestionAsker;
  /** Switch the active mode mid-run (used by the SwitchMode tool). */
  switchMode?: (mode: Mode) => string;
  /** Current active mode (mutable across the run); read by tools for gating. */
  getMode?: () => Mode;
  /** Key identifying this run's persistent shell session (cwd/env persist). */
  shellSessionKey?: string;
  /** Emit a notify_on_output match to the UI (set by the loop). */
  emitShellNotify?: (text: string) => void;
}

export interface Tool {
  schema: ToolSchema;
  mutating: boolean;
  execute(input: any, abortSignal?: AbortSignal, callId?: string, ctx?: ToolContext): Promise<ToolResult>;
}

/** Extra schema-defined options threaded through to a subagent run. */
export interface SubagentOptions {
  /** Model slug to run the subagent with. */
  model?: string;
  /** Run detached in the background (returns immediately with a handle note). */
  runInBackground?: boolean;
  /** Human-friendly title shown in the UI. */
  description?: string;
  /** File paths (images/videos) to attach to the subagent's context. */
  fileAttachments?: string[];
  /** Resume an existing agent by id (or "self" to fork the parent). */
  resume?: string;
  /** Interrupt a running resumed agent. */
  interrupt?: boolean;
}

/** Injected by the agent loop (avoids a circular import with loop.ts). */
export type SubagentRunner = (
  prompt: string,
  readonly: boolean,
  subagentName?: string,
  signal?: AbortSignal,
  callId?: string,
  opts?: SubagentOptions
) => Promise<string>;

export interface AskQuestionItem {
  question: string;
  options?: string[];
  multiple?: boolean;
}
export type QuestionAsker = (
  callId: string,
  header: string | undefined,
  questions: AskQuestionItem[],
  signal?: AbortSignal
) => Promise<Record<string, string[]>>;

/**
 * Build a Tool. The name/description/parameters always come from the spec in
 * `schemas.ts` (single source of truth) — handler files only provide the name
 * + behaviour, never their own schema.
 */
export function defineTool(name: string, mutating: boolean, execute: Tool["execute"]): Tool {
  const s = TOOL_SPECS[name];
  if (!s) {
    throw new Error(`No tool spec for "${name}" (add it to schemas.ts)`);
  }
  return {
    mutating,
    schema: { type: "function", function: { name: s.name, description: s.description, parameters: s.parameters } },
    execute,
  };
}

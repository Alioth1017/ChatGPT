/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { Mode } from "../types";
import type { Tool } from "./types";

import { readFileTool, listDirTool, globTool, fileSearchTool, readLintsTool, strReplaceTool, writeTool, deleteFileTool, editNotebookTool } from "./files";
import { grepTool, semanticSearchTool, searchDocsTool } from "./search";
import { runTerminalTool, awaitShellTool } from "./shell";
import { webSearchTool, webFetchTool } from "./web";
import { todoWriteTool, todoReadTool, askQuestionTool, taskTool, switchModeTool, writePlanTool } from "./agent";
import { callMcpToolTool, fetchMcpResourceTool, listMcpResourcesTool } from "./mcp";

// Public surface re-exported so the rest of the app keeps importing from "./tools".
export * from "./types";
export { TOOL_SPECS, type ToolSpec } from "./schemas";
export {
  resetTodos,
  getTodos,
  setSubagentRunner,
  setQuestionAsker,
  disposeShellSession,
  toolTimeoutMs,
  withToolTimeout,
  setToolTimeoutOverrides,
  DEFAULT_TOOL_TIMEOUTS_SEC,
  type TodoItem,
} from "./shared";

// All tools. Names/descriptions/schemas come from schemas.ts via defineTool,
// so this map is purely "tool name -> handler".
export const TOOLS: Record<string, Tool> = {
  Read: readFileTool,
  ListDir: listDirTool,
  Glob: globTool,
  Grep: grepTool,
  SemanticSearch: semanticSearchTool,
  SearchDocs: searchDocsTool,
  FileSearch: fileSearchTool,
  ReadLints: readLintsTool,
  TodoWrite: todoWriteTool,
  TodoRead: todoReadTool,
  WebSearch: webSearchTool,
  WebFetch: webFetchTool,
  Task: taskTool,
  AskQuestion: askQuestionTool,
  WritePlan: writePlanTool,
  StrReplace: strReplaceTool,
  Write: writeTool,
  Delete: deleteFileTool,
  Shell: runTerminalTool,
  AwaitShell: awaitShellTool,
  EditNotebook: editNotebookTool,
  CallMcpTool: callMcpToolTool,
  FetchMcpResource: fetchMcpResourceTool,
  ListMcpResources: listMcpResourcesTool,
  SwitchMode: switchModeTool,
};

// Mutating tools (loop uses these for approval gating / serialized execution).
export const MUTATING_TOOLS = new Set(["StrReplace", "Write", "Delete", "Shell", "EditNotebook"]);
// File-editing tools (loop uses these for the auto-edit gate + afterEdit hook).
export const EDIT_TOOLS = new Set(["StrReplace", "Write", "Delete", "EditNotebook"]);
// WritePlan is exclusive to plan mode; it must never surface in agent/ask.
const PLAN_ONLY = new Set(["WritePlan"]);

// Multitask is a coordinator: it delegates to subagents (Task), manages todos,
// and may read/search — but it must never mutate files or the shell itself.
const MULTITASK_BLOCKED = new Set(["StrReplace", "Write", "Delete", "EditNotebook", "Shell"]);
export const MULTITASK_TOOLS = new Set(
  Object.keys(TOOLS).filter((name) => !MULTITASK_BLOCKED.has(name) && !PLAN_ONLY.has(name)),
);

export function toolsForMode(mode: Mode): Tool[] {
  return Object.entries(TOOLS)
    .filter(([name, t]) => {
      if (PLAN_ONLY.has(name)) return mode === "plan";
      if (mode === "multitask") return MULTITASK_TOOLS.has(name);
      // ask + plan are read-only: no mutating tools. agent/debug: everything.
      return mode === "agent" || mode === "debug" ? true : !t.mutating;
    })
    .map(([, t]) => t);
}

export const schemasForMode = (mode: Mode) => toolsForMode(mode).map((t) => t.schema);

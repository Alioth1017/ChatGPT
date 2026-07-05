/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as fs from "fs/promises";
import * as path from "path";
import type { Mode } from "../types";
import { getWorkspaceRoot } from "../../context/workspaceUtils";
import { pendingChanges } from "../../stores/pendingChanges";
import { defineTool, type AskQuestionItem } from "./types";
import {
  getSubagentRunner,
  getQuestionAsker,
  getTodos,
  setTodos,
  slugify,
  makeDiff,
  firstDiffLine,
  type TodoItem,
} from "./shared";

// ---- TodoWrite ----
export const todoWriteTool = defineTool("TodoWrite", false, async (input) => {
  const incoming: TodoItem[] = Array.isArray(input.todos) ? input.todos : [];
  if (input.merge) {
    const byId = new Map(getTodos().map((t) => [t.id, t]));
    for (const t of incoming) byId.set(t.id, { ...byId.get(t.id), ...t });
    setTodos([...byId.values()]);
  } else {
    setTodos(incoming);
  }
  const render = getTodos()
    .map((t) => {
      const mark =
        t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[~]" : t.status === "cancelled" ? "[-]" : "[ ]";
      return `${mark} ${t.content}`;
    })
    .join("\n");
  return { output: `Updated todos:\n${render}` };
});

// ---- TodoRead ----
export const todoReadTool = defineTool("TodoRead", false, async () => {
  const todos = getTodos();
  if (!todos.length) return { output: "(no todos)" };
  return { output: todos.map((t) => `- [${t.status}] ${t.content}`).join("\n") };
});

// ---- AskQuestion (interactive wizard form in the chat UI) ----
export const askQuestionTool = defineTool("AskQuestion", false, async (input, abortSignal, callId, ctx) => {
  const asker = ctx?.askUser ?? getQuestionAsker();
  if (!asker) return { output: "error: cannot ask questions in this context" };

  // Cursor shape: questions:[{id, prompt, options:[{id,label}], allow_multiple}], title.
  // Back-compat: also accept {question, options:[string], multiple} and header.
  const questions: AskQuestionItem[] = Array.isArray(input?.questions)
    ? input.questions
        .map((q: any) => ({
          question: String(q?.prompt ?? q?.question ?? ""),
          options: Array.isArray(q?.options)
            ? q.options.map((o: any) => (typeof o === "string" ? o : String(o?.label ?? o?.id ?? "")))
            : undefined,
          multiple: !!(q?.allow_multiple ?? q?.multiple),
        }))
        .filter((q: AskQuestionItem) => q.question)
    : [];
  if (!questions.length) return { output: "error: no questions provided" };

  try {
    const answers = await asker(callId || "", input?.title ?? input?.header ? String(input.title ?? input.header) : undefined, questions, abortSignal);
    const lines = questions.map((q, i) => {
      const a = answers[String(i)] ?? answers[q.question] ?? [];
      return `Q${i + 1}: ${q.question}\nA: ${a.length ? a.join(", ") : "(skipped)"}`;
    });
    return { output: "The user answered:\n\n" + lines.join("\n\n") };
  } catch (e: any) {
    if (e?.name === "AbortError") return { output: "error: cancelled" };
    return { output: "error: " + String(e?.message || e) };
  }
});

// ---- Task (launch a subagent) ----
export const taskTool = defineTool("Task", false, async (input, abortSignal, callId, ctx) => {
  const runner = ctx?.runSubagent ?? getSubagentRunner();
  if (!runner) return { output: "error: subagents are not available" };
  // Read-only subagent types or an explicit readonly flag run in ask mode.
  const roTypes = new Set(["explore", "cursor-guide", "docs-researcher", "code-reviewer", "bugbot", "security-review", "ci-investigator"]);
  const subType = String(input.subagent_type || "");
  const readonly = input.readonly === true || roTypes.has(subType);
  const subName = subType || undefined;
  const fileAttachments = Array.isArray(input.file_attachments)
    ? input.file_attachments.map((f: any) => String(f))
    : undefined;
  const result = await runner(String(input.prompt || ""), readonly, subName, abortSignal, callId, {
    model: input.model ? String(input.model) : undefined,
    runInBackground: input.run_in_background === true,
    description: input.description ? String(input.description) : undefined,
    fileAttachments,
    resume: input.resume ? String(input.resume) : undefined,
    interrupt: input.interrupt === true,
  });
  return { output: result };
});

// ---- SwitchMode ----
export const switchModeTool = defineTool("SwitchMode", false, async (input, _signal, _callId, ctx) => {
  const target = String(input?.target_mode_id ?? "").trim().toLowerCase();
  if (target !== "plan" && target !== "agent" && target !== "multitask" && target !== "debug") {
    return { output: "error: target_mode_id must be 'plan', 'agent', 'multitask', or 'debug'" };
  }
  if (!ctx?.switchMode) return { output: "error: mode switching is not available in this run" };
  return { output: ctx.switchMode(target as Mode) };
});

// ---- WritePlan (plan mode only) ----
export const writePlanTool = defineTool("WritePlan", false, async (input) => {
  const root = getWorkspaceRoot();
  const dir = path.join(root, ".plans");
  await fs.mkdir(dir, { recursive: true });
  const file = `${slugify(input.title)}.md`;
  const rel = `.plans/${file}`;
  const p = path.join(dir, file);
  const body = `# ${String(input.title || "Plan").trim()}\n\n${String(input.content || "").trim()}\n`;
  let existedBefore = false;
  let original = "";
  try {
    original = await fs.readFile(p, "utf8");
    existedBefore = true;
  } catch {}
  await fs.writeFile(p, body, "utf8");
  pendingChanges.record(rel, original, body, existedBefore);
  return {
    output: `wrote plan to ${rel}`,
    diff: makeDiff(rel, original, body),
    startLine: firstDiffLine(original, body),
  };
});

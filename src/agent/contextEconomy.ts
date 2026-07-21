/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { Step, ToolCall } from "./types";

/**
 * Token economy for long agent traces.
 *
 * Research-backed stack (2026):
 * - Stale tool-output eviction (SideQuest-style): 50–65% savings on tool-heavy runs
 * - Sliding-window + early compaction (~55% fill) vs waiting for 80–95%
 * - Never orphan tool_result from tool_call; never touch the live user turn
 * - Slim huge Write/StrReplace args once the edit is already applied
 *
 * UI keeps full tool cards via the turns store; this only shrinks model history.
 */

/** Exploration / dump tools — full body rarely needed after the next few steps. */
const STALEABLE = new Set([
  "Read",
  "Grep",
  "Glob",
  "SemanticSearch",
  "SearchDocs",
  "ListDir",
  "FileSearch",
  "WebFetch",
  "WebSearch",
  "Shell",
  "AwaitShell",
  "ReadLints",
  "ListMcpResources",
  "FetchMcpResource",
  "TodoRead",
  "CallMcpTool",
]);

/** Edit payloads: once applied, re-sending full old/new strings is pure waste. */
const SLIM_ARGS = new Set(["StrReplace", "Write", "EditNotebook", "Delete"]);

const PRUNE_MARK = "[context pruned]";

/** Keep this many most-recent tool results verbatim, including the active run. */
const KEEP_RECENT_RESULTS = 4;

/** Keep this many most-recent assistant tool-call batches with full args. */
const KEEP_RECENT_CALL_BATCHES = 2;

/** Only prune results larger than this (chars). */
const MIN_PRUNE_CHARS = 400;

/** Cap for slimmed string fields inside tool args. */
const SLIM_FIELD = 160;

function isPruned(s: string): boolean {
  return s.startsWith(PRUNE_MARK);
}

function stubResult(name: string, output: string, status: string): string {
  const n = output.length;
  const lines = output.split(/\r?\n/);
  const signal = lines.filter((line) =>
    /error|fail|exception|warning|warn|fatal|denied|timeout|not found|cannot|invalid|exit [1-9]|^\s*[-+]{3}|^\s*@@|^\s*\d+[|:]/i.test(line),
  );
  const evidence = (signal.length ? signal.slice(0, 8) : [...lines.slice(0, 3), ...lines.slice(-3)])
    .join("\n")
    .slice(0, 900)
    .trim();
  const pathHint =
    /(?:^|\n)(?:\d+\|)?([^\n]{0,80})/.exec(output)?.[1]?.trim() ||
    /(?:path|file)["']?\s*[:=]\s*["']?([^\s"']+)/i.exec(output)?.[1] ||
    "";
  const where = pathHint && pathHint.length < 80 ? ` · ${pathHint}` : "";
  return `${PRUNE_MARK} ${name}${where} · ${n} chars · ${status}. Re-call tool if needed.${evidence ? `\n${evidence}` : ""}`;
}

function slimValue(v: unknown, depth = 0): unknown {
  if (depth > 4) return "…";
  if (typeof v === "string") {
    if (v.length <= SLIM_FIELD) return v;
    return `${v.slice(0, SLIM_FIELD)}…[+${v.length - SLIM_FIELD} chars]`;
  }
  if (Array.isArray(v)) {
    if (v.length > 8) return [...v.slice(0, 6).map((x) => slimValue(x, depth + 1)), `…(+${v.length - 6})`];
    return v.map((x) => slimValue(x, depth + 1));
  }
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) {
      // Keep paths/ids intact for orientation.
      if (/^(path|id|callId|name|command|pattern|query)$/i.test(k) && typeof val === "string" && val.length < 500) {
        out[k] = val;
      } else {
        out[k] = slimValue(val, depth + 1);
      }
    }
    return out;
  }
  return v;
}

function slimCallArgs(name: string, args: string): string {
  if (!args || args.length < MIN_PRUNE_CHARS) return args;
  if (!SLIM_ARGS.has(name) && !name.startsWith("mcp__")) {
    // Non-edit tools: hard cap only if enormous.
    if (args.length < 2000) return args;
    return args.slice(0, 400) + `…[+${args.length - 400} chars pruned]`;
  }
  try {
    const parsed = JSON.parse(args);
    const slimmed = slimValue(parsed);
    return JSON.stringify(slimmed);
  } catch {
    return args.slice(0, 300) + `…[+${args.length - 300} chars pruned]`;
  }
}

/** Tools whose repeat calls on the same target supersede older results (latest wins). */
const DEDUP_TOOLS = new Set(["Read", "ListDir", "ReadLints", "Glob", "Grep", "SemanticSearch", "WebFetch", "TodoRead"]);

/** Stable dedup key for a tool call: name + primary target extracted from args. */
function dedupKey(name: string, args: string): string | undefined {
  if (!DEDUP_TOOLS.has(name)) return undefined;
  try {
    const a = JSON.parse(args || "{}") as Record<string, unknown>;
    const target = a.path ?? a.target_directory ?? a.url ?? a.glob_pattern ?? a.pattern ?? a.query;
    if (typeof target !== "string" || !target) return name === "TodoRead" ? name : undefined;
    // Read with explicit ranges targets different slices — keep them distinct.
    const range = a.offset != null || a.limit != null ? `#${a.offset ?? ""}:${a.limit ?? ""}` : "";
    return `${name}:${target}${range}`;
  } catch {
    return undefined;
  }
}

/**
 * Latest-wins dedup (GitAuto/Cline-style): when the same file/dir/url was read
 * multiple times, older copies become one-line supersede stubs. Removes both
 * redundant tokens AND stale-version ambiguity for the model.
 */
function dedupeRepeatedResults(steps: Step[]): number {
  // Map callId -> dedup key from the assistant call that issued it.
  const keyByCallId = new Map<string, string>();
  for (const s of steps) {
    if (s.kind !== "assistant") continue;
    for (const c of s.calls || []) {
      const k = dedupKey(c.name, c.arguments || "");
      if (k) keyByCallId.set(c.id, k);
    }
  }
  // Last occurrence per key wins.
  const lastIdxByKey = new Map<string, number>();
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind !== "tool-result") continue;
    const k = keyByCallId.get(s.callId);
    if (k) lastIdxByKey.set(k, i);
  }
  let deduped = 0;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind !== "tool-result" || s.image) continue;
    const k = keyByCallId.get(s.callId);
    if (!k || lastIdxByKey.get(k) === i) continue;
    if (isPruned(s.output) || s.output.length < 200) continue;
    steps[i] = { ...s, output: `${PRUNE_MARK} superseded by a newer ${s.name} of the same target — use the latest result.` };
    deduped++;
  }
  return deduped;
}

/**
 * In-place history shrink for the model wire.
 * Safe: preserves step kinds, call ids, and the last user turn onward intact.
 */
export function economizeHistory(steps: Step[]): { prunedResults: number; slimmedCalls: number } {
  let prunedResults = 0;
  let slimmedCalls = 0;
  if (steps.length < 4) return { prunedResults, slimmedCalls };

  // 0) Latest-wins dedup runs first — even inside the protected recent window,
  // an older duplicate of a newer read is pure waste (and misleads the model).
  prunedResults += dedupeRepeatedResults(steps);

  // Protect the newest results globally. The old implementation stopped at the
  // last user message, leaving every tool result in the active agent run intact.
  const resultIdxs: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    if (steps[i].kind === "tool-result") resultIdxs.push(i);
  }
  const keepFrom =
    resultIdxs.length <= KEEP_RECENT_RESULTS
      ? 0
      : resultIdxs[resultIdxs.length - KEEP_RECENT_RESULTS];

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind !== "tool-result") continue;
    if (i >= keepFrom) continue;
    if (!STALEABLE.has(s.name) && !s.name.startsWith("mcp__")) continue;
    if (isPruned(s.output) || s.output.length < MIN_PRUNE_CHARS) continue;
    // Keep images: can't stub meaningfully for vision.
    if (s.image) continue;
    steps[i] = {
      ...s,
      output: stubResult(s.name, s.output, s.status),
    };
    prunedResults++;
  }

  // Slim old tool-call argument payloads (Write/StrReplace dominate token burn).
  const callBatchIdxs: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind === "assistant" && s.calls.length) callBatchIdxs.push(i);
  }
  const keepCallsFrom =
    callBatchIdxs.length <= KEEP_RECENT_CALL_BATCHES
      ? Infinity
      : callBatchIdxs[callBatchIdxs.length - KEEP_RECENT_CALL_BATCHES];

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind !== "assistant" || !s.calls?.length) continue;
    if (i >= keepCallsFrom) continue;
    let changed = false;
    const next: ToolCall[] = s.calls.map((c) => {
      const slim = slimCallArgs(c.name, c.arguments || "");
      if (slim !== c.arguments) {
        changed = true;
        slimmedCalls++;
        return { ...c, arguments: slim };
      }
      return c;
    });
    if (changed) {
      steps[i] = { ...s, calls: next, thinking: undefined };
    } else if (s.thinking) {
      // Thinking is UI-only; never re-sent on the wire but still bloated estimates/storage.
      steps[i] = { ...s, thinking: undefined };
    }
  }

  // Drop thinking on all assistant steps (not on the wire; free memory + accurate budgets).
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind === "assistant" && s.thinking) {
      steps[i] = { ...s, thinking: undefined };
    }
  }

  return { prunedResults, slimmedCalls };
}

/** Hard safety trigger. Normal compaction waits for a semantic boundary. */
export const COMPACT_AT_FILL = 0.72;

/** After summarize, keep this fraction of budget as verbatim tail. */
export const COMPACT_KEEP_FRAC = 0.4;

/** Safe boundary: the model just completed a subtask instead of being mid-tool loop. */
export function isCompactionBoundary(steps: Step[]): boolean {
  const last = steps[steps.length - 1];
  if (!last) return false;
  if (last.kind === "assistant" && !!last.text.trim() && !last.calls.length) return true;
  if (last.kind === "user") return /^\[System: Background subagent/.test(last.text);
  return false;
}

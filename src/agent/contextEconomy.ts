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
 * Critical invariant: never prune or slim anything in the LIVE turn (the last
 * user message and everything after it). Mid-task pruning caused infinite loops
 * because the model forgot what it just read/edited and re-did the same work.
 *
 * Older turns may be pruned aggressively; the live turn stays verbatim until
 * the next user message or an LLM compaction at a safe boundary.
 */

/** Exploration / dump tools — full body rarely needed after the next few turns. */
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

/** Edit payloads: once applied in an OLDER turn, re-sending full strings is waste. */
const SLIM_ARGS = new Set(["StrReplace", "Write", "EditNotebook", "Delete"]);

const PRUNE_MARK = "[context pruned]";

/**
 * Keep this many most-recent tool results verbatim from *before* the live turn.
 * Live-turn results are never pruned (see economizeHistory).
 */
const KEEP_RECENT_RESULTS = 12;

/** Keep this many most-recent assistant tool-call batches (pre-live-turn) with full args. */
const KEEP_RECENT_CALL_BATCHES = 6;

/** Only prune results larger than this (chars). */
const MIN_PRUNE_CHARS = 800;

/** Cap for slimmed string fields inside tool args. */
const SLIM_FIELD = 240;

function isPruned(s: string): boolean {
  return s.startsWith(PRUNE_MARK);
}

function stubResult(name: string, output: string, status: string): string {
  const n = output.length;
  const lines = output.split(/\r?\n/);
  const signal = lines.filter((line) =>
    /error|fail|exception|warning|warn|fatal|denied|timeout|not found|cannot|invalid|exit [1-9]|^\s*[-+]{3}|^\s*@@|^\s*\d+[|:]/i.test(line),
  );
  const evidence = (signal.length ? signal.slice(0, 10) : [...lines.slice(0, 4), ...lines.slice(-4)])
    .join("\n")
    .slice(0, 1200)
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
 * multiple times in OLDER turns, older copies become one-line supersede stubs.
 * Never touches the live turn — mid-task re-reads must stay visible so the
 * agent can see progress and avoid loops.
 */
function dedupeRepeatedResults(steps: Step[], liveFrom: number): number {
  // Map callId -> dedup key from the assistant call that issued it.
  const keyByCallId = new Map<string, string>();
  for (const s of steps) {
    if (s.kind !== "assistant") continue;
    for (const c of s.calls || []) {
      const k = dedupKey(c.name, c.arguments || "");
      if (k) keyByCallId.set(c.id, k);
    }
  }
  // Last occurrence per key wins (may be inside the live turn — that's fine;
  // we only stub older copies that sit before liveFrom).
  const lastIdxByKey = new Map<string, number>();
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind !== "tool-result") continue;
    const k = keyByCallId.get(s.callId);
    if (k) lastIdxByKey.set(k, i);
  }
  let deduped = 0;
  for (let i = 0; i < liveFrom; i++) {
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

function lastUserIndex(steps: Step[]): number {
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].kind === "user") return i;
  }
  return 0;
}

/**
 * In-place history shrink for the model wire.
 * Never mutates the live turn (last user message onward) — that is what stops
 * mid-task amnesia / infinite tool loops.
 */
export function economizeHistory(steps: Step[]): { prunedResults: number; slimmedCalls: number } {
  let prunedResults = 0;
  let slimmedCalls = 0;
  if (steps.length < 4) return { prunedResults, slimmedCalls };

  const liveFrom = lastUserIndex(steps);

  // 0) Latest-wins dedup only on pre-live history.
  prunedResults += dedupeRepeatedResults(steps, liveFrom);

  // 1) Stub stale tool dumps from older turns, keeping a generous recent window.
  const resultIdxs: number[] = [];
  for (let i = 0; i < liveFrom; i++) {
    if (steps[i].kind === "tool-result") resultIdxs.push(i);
  }
  const keepFrom =
    resultIdxs.length <= KEEP_RECENT_RESULTS
      ? 0
      : resultIdxs[resultIdxs.length - KEEP_RECENT_RESULTS];

  for (let i = 0; i < liveFrom; i++) {
    const s = steps[i];
    if (s.kind !== "tool-result") continue;
    if (i >= keepFrom) continue;
    if (!STALEABLE.has(s.name) && !s.name.startsWith("mcp__")) continue;
    if (isPruned(s.output) || s.output.length < MIN_PRUNE_CHARS) continue;
    if (s.image) continue;
    steps[i] = {
      ...s,
      output: stubResult(s.name, s.output, s.status),
    };
    prunedResults++;
  }

  // 2) Slim old edit-arg payloads from older turns only.
  const callBatchIdxs: number[] = [];
  for (let i = 0; i < liveFrom; i++) {
    const s = steps[i];
    if (s.kind === "assistant" && s.calls.length) callBatchIdxs.push(i);
  }
  const keepCallsFrom =
    callBatchIdxs.length <= KEEP_RECENT_CALL_BATCHES
      ? Infinity
      : callBatchIdxs[callBatchIdxs.length - KEEP_RECENT_CALL_BATCHES];

  for (let i = 0; i < liveFrom; i++) {
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
      steps[i] = { ...s, thinking: undefined };
    }
  }

  // Thinking is UI-only — drop from model wire copy everywhere (not persisted).
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.kind === "assistant" && s.thinking) {
      steps[i] = { ...s, thinking: undefined };
    }
  }

  return { prunedResults, slimmedCalls };
}

/** Hard safety trigger. Normal compaction waits for a semantic boundary. */
export const COMPACT_AT_FILL = 0.78;

/** Soft boundary trigger — wait longer so mid-task work isn't summarized away. */
export const COMPACT_SOFT_FILL = 0.65;

/** After summarize, keep this fraction of budget as verbatim tail. */
export const COMPACT_KEEP_FRAC = 0.5;

/** Safe boundary: the model just completed a subtask instead of being mid-tool loop. */
export function isCompactionBoundary(steps: Step[]): boolean {
  const last = steps[steps.length - 1];
  if (!last) return false;
  if (last.kind === "assistant" && !!last.text.trim() && !last.calls.length) return true;
  if (last.kind === "user") return /^\[System: Background subagent/.test(last.text);
  return false;
}

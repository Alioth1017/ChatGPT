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
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import type { SubagentRunner, QuestionAsker } from "./types";

// Directories never walked/listed.
export const IGNORE = new Set([".git", "node_modules", "dist", "out"]);

// Stopwords for the keyword-based SemanticSearch fallback.
export const STOP = new Set([
  "where", "what", "which", "does", "with", "this", "that", "have", "from",
  "into", "when", "how", "the", "and", "for", "are", "work", "works", "handle", "handled",
]);

// ---------------------------------------------------------------------------
// Diff helpers
// ---------------------------------------------------------------------------

/** Minimal LCS line diff, emitting only changed regions plus a little context. */
export function makeDiff(_filePath: string, before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  type Op = { t: " " | "+" | "-"; line: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: " ", line: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ t: "-", line: a[i] });
      i++;
    } else {
      ops.push({ t: "+", line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ t: "-", line: a[i++] });
  while (j < m) ops.push({ t: "+", line: b[j++] });

  const CONTEXT = 3;
  const keep = new Array(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].t !== " ") {
      for (let x = Math.max(0, k - CONTEXT); x <= Math.min(ops.length - 1, k + CONTEXT); x++) keep[x] = true;
    }
  }

  const out: string[] = [];
  let prevKept = true;
  for (let k = 0; k < ops.length; k++) {
    if (!keep[k]) {
      if (prevKept) out.push("…");
      prevKept = false;
      continue;
    }
    prevKept = true;
    const o = ops[k];
    out.push((o.t === " " ? "  " : o.t + " ") + o.line);
  }
  return out.join("\n");
}

/** 1-based line number of the first difference between two texts. */
export function firstDiffLine(before: string, after: string): number {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return i + 1;
  }
  return Math.min(a.length, b.length) + 1;
}

// ---------------------------------------------------------------------------
// Filesystem walking / globbing / fuzzy matching
// ---------------------------------------------------------------------------

/**
 * Recursively collect file paths under `dir` (depth-capped). IGNORE dirs
 * (.git/node_modules/dist/out) are skipped unless `includeIgnored` is true.
 */
export async function walk(dir: string, out: string[], depth: number, includeIgnored = false): Promise<void> {
  if (depth > 12) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!includeIgnored && IGNORE.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(full, out, depth + 1, includeIgnored);
    } else {
      out.push(full);
    }
  }
}

/** Sort file paths by mtime, most-recently-modified first. Best-effort stat. */
export async function sortByMtime(files: string[]): Promise<string[]> {
  const withTimes = await Promise.all(
    files.map(async (f) => {
      let mtimeMs = 0;
      try {
        mtimeMs = (await fs.stat(f)).mtimeMs;
      } catch {}
      return { f, mtimeMs };
    })
  );
  withTimes.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withTimes.map((x) => x.f);
}

/** Convert a glob (supporting **, *, ?) into an anchored RegExp. */
export function globToRe(p: string): RegExp {
  const esc = p
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${esc}$`);
}

/** Substring/subsequence fuzzy score (higher = better; 0 = no match). */
export function fuzzyScore(text: string, query: string): number {
  if (!query) return 0;
  if (text.includes(query)) return 100 + (query.length / text.length) * 50;
  let qi = 0;
  let score = 0;
  for (let i = 0; i < text.length && qi < query.length; i++) {
    if (text[i] === query[qi]) {
      score++;
      qi++;
    }
  }
  return qi === query.length ? score : 0;
}

/** Slugify a string for use as a filename. */
export function slugify(s: string): string {
  return (
    String(s || "plan")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "plan"
  );
}

/** Whether ripgrep is available on PATH. */
export function rgAvailable(): Promise<boolean> {
  return new Promise((res) => {
    const c = spawn("rg", ["--version"]);
    c.on("error", () => res(false));
    c.on("close", (code) => res(code === 0));
  });
}

// ---------------------------------------------------------------------------
// Background shell registry (shared by Shell + AwaitShell)
// ---------------------------------------------------------------------------

/** A pattern the agent wants to be notified about when it appears in output. */
export interface ShellNotify {
  re: RegExp;
  reason: string;
  debounceMs: number;
  lastNotified: number;
  /** Set by the loop so a match can emit an agent event. */
  emit?: (text: string) => void;
}

export interface BgShell {
  id: string;
  command: string;
  proc: ChildProcess;
  output: string;
  done: boolean;
  exitCode: number | null;
  startedAt: number;
  notify?: ShellNotify;
  /** Pull any new session output into this shell's buffer (for polling). */
  pump?: () => void;
}

export const bgShells = new Map<string, BgShell>();
let bgShellSeq = 0;
export function nextShellId(): string {
  return `sh_${++bgShellSeq}`;
}

/**
 * Feed new output into a shell, appending to its buffer and firing the
 * notify_on_output hook when the pattern matches (respecting debounce).
 */
export function pushShellOutput(sh: BgShell, chunk: string): void {
  sh.output += chunk;
  const n = sh.notify;
  if (!n || !n.emit) return;
  if (!n.re.test(chunk)) return;
  const now = Date.now();
  if (now - n.lastNotified < Math.max(5000, n.debounceMs)) return;
  n.lastNotified = now;
  n.emit(`Monitored ${n.reason}: matched in shell ${sh.id}`);
}

// ---------------------------------------------------------------------------
// Persistent stateful shell sessions (cwd/env persist across commands per run)
// ---------------------------------------------------------------------------

export interface ShellSession {
  proc: ChildProcess;
  /** Serializes command execution so output framing stays intact. */
  queue: Promise<unknown>;
  buffer: string;
}

const shellSessions = new Map<string, ShellSession>();

function spawnSessionShell(cwd: string): ChildProcess {
  if (process.platform === "win32") {
    return spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"], { cwd });
  }
  return spawn("bash", ["-i"], { cwd });
}

/** Get (or lazily create) the persistent shell session for a run key. */
export function getShellSession(key: string, cwd: string): ShellSession {
  let s = shellSessions.get(key);
  if (s && !s.proc.killed && s.proc.exitCode === null) return s;
  const proc = spawnSessionShell(cwd);
  s = { proc, queue: Promise.resolve(), buffer: "" };
  proc.stdout?.on("data", (d) => (s!.buffer += d));
  proc.stderr?.on("data", (d) => (s!.buffer += d));
  shellSessions.set(key, s);
  return s;
}

/** Tear down a run's persistent shell session (call on run end / dispose). */
export function disposeShellSession(key: string): void {
  const s = shellSessions.get(key);
  if (s) {
    try {
      s.proc.kill();
    } catch {}
    shellSessions.delete(key);
  }
}

/** Wait until the shell finishes, `pattern` matches its output, or `ms` elapses. */
export function waitForShell(sh: BgShell, ms: number, pattern?: RegExp): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + Math.max(0, ms);
    const tick = () => {
      sh.pump?.();
      if (sh.done || (pattern && pattern.test(sh.output)) || Date.now() >= deadline) return resolve();
      setTimeout(tick, 100);
    };
    tick();
  });
}

/**
 * Render a shell's state. Header + footer carry metadata (pid, timings,
 * exit_code); AwaitShell's `pattern` deliberately matches only the body.
 */
export function renderShell(sh: BgShell): string {
  const elapsed = Date.now() - sh.startedAt;
  const head = `[shell ${sh.id}] pid=${sh.proc.pid ?? "?"} running_for_ms=${elapsed}\n$ ${sh.command}`;
  const body = sh.output.slice(0, 20000);
  const footer = sh.done
    ? `(exit_code=${sh.exitCode} elapsed_ms=${elapsed})`
    : `(still running — poll with AwaitShell shell_id="${sh.id}")`;
  return `${head}\n${body}\n${footer}`;
}

// ---------------------------------------------------------------------------
// In-memory per-run todo list (TodoWrite / TodoRead)
// ---------------------------------------------------------------------------

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

let TODO_LIST: TodoItem[] = [];
export function resetTodos(): void {
  TODO_LIST = [];
}
export function getTodos(): TodoItem[] {
  return TODO_LIST;
}
export function setTodos(list: TodoItem[]): void {
  TODO_LIST = list;
}

// ---------------------------------------------------------------------------
// Injected runners (set by the agent loop to avoid circular imports)
// ---------------------------------------------------------------------------

let SUBAGENT_RUNNER: SubagentRunner | undefined;
export function setSubagentRunner(runner: SubagentRunner | undefined): void {
  SUBAGENT_RUNNER = runner;
}
export function getSubagentRunner(): SubagentRunner | undefined {
  return SUBAGENT_RUNNER;
}

let QUESTION_ASKER: QuestionAsker | undefined;
export function setQuestionAsker(asker: QuestionAsker | undefined): void {
  QUESTION_ASKER = asker;
}
export function getQuestionAsker(): QuestionAsker | undefined {
  return QUESTION_ASKER;
}

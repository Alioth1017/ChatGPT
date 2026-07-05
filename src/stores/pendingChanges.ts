/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as fs from "fs/promises";
import { safePath } from "../context/workspaceUtils";

export interface PendingChange {
  /** Workspace-relative path. */
  path: string;
  before: string;
  after: string;
  /** Whether the file existed before this edit (false => created). */
  existedBefore: boolean;
}

/** A contiguous changed region, expressed in 0-based line numbers of the AFTER file. */
export interface Hunk {
  /** First changed line in the after file (0-based). */
  startLine: number;
  /** Last changed line in the after file (0-based, inclusive). For pure deletions, == startLine-1 clamped. */
  endLine: number;
  /** Original lines this hunk replaced (for per-hunk undo). */
  beforeLines: string[];
  /** New lines in this hunk. */
  afterLines: string[];
  /** Index range in the before file (0-based, [start, end) ). */
  beforeStart: number;
  beforeEnd: number;
}

/** Compute changed hunks between two texts using an LCS line diff. */
export function computeHunks(before: string, after: string): Hunk[] {
  const a = before.length ? before.split("\n") : [];
  const b = after.length ? after.split("\n") : [];
  const n = a.length;
  const m = b.length;
  // LCS DP table.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  // Backtrack into ops.
  type Op = { t: "eq" | "del" | "add"; ai?: number; bi?: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: "eq", ai: i, bi: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: "del", ai: i });
      i++;
    } else {
      ops.push({ t: "add", bi: j });
      j++;
    }
  }
  while (i < n) ops.push({ t: "del", ai: i++ });
  while (j < m) ops.push({ t: "add", bi: j++ });

  // Group consecutive non-eq ops into hunks. Track the running line position in
  // both files so each hunk knows exactly where it sits in the AFTER (current) file.
  const hunks: Hunk[] = [];
  let k = 0;
  let aPos = 0; // next before-line index
  let bPos = 0; // next after-line index
  while (k < ops.length) {
    if (ops[k].t === "eq") {
      aPos++;
      bPos++;
      k++;
      continue;
    }
    const beforeLines: string[] = [];
    const afterLines: string[] = [];
    const beforeStart = aPos;
    const afterStart = bPos;
    while (k < ops.length && ops[k].t !== "eq") {
      const op = ops[k];
      if (op.t === "del") {
        beforeLines.push(a[op.ai!]);
        aPos++;
      } else {
        afterLines.push(b[op.bi!]);
        bPos++;
      }
      k++;
    }
    // After-file highlight range: the added lines occupy [afterStart, afterStart+addCount).
    // For a pure deletion, anchor the red ghost at afterStart (the line now in that spot).
    const startLine = afterStart;
    const endLine = afterLines.length ? afterStart + afterLines.length - 1 : afterStart;
    hunks.push({
      startLine,
      endLine,
      beforeLines,
      afterLines,
      beforeStart,
      beforeEnd: beforeStart + beforeLines.length,
    });
  }
  return hunks;
}

/**
 * Tracks file edits made by the agent that the user hasn't yet accepted/rejected,
 * enabling Cursor-style "keep / undo" of changes.
 */
class PendingChangesStore {
  private changes = new Map<string, PendingChange>();
  private listeners = new Set<() => void>();

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const l of this.listeners) l();
  }

  /** Record an edit. Coalesces repeated edits to the same file (keeps the original `before`). */
  record(path: string, before: string, after: string, existedBefore: boolean) {
    const existing = this.changes.get(path);
    this.changes.set(path, {
      path,
      before: existing ? existing.before : before,
      after,
      existedBefore: existing ? existing.existedBefore : existedBefore,
    });
    this.emit();
  }

  list(): PendingChange[] {
    return [...this.changes.values()];
  }
  get(path: string): PendingChange | undefined {
    return this.changes.get(path);
  }
  hunks(path: string): Hunk[] {
    const c = this.changes.get(path);
    return c ? computeHunks(c.before, c.after) : [];
  }
  has(path: string): boolean {
    return this.changes.has(path);
  }
  count(): number {
    return this.changes.size;
  }

  /** Accept (keep) a change — just drop it from tracking. */
  accept(path: string) {
    if (this.changes.delete(path)) this.emit();
  }
  acceptAll() {
    if (this.changes.size) {
      this.changes.clear();
      this.emit();
    }
  }

  /** Reject — restore the file's original content (or delete if it was created). */
  async reject(path: string): Promise<void> {
    const c = this.changes.get(path);
    if (!c) return;
    const abs = safePath(path);
    try {
      if (c.existedBefore) {
        await fs.writeFile(abs, c.before, "utf8");
      } else {
        await fs.rm(abs, { force: true });
      }
    } catch {
      // best-effort
    }
    this.changes.delete(path);
    this.emit();
  }
  async rejectAll(): Promise<void> {
    for (const p of [...this.changes.keys()]) {
      await this.reject(p);
    }
  }

  /** Accept a single hunk: fold it into `before` so it stops showing as a change. */
  async acceptHunk(path: string, hunkIndex: number): Promise<void> {
    const c = this.changes.get(path);
    if (!c) return;
    const hs = computeHunks(c.before, c.after);
    const h = hs[hunkIndex];
    if (!h) return;
    // Rebuild `before` so this hunk matches `after` (others stay pending).
    const beforeArr = c.before.length ? c.before.split("\n") : [];
    beforeArr.splice(h.beforeStart, h.beforeEnd - h.beforeStart, ...h.afterLines);
    c.before = beforeArr.join("\n");
    if (c.before === c.after) {
      this.changes.delete(path);
    }
    this.emit();
  }

  /** Reject a single hunk: restore its original lines in the file and in `after`. */
  async rejectHunk(path: string, hunkIndex: number): Promise<void> {
    const c = this.changes.get(path);
    if (!c) return;
    const hs = computeHunks(c.before, c.after);
    const h = hs[hunkIndex];
    if (!h) return;
    const afterArr = c.after.length ? c.after.split("\n") : [];
    const removeCount = h.afterLines.length;
    afterArr.splice(h.startLine, removeCount, ...h.beforeLines);
    c.after = afterArr.join("\n");
    try {
      await fs.writeFile(safePath(path), c.after, "utf8");
    } catch {
      // best-effort
    }
    if (c.after === c.before) {
      this.changes.delete(path);
    }
    this.emit();
  }
}

export const pendingChanges = new PendingChangesStore();

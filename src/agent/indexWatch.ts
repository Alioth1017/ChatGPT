/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

// Debounced workspace file watcher → incremental semantic index updates.

import * as vscode from "vscode";
import * as path from "path";
import { upsertFile, removeFile, buildIndex, setIndexingEnabled, warmIndex, isIndexingEnabled } from "./semanticIndex";
import { getWorkspaceRoot } from "../context/workspaceUtils";
import type { FeatureStore } from "../stores/featureStore";

const DEBOUNCE_MS = 800;
const pending = new Map<string, "up" | "del">(); // abs path -> action
let timer: ReturnType<typeof setTimeout> | null = null;
let featureStore: FeatureStore | null = null;
let flushing = false;

function scheduleFlush(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, DEBOUNCE_MS);
}

async function flush(): Promise<void> {
  if (flushing) {
    scheduleFlush();
    return;
  }
  if (!isIndexingEnabled()) {
    pending.clear();
    return;
  }
  const root = getWorkspaceRoot();
  if (!root || !pending.size) return;
  flushing = true;
  try {
    const batch = new Map(pending);
    pending.clear();
    for (const [abs, action] of batch) {
      try {
        if (action === "del") await removeFile(root, abs);
        else await upsertFile(root, abs);
      } catch {
        /* ignore single-file failures */
      }
    }
  } finally {
    flushing = false;
    if (pending.size) scheduleFlush();
  }
}

function onFs(uri: vscode.Uri, action: "up" | "del"): void {
  if (!isIndexingEnabled()) return;
  if (uri.scheme !== "file") return;
  const root = getWorkspaceRoot();
  if (!root) return;
  const abs = uri.fsPath;
  if (!abs.startsWith(root) && !abs.toLowerCase().startsWith(root.toLowerCase())) return;
  // Skip vendor/build/non-source (upsertFile also filters; early-out saves work).
  const rel = path.relative(root, abs).split(path.sep).join("/");
  if (!rel || rel.startsWith("..")) return;
  if (
    /(^|\/)(node_modules|\.git|dist|out|build|\.next|\.nuxt|\.output|\.turbo|\.cache|coverage|\.venv|venv|__pycache__|target|vendor|Pods|\.gradle|\.idea|\.vscode|bower_components|jspm_packages|\.pnpm-store|\.yarn|site-packages|\.terraform|\.svelte-kit|\.angular|storybook-static)(\/|$)/.test(
      rel,
    )
  ) {
    return;
  }
  pending.set(abs, action);
  scheduleFlush();
}

/** Wire indexing enable flag, warm disk index, incremental sync, file watcher. */
export function initIndexWatch(context: vscode.ExtensionContext, store: FeatureStore): void {
  featureStore = store;
  let lastEnabled = store.get().indexingEnabled !== false;
  setIndexingEnabled(lastEnabled);

  const root = getWorkspaceRoot();
  void warmIndex(root).then(() => {
    if (lastEnabled) void buildIndex(root).catch(() => {});
  });

  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  context.subscriptions.push(
    watcher,
    watcher.onDidCreate((u) => onFs(u, "up")),
    watcher.onDidChange((u) => onFs(u, "up")),
    watcher.onDidDelete((u) => onFs(u, "del")),
    vscode.workspace.onDidSaveTextDocument((doc) => onFs(doc.uri, "up")),
    store.onDidChange(() => {
      const on = store.get().indexingEnabled !== false;
      if (on === lastEnabled) return;
      lastEnabled = on;
      setIndexingEnabled(on);
      if (on) void buildIndex(getWorkspaceRoot()).catch(() => {});
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (!isIndexingEnabled()) return;
      const f = featureStore?.get();
      if (f && f.indexNewFolders === false) return;
      const r = getWorkspaceRoot();
      void warmIndex(r).then(() => buildIndex(r).catch(() => {}));
    }),
    {
      dispose: () => {
        if (timer) clearTimeout(timer);
        pending.clear();
      },
    },
  );
}

/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as vscode from "vscode";
import { pendingChanges } from "../stores/pendingChanges";

const ORIGINALS = new Map<string, string>();

/** Open VS Code's native side-by-side diff (before vs current) for a tracked change. */
async function viewDiff(path: string) {
  const change = pendingChanges.get(path);
  if (!change) return;
  const isAbsolute = /^([a-zA-Z]:[\\/]|\/)/.test(path);
  const folders = vscode.workspace.workspaceFolders;
  const base = folders && folders.length ? folders[0].uri : undefined;
  const fileUri = isAbsolute
    ? vscode.Uri.file(path)
    : base
    ? vscode.Uri.joinPath(base, path)
    : vscode.Uri.file(path);
  const beforeUri = vscode.Uri.parse(`ocursor-inline-original:/${path}`);
  ORIGINALS.set(path, change.before);
  await vscode.commands.executeCommand("vscode.diff", beforeUri, fileUri, `${path.split(/[\\/]/).pop()} (agent changes)`);
}

/** Register the side-by-side diff command + its virtual original-content provider. */
export function registerInlineReview(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("ocursor-inline-original", {
      provideTextDocumentContent: (uri) => ORIGINALS.get(uri.path.replace(/^\//, "")) ?? "",
    }),
    vscode.commands.registerCommand("ocursor.viewDiff", (path: string) => viewDiff(path))
  );
}

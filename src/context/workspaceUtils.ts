/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as vscode from "vscode";
import * as path from "path";

export function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  return process.cwd();
}

/** Recently viewed files (workspace-relative), most recent first. */
export function getRecentFiles(): string[] {
  const root = getWorkspaceRoot();
  const out: string[] = [];
  for (const tab of vscode.window.tabGroups.all.flatMap((g) => g.tabs)) {
    const input = tab.input as { uri?: vscode.Uri } | undefined;
    const uri = input?.uri;
    if (uri && uri.scheme === "file" && uri.fsPath.startsWith(root)) {
      const rel = path.relative(root, uri.fsPath).split(path.sep).join("/");
      if (!out.includes(rel)) {
        out.push(uri.fsPath);
      }
    }
  }
  return out;
}

export function safePath(rel: string): string {
  const root = getWorkspaceRoot();
  const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
  const norm = path.resolve(abs);
  const ws = path.resolve(root);
  if (norm !== ws && !norm.startsWith(ws + path.sep)) {
    throw new Error(`path outside workspace: ${rel}`);
  }
  return norm;
}

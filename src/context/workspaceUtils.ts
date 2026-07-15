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

/**
 * Resolve a workspace path safely. Handles spaces, unicode, and mixed
 * separators. Does not shell-quote — callers that inject into a shell must
 * quote the result (see shell.ts quotePath).
 */
export function safePath(rel: string): string {
  const root = getWorkspaceRoot();
  // Normalize user input: trim, unify slashes, drop surrounding quotes the
  // model sometimes wraps around paths that contain spaces.
  let s = String(rel ?? "").trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1);
  }
  s = s.replace(/\//g, path.sep);
  const abs = path.isAbsolute(s) ? s : path.join(root, s);
  const norm = path.resolve(abs);
  const ws = path.resolve(root);
  // Case-insensitive root check on Windows (C:\ vs c:\).
  const normKey = process.platform === "win32" ? norm.toLowerCase() : norm;
  const wsKey = process.platform === "win32" ? ws.toLowerCase() : ws;
  if (normKey !== wsKey && !normKey.startsWith(wsKey + path.sep)) {
    throw new Error(`path outside workspace: ${rel}`);
  }
  return norm;
}

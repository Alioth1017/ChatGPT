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
 * Normalize a model/user path: spaces, quotes, file:// URIs, mixed separators.
 * Does not shell-quote — callers that inject into a shell must quote the result.
 */
export function normalizePathInput(rel: string): string {
	let s = String(rel ?? "").trim();
	// file:///C:/foo%20bar or file://localhost/C:/...
	if (/^file:\/\//i.test(s)) {
		try {
			s = decodeURIComponent(vscode.Uri.parse(s).fsPath);
		} catch {
			s = s.replace(/^file:\/\/\/?/i, "").replace(/\//g, path.sep);
			try {
				s = decodeURIComponent(s);
			} catch {
				/* keep */
			}
		}
	}
	// Strip surrounding quotes the model wraps around paths with spaces.
	// Also handle nested `"path with spaces"` and smart quotes.
	for (let i = 0; i < 3; i++) {
		const t = s.trim();
		if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) || (t.startsWith("`") && t.endsWith("`")) || (t.startsWith("\u201c") && t.endsWith("\u201d")) || (t.startsWith("\u2018") && t.endsWith("\u2019"))) {
			s = t.slice(1, -1).trim();
			continue;
		}
		s = t;
		break;
	}
	// Model sometimes escapes spaces as `\ ` (unix-style).
	s = s.replace(/\\ /g, " ");
	// Collapse only internal runs of spaces that are clearly accidental? Keep
	// real spaces in folder names — do not collapse.
	// Normalize separators; path.resolve will also fix mixed ones.
	s = s.replace(/\//g, path.sep);
	// Drop trailing separators except drive root (C:\).
	if (s.length > 3 && (s.endsWith(path.sep) || s.endsWith("/") || s.endsWith("\\"))) {
		s = s.replace(/[\\/]+$/, "");
	}
	return s;
}

/**
 * Resolve a workspace path safely. Handles spaces, unicode, and mixed
 * separators. Does not shell-quote — callers that inject into a shell must
 * quote the result (see shell.ts quotePath).
 */
export function safePath(rel: string): string {
	const root = getWorkspaceRoot();
	const s = normalizePathInput(rel);
	if (!s) throw new Error("empty path");
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

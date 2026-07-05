/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

// @-mention search + resolution (Cursor-style typeahead types).
// Search: returns MentionItem[] per kind for the composer popup.
// Resolve: turns picked mentions into <attached_context> blocks for the prompt.

import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { spawn } from "child_process";
import { getWorkspaceRoot } from "./workspaceUtils";
import { search as searchCodebase } from "../agent/semanticIndex";
import { type DocSource } from "../agent/docsIndex";
import { listRules } from "./workspaceContext";

export type MentionKind =
  | "file" | "folder" | "code" | "doc" | "git" | "composer"
  | "terminal" | "rule" | "branch_diff" | "link";

export interface MentionItem {
  kind: MentionKind;
  /** Display name. */
  name: string;
  /** Stored key: rel path, commit sha, doc id, conv id, terminal name, url. */
  path: string;
  /** Secondary display text (rel dir, commit subject, url…). */
  detail?: string;
}

function git(args: string[]): Promise<string> {
  const root = getWorkspaceRoot();
  return new Promise((res) => {
    const c = spawn("git", args, { cwd: root });
    let o = "";
    c.stdout.on("data", (d) => (o += d));
    c.on("error", () => res(""));
    c.on("close", () => res(o.trim()));
  });
}

// ---- Search providers ----

export async function searchFilesAndFolders(query: string, limit = 30): Promise<MentionItem[]> {
  const q = (query || "").trim();
  const glob = q ? `**/*${q}*` : "**/*";
  let items: MentionItem[] = [];
  try {
    const uris = await vscode.workspace.findFiles(glob, "**/{node_modules,.git,dist,out,build}/**", 50);
    const folders = new Set<string>();
    items = uris.map((u) => {
      const rel = vscode.workspace.asRelativePath(u, false);
      const slash = rel.lastIndexOf("/");
      if (slash > 0) folders.add(rel.slice(0, slash));
      return { kind: "file" as const, path: rel, name: rel.split("/").pop() || rel, detail: rel };
    });
    for (const f of folders) {
      if (!q || f.toLowerCase().includes(q.toLowerCase())) {
        items.unshift({ kind: "folder", path: f, name: f.split("/").pop() || f, detail: f });
      }
    }
  } catch { /* ignore */ }
  return items.slice(0, limit);
}

export async function searchCommits(query: string, limit = 15): Promise<MentionItem[]> {
  const raw = await git(["log", "--oneline", "-n", "50", "--no-merges"]);
  if (!raw) return [];
  const q = (query || "").toLowerCase();
  return raw
    .split("\n")
    .map((l) => {
      const sp = l.indexOf(" ");
      return { sha: l.slice(0, sp), subject: l.slice(sp + 1) };
    })
    .filter((c) => !q || c.subject.toLowerCase().includes(q) || c.sha.startsWith(q))
    .slice(0, limit)
    .map((c) => ({ kind: "git" as const, path: c.sha, name: c.subject, detail: c.sha }));
}

export function searchDocSources(docs: DocSource[], query: string): MentionItem[] {
  const q = (query || "").toLowerCase();
  return docs
    .filter((d) => !q || d.name.toLowerCase().includes(q))
    .map((d) => ({ kind: "doc" as const, path: d.id, name: d.name, detail: d.pages ? `${d.pages} pages` : d.url }));
}

export function searchTerminals(query: string): MentionItem[] {
  const q = (query || "").toLowerCase();
  return vscode.window.terminals
    .filter((t) => !q || t.name.toLowerCase().includes(q))
    .map((t) => ({ kind: "terminal" as const, path: t.name, name: t.name, detail: "terminal" }));
}

export async function searchRules(query: string): Promise<MentionItem[]> {
  const q = (query || "").toLowerCase();
  const rules = await listRules();
  return rules
    .filter((r) => !q || r.file.toLowerCase().includes(q) || r.description.toLowerCase().includes(q))
    .map((r) => ({ kind: "rule" as const, path: r.file, name: r.file.replace(/\.mdc?$/, ""), detail: r.description || "rule" }));
}

export async function searchCode(query: string, limit = 10): Promise<MentionItem[]> {
  if (!query.trim()) return [];
  try {
    const hits = await searchCodebase(getWorkspaceRoot(), query, limit);
    return hits.map((h) => ({
      kind: "code" as const,
      path: `${h.path}:${h.start}-${h.end}`,
      name: `${h.path.split("/").pop()}:${h.start}-${h.end}`,
      detail: h.path,
    }));
  } catch {
    return [];
  }
}

export function branchDiffItem(): MentionItem {
  return { kind: "branch_diff", path: "branch_diff", name: "Branch (Diff with Main)", detail: "git diff main...HEAD" };
}

// ---- Resolution (mention → context block) ----

const MAX_BLOCK = 8000;

async function readFileSafe(rel: string): Promise<string> {
  try {
    const abs = path.isAbsolute(rel) ? rel : path.join(getWorkspaceRoot(), rel);
    return (await fs.readFile(abs, "utf8")).slice(0, MAX_BLOCK);
  } catch {
    return "";
  }
}

export interface PastChatProvider {
  /** Returns a short plain-text summary of a conversation by id (or undefined). */
  summarize(convId: string): string | undefined;
}

/**
 * Build <attached_context> blocks for mentions picked in the composer.
 * `prompt` drives semantic queries (docs). Best-effort: failures are skipped.
 */
export async function resolveMentions(
  mentions: MentionItem[],
  prompt: string,
  docs: DocSource[],
  pastChats?: PastChatProvider
): Promise<string> {
  const blocks: string[] = [];
  for (const m of mentions) {
    try {
      switch (m.kind) {
        case "code": {
          const [, rel, s, e] = /^(.+):(\d+)-(\d+)$/.exec(m.path) ?? [];
          if (!rel) break;
          const text = await readFileSafe(rel);
          const lines = text.split("\n").slice(Number(s) - 1, Number(e));
          blocks.push(`<attached_code path="${rel}" lines="${s}-${e}">\n${lines.join("\n")}\n</attached_code>`);
          break;
        }
        case "rule": {
          const body = await readFileSafe(path.join(".cursor", "rules", m.path));
          if (body) blocks.push(`<attached_rule name="${m.path}">\n${body}\n</attached_rule>`);
          break;
        }
        case "doc": {
          // Match by id first, then by name (mentions rebuilt from plain text carry the name).
          const doc = docs.find((d) => d.id === m.path)
            ?? docs.find((d) => d.name.toLowerCase() === (m.name || m.path).toLowerCase());
          if (!doc) break;
          // Pointer only — the agent pulls excerpts on demand via the SearchDocs tool.
          blocks.push(`<attached_docs name="${doc.name}" url="${doc.url}">\nThe user attached the "${doc.name}" documentation (${doc.url}, ${doc.pages ?? 0} pages indexed). Use the SearchDocs tool with doc="${doc.name}" to retrieve relevant excerpts.\n</attached_docs>`);
          break;
        }
        case "git": {
          const show = await git(["show", "--stat", "--format=medium", m.path]);
          if (show) blocks.push(`<attached_commit sha="${m.path}">\n${show.slice(0, MAX_BLOCK)}\n</attached_commit>`);
          break;
        }
        case "branch_diff": {
          // Try main, then master.
          let diff = await git(["diff", "main...HEAD", "--stat"]);
          let body = await git(["diff", "main...HEAD"]);
          if (!diff) { diff = await git(["diff", "master...HEAD", "--stat"]); body = await git(["diff", "master...HEAD"]); }
          if (diff) blocks.push(`<branch_diff_with_main>\n${diff}\n\n${body.slice(0, MAX_BLOCK)}\n</branch_diff_with_main>`);
          break;
        }
        case "composer": {
          const summary = pastChats?.summarize(m.path);
          if (summary) blocks.push(`<attached_past_chat title="${m.name}">\n${summary.slice(0, MAX_BLOCK)}\n</attached_past_chat>`);
          break;
        }
        case "terminal": {
          // ponytail: VS Code stable API can't read terminal buffers; attach name only.
          blocks.push(`<attached_terminal name="${m.path}">The user referenced the "${m.path}" terminal. Use the Shell tool to inspect recent state if needed.</attached_terminal>`);
          break;
        }
        case "link": {
          // Pointer only — the agent fetches on demand via the WebFetch tool.
          blocks.push(`<attached_link url="${m.path}">The user attached this link. Use the WebFetch tool to read its content if needed.</attached_link>`);
          break;
        }
        // file/folder mentions stay inline as @path — the agent reads them itself.
      }
    } catch { /* best-effort per mention */ }
  }
  return blocks.join("\n\n");
}

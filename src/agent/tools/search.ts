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
import { safePath, getWorkspaceRoot } from "../../context/workspaceUtils";
import { defineTool } from "./types";
import { STOP, walk, globToRe, rgAvailable } from "./shared";
import { search as semanticIndexSearch, buildIndex, isIndexing } from "../semanticIndex";
import { searchDocs, listDocSources } from "../docsIndex";

// Minimal ripgrep --type -> file-extension map for the node fallback.
const TYPE_EXTS: Record<string, string[]> = {
  js: [".js", ".jsx", ".mjs", ".cjs"],
  ts: [".ts", ".tsx", ".mts", ".cts"],
  py: [".py", ".pyi"],
  rust: [".rs"],
  go: [".go"],
  java: [".java"],
  c: [".c", ".h"],
  cpp: [".cpp", ".cc", ".cxx", ".hpp", ".hh"],
  cs: [".cs"],
  rb: [".rb"],
  php: [".php"],
  json: [".json"],
  md: [".md", ".markdown"],
  html: [".html", ".htm"],
  css: [".css", ".scss", ".sass"],
  sh: [".sh", ".bash"],
  yaml: [".yaml", ".yml"],
};

// ---- Grep (ripgrep with a node fallback) ----
export const grepTool = defineTool("Grep", false, async (input, abortSignal) => {
  const root = getWorkspaceRoot();
  const mode: string = input.output_mode || "content";
  const target = input.path ? safePath(input.path) : ".";
  const cap = Math.max(1, Math.min(Number(input.head_limit) || 200, 5000));
  const skip = Math.max(0, Number(input.offset) || 0);

  if (await rgAvailable()) {
    const args = ["--color=never"];
    if (mode === "files_with_matches") {
      args.push("--files-with-matches");
    } else if (mode === "count") {
      args.push("--count");
    } else {
      args.push("--line-number", "--no-heading");
      if (input["-A"] != null) args.push("-A", String(input["-A"]));
      if (input["-B"] != null) args.push("-B", String(input["-B"]));
      if (input["-C"] != null) args.push("-C", String(input["-C"]));
    }
    if (input["-i"]) args.push("-i");
    if (input.multiline) args.push("-U", "--multiline-dotall");
    if (input.glob) args.push("--glob", String(input.glob));
    if (input.type) args.push("--type", String(input.type));
    args.push("--", input.pattern, target);

    const out = await new Promise<string>((res) => {
      const c = spawn("rg", args, { cwd: root, signal: abortSignal });
      let o = "";
      c.stdout.on("data", (d) => (o += d));
      c.on("error", () => res("(grep failed)"));
      c.on("close", () => {
        let lines = o.split("\n").filter(Boolean);
        if (skip) lines = lines.slice(skip);
        res(lines.slice(0, cap).join("\n") || "(no matches)");
      });
    });
    return { output: out };
  }

  // Node fallback (no ripgrep available). Honor path/glob/type/-A/-B/-C/multiline.
  const scopeRoot = input.path ? safePath(input.path) : root;
  const all: string[] = [];
  await walk(scopeRoot, all, 0);

  const flags = input["-i"] ? "i" : "";
  const lineRe = new RegExp(input.pattern, flags);
  const multiRe = input.multiline ? new RegExp(input.pattern, flags + "s") : null;
  const globRe = input.glob ? globToRe(String(input.glob).startsWith("**/") ? String(input.glob) : "**/" + String(input.glob)) : null;
  const typeExts = input.type ? TYPE_EXTS[String(input.type)] : null;
  const aCtx = Math.max(0, Number(input["-A"] ?? input["-C"] ?? 0));
  const bCtx = Math.max(0, Number(input["-B"] ?? input["-C"] ?? 0));

  const hitsByFile: Record<string, string[]> = {};
  const countByFile: Record<string, number> = {};
  const order: string[] = [];
  for (const f of all.slice(0, 5000)) {
    const rel = path.relative(root, f).split(path.sep).join("/");
    if (globRe && !globRe.test(rel)) continue;
    if (typeExts && !typeExts.includes(path.extname(f).toLowerCase())) continue;
    let txt: string;
    try {
      txt = await fs.readFile(f, "utf8");
    } catch {
      continue; // binary / unreadable
    }
    const push = (line: string) => {
      if (!hitsByFile[rel]) {
        hitsByFile[rel] = [];
        order.push(rel);
        countByFile[rel] = 0;
      }
      hitsByFile[rel].push(line);
    };
    if (multiRe) {
      if (multiRe.test(txt)) {
        countByFile[rel] = (countByFile[rel] ?? 0) + 1;
        push(`${rel}:${txt}`);
      }
      continue;
    }
    const lines = txt.split("\n");
    lines.forEach((l, idx) => {
      if (!lineRe.test(l)) return;
      countByFile[rel] = (countByFile[rel] ?? 0) + 1;
      if (mode !== "content") {
        push(`${rel}:${idx + 1}:${l}`);
        return;
      }
      for (let b = bCtx; b >= 1; b--) {
        if (idx - b >= 0) push(`${rel}-${idx + 1 - b}-${lines[idx - b]}`);
      }
      push(`${rel}:${idx + 1}:${l}`);
      for (let a = 1; a <= aCtx; a++) {
        if (idx + a < lines.length) push(`${rel}-${idx + 1 + a}-${lines[idx + a]}`);
      }
    });
  }

  let result: string[];
  if (mode === "files_with_matches") result = order;
  else if (mode === "count") result = order.map((f) => `${f}:${countByFile[f]}`);
  else result = order.flatMap((f) => hitsByFile[f]);
  if (skip) result = result.slice(skip);
  const truncated = result.length > cap;
  const shown = result.slice(0, cap);
  if (!shown.length) return { output: "(no matches)" };
  return { output: shown.join("\n") + (truncated ? `\n... (at least ${result.length} matches, truncated)` : "") };
});

// ---- SemanticSearch ----
// Real local semantic search: embed the query and cosine-rank against the
// on-disk embedding index (see semanticIndex.ts). Falls back to keyword
// OR-grep when the index/embedder is unavailable (no model yet, etc.).
function keywordFallback(input: any, abortSignal?: AbortSignal, callId?: string, ctx?: any) {
  const words = String(input.query || "")
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w))
    .slice(0, 6);
  if (!words.length) return Promise.resolve({ output: "(no searchable terms)" });
  const dirs: string[] = Array.isArray(input.target_directories) ? input.target_directories : [];
  const scope = dirs.length === 1 ? String(dirs[0]) : undefined;
  return grepTool.execute({ pattern: words.join("|"), "-i": true, path: scope }, abortSignal, callId, ctx);
}

export const semanticSearchTool = defineTool("SemanticSearch", false, async (input, abortSignal, callId, ctx) => {
  const query = String(input.query || "").trim();
  if (!query) return { output: "(no query)" };
  const root = getWorkspaceRoot();

  // Build/refresh index on demand (incremental; cheap if already fresh).
  if (!isIndexing()) buildIndex(root).catch(() => {});

  // Scope by target_directories (prefix match on workspace-relative paths).
  const dirs: string[] = Array.isArray(input.target_directories) ? input.target_directories : [];
  const prefixes = dirs
    .map((d) => path.relative(root, safePath(String(d))).split(path.sep).join("/"))
    .filter((p) => p && !p.startsWith(".."));
  const filter = prefixes.length
    ? (rel: string) => prefixes.some((p) => rel === p || rel.startsWith(p + "/"))
    : undefined;

  let hits: Awaited<ReturnType<typeof semanticIndexSearch>> = [];
  try {
    hits = await semanticIndexSearch(root, query, 12, filter);
  } catch {
    hits = [];
  }
  if (!hits.length) return keywordFallback(input, abortSignal, callId, ctx);

  const out = hits
    .map((h) => `${h.path}:${h.start}-${h.end}  (score ${h.score.toFixed(3)})\n${h.text}`)
    .join("\n\n---\n\n");
  return { output: out };
});

// ---- SearchDocs (user-indexed external documentation) ----
export const searchDocsTool = defineTool("SearchDocs", false, async (input) => {
  const query = String(input.query || "").trim();
  if (!query) return { output: "(no query)" };
  const k = Math.max(1, Math.min(Number(input.num_results) || 6, 12));
  const sources = listDocSources().filter((d) => (d.pages ?? 0) > 0);
  if (!sources.length) return { output: "(no indexed doc sources — the user can add them in Settings > Indexing & Docs)" };

  const want = String(input.doc || "").trim().toLowerCase();
  const targets = want
    ? sources.filter((d) => d.id.toLowerCase() === want || d.name.toLowerCase() === want)
    : sources;
  if (!targets.length) {
    return { output: `(no indexed doc source matching "${input.doc}". Available: ${sources.map((d) => d.name).join(", ")})` };
  }

  const all: { doc: string; url: string; title: string; text: string; score: number }[] = [];
  for (const d of targets) {
    const hits = await searchDocs(d.id, query, k).catch(() => []);
    for (const h of hits) all.push({ doc: d.name, ...h });
  }
  all.sort((a, b) => b.score - a.score);
  const top = all.slice(0, k);
  if (!top.length) return { output: "(no matching excerpts)" };
  return {
    output: top
      .map((h) => `[${h.doc}] ${h.title} — ${h.url}  (score ${h.score.toFixed(3)})\n${h.text}`)
      .join("\n\n---\n\n"),
  };
});

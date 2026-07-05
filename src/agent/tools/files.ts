/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import { safePath, getWorkspaceRoot } from "../../context/workspaceUtils";
import { pendingChanges } from "../../stores/pendingChanges";
import { defineTool, type Tool, type ToolResult, type ToolContext } from "./types";
import { IGNORE, walk, globToRe, sortByMtime, fuzzyScore, makeDiff, firstDiffLine } from "./shared";

// Image extensions the Read tool returns as base64 blocks to the model.
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// ---- Read ----
export const readFileTool = defineTool("Read", false, async (input) => {
  if (typeof input.path !== "string" || !input.path) return { output: "error: path is required and must be a string" };
  const p = safePath(input.path);
  const ext = path.extname(p).toLowerCase();

  // Image files: return a base64 image block so it reaches the model.
  if (IMAGE_MIME[ext]) {
    const buf = await fs.readFile(p);
    return {
      output: `[image ${path.basename(p)} (${IMAGE_MIME[ext]}, ${buf.length} bytes)]`,
      image: { mime: IMAGE_MIME[ext], base64: buf.toString("base64") },
    };
  }

  // PDF files: extract text (honoring the same char cap as text reads).
  if (ext === ".pdf") {
    try {
      const { PDFParse } = await import("pdf-parse");
      const buf = await fs.readFile(p);
      const parser = new PDFParse({ data: new Uint8Array(buf) });
      const res = await parser.getText();
      await parser.destroy?.();
      const text = (res?.text ?? "").slice(0, 100_000);
      return { output: text || "(no extractable text in PDF)" };
    } catch (e) {
      return { output: `error: cannot read PDF: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  const content = await fs.readFile(p, "utf8");
  if (content === "") return { output: "File is empty." };

  const lines = content.split("\n");
  const totalLines = lines.length;
  // Map Cursor's offset/limit (whole-file by default) to a line window.
  let start = 1;
  let end = totalLines;
  if (input.offset !== undefined && input.offset !== null) {
    const off = Number(input.offset);
    start = off < 0 ? Math.max(1, totalLines + off + 1) : Math.max(1, off);
  }
  if (input.limit !== undefined && input.limit !== null) {
    end = Math.min(totalLines, start + Math.max(1, Number(input.limit)) - 1);
  } else if (input.offset !== undefined && input.offset !== null) {
    end = totalLines;
  }
  if (end < start) end = start;

  const out = lines
    .slice(start - 1, end)
    .map((l, idx) => `${start + idx}|${l}`)
    .join("\n");
  return { output: out, startLine: start, endLine: end };
});

// ---- ListDir ----
export const listDirTool = defineTool("ListDir", false, async (input) => {
  const p = safePath(input.path ?? ".");
  const entries = await fs.readdir(p, { withFileTypes: true });
  const out =
    entries
      .filter((e) => !IGNORE.has(e.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .join("\n") || "(empty)";
  return { output: out };
});

// ---- Glob ----
export const globTool = defineTool("Glob", false, async (input) => {
  const root = input.target_directory ? safePath(input.target_directory) : getWorkspaceRoot();
  // Include ignored dirs so patterns like "**/node_modules/**" can match.
  const all: string[] = [];
  await walk(root, all, 0, true);
  // Prepend "**/" when the pattern isn't already rooted (schema behavior).
  let pattern: string = String(input.glob_pattern ?? "");
  if (pattern && !pattern.startsWith("**/")) pattern = "**/" + pattern;
  const re = globToRe(pattern);

  // Filter, then return matches sorted by modification time (schema promise).
  const matched = all.filter((f) => re.test(path.relative(root, f).split(path.sep).join("/")));
  const sorted = await sortByMtime(matched);
  const hits = sorted.slice(0, 200).map((f) => path.relative(root, f).split(path.sep).join("/"));
  return { output: hits.join("\n") || "(no matches)" };
});

// ---- FileSearch (fuzzy filename search) ----
export const fileSearchTool = defineTool("FileSearch", false, async (input) => {
  const root = getWorkspaceRoot();
  const all: string[] = [];
  await walk(root, all, 0);
  const q = String(input.query || "").toLowerCase();
  const rel = all.map((f) => path.relative(root, f).split(path.sep).join("/"));
  const scored = rel
    .map((f) => ({ f, score: fuzzyScore(f.toLowerCase(), q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 30)
    .map((x) => x.f);
  return { output: scored.join("\n") || "(no matches)" };
});

// ---- StrReplace / Write (shared edit handler) ----
// StrReplace edits an existing file (old_string -> new_string, optionally all
// occurrences). Write creates/overwrites a file (contents). Both share logic.
// In multitask mode the agent is a COORDINATOR: it must NOT edit anything itself.
// Edit tools refuse and instruct it to delegate to parallel subagents instead.
const MULTITASK_BLOCK: ToolResult = {
  output:
    "error: editing is disabled in multitask mode — you are a COORDINATOR and must NOT edit files yourself. " +
    "Delegate ALL implementation work to subagents: call the Task tool (run_in_background=true) for each " +
    "independent unit of work and launch multiple subagents AT THE SAME TIME in a single turn. " +
    "Have the subagents make these edits in parallel; do not call edit tools directly.",
};

function blockedInMultitask(ctx?: ToolContext): boolean {
  return ctx?.getMode?.() === "multitask";
}

const editExecute: Tool["execute"] = async (input, _signal, _callId, ctx) => {
  if (blockedInMultitask(ctx)) return MULTITASK_BLOCK;
  if (typeof input.path !== "string" || !input.path) return { output: "error: path is required and must be a string" };
  const p = safePath(input.path);
  let existedBefore = false;
  try {
    await fs.access(p);
    existedBefore = true;
  } catch {}
  const original = existedBefore ? await fs.readFile(p, "utf8") : "";

  // Write: full create / overwrite.
  if (input.contents !== undefined && input.old_string === undefined) {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, input.contents, "utf8");
    pendingChanges.record(input.path, original, input.contents, existedBefore);
    return {
      output: `wrote ${input.path} (${input.contents.split("\n").length} lines)`,
      diff: makeDiff(input.path, original, input.contents),
      startLine: firstDiffLine(original, input.contents),
    };
  }

  if (!existedBefore) {
    return { output: `error: ${input.path} does not exist; pass contents to create it` };
  }

  const oldS = input.old_string ?? "";
  const newS = input.new_string ?? "";
  const replaceAll = input.replace_all ?? input.allow_multiple_matches;
  let matched = original;

  // Strategy 1: exact substring match.
  const idx = original.indexOf(oldS);
  if (idx !== -1) {
    const isUnique = original.indexOf(oldS, idx + 1) === -1;
    if (!isUnique && !replaceAll) {
      return { output: `error: old_string is not unique in ${input.path}; add more context or set replace_all` };
    }
    matched = replaceAll
      ? original.split(oldS).join(newS)
      : original.slice(0, idx) + newS + original.slice(idx + oldS.length);
  } else {
    // Strategy 2: whitespace-insensitive line-window match.
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    const target = norm(oldS);
    const lines = original.split("\n");
    const windowSize = Math.max(1, oldS.split("\n").length);
    const candidates: number[] = [];
    for (let i = 0; i <= lines.length - windowSize; i++) {
      if (norm(lines.slice(i, i + windowSize).join("\n")) === target) candidates.push(i);
    }
    if (candidates.length === 0) {
      return { output: `error: could not find old_string in ${input.path}` };
    }
    if (candidates.length > 1 && !replaceAll) {
      return { output: `error: old_string matches ${candidates.length} locations in ${input.path}; add more context` };
    }
    const targets = replaceAll ? candidates.slice().reverse() : [candidates[0]];
    for (const found of targets) lines.splice(found, windowSize, ...newS.split("\n"));
    matched = lines.join("\n");
  }

  if (matched === original) {
    return { output: `error: edit produced no change in ${input.path}` };
  }
  await fs.writeFile(p, matched, "utf8");
  pendingChanges.record(input.path, original, matched, existedBefore);
  return {
    output: `edited ${input.path}`,
    diff: makeDiff(input.path, original, matched),
    startLine: firstDiffLine(original, matched),
  };
};

export const strReplaceTool = defineTool("StrReplace", true, editExecute);
export const writeTool = defineTool("Write", true, editExecute);

// ---- Delete ----
export const deleteFileTool = defineTool("Delete", true, async (input, _signal, _callId, ctx) => {
  if (blockedInMultitask(ctx)) return MULTITASK_BLOCK;
  if (typeof input.path !== "string" || !input.path) return { output: "error: path is required and must be a string" };
  const p = safePath(input.path);
  let before = "";
  try {
    before = await fs.readFile(p, "utf8");
  } catch {}
  // Schema: fail gracefully if the file doesn't exist / can't be deleted.
  try {
    await fs.unlink(p);
  } catch (e: any) {
    if (e?.code === "ENOENT") return { output: `error: ${input.path} does not exist` };
    if (e?.code === "EISDIR" || e?.code === "EPERM" || e?.code === "EACCES") {
      return { output: `error: cannot delete ${input.path}: ${e.code}` };
    }
    return { output: `error: cannot delete ${input.path}: ${e instanceof Error ? e.message : String(e)}` };
  }
  // Track as a change so the user can restore the deleted file.
  pendingChanges.record(input.path, before, "", true);
  return { output: `deleted ${input.path}` };
});

// ---- EditNotebook ----
// The strict set of languages allowed by the schema.
const NB_LANGS = new Set(["python", "markdown", "javascript", "typescript", "r", "sql", "shell", "raw", "other"]);
// Map a cell_language to a Jupyter cell_type. Markdown/raw map directly; every
// programming language is a "code" cell (the language id is kept in metadata).
function nbCellType(lang: string): "code" | "markdown" | "raw" {
  const l = (lang || "").toLowerCase();
  if (l === "markdown") return "markdown";
  if (l === "raw") return "raw";
  return "code";
}
// VS Code language id used in a code cell's metadata so r/sql/shell/etc keep
// their identity (cell_type alone only distinguishes code/markdown/raw).
function nbLanguageId(lang: string): string {
  const l = (lang || "").toLowerCase();
  const map: Record<string, string> = {
    python: "python",
    javascript: "javascript",
    typescript: "typescript",
    r: "r",
    sql: "sql",
    shell: "shellscript",
    other: "plaintext",
  };
  return map[l] || "python";
}
function nbSourceToString(source: unknown): string {
  if (Array.isArray(source)) return source.join("");
  return typeof source === "string" ? source : "";
}
function nbStringToSource(s: string): string[] {
  if (s === "") return [];
  // Each line keeps its trailing "\n" except the final line (Jupyter convention).
  const lines = s.split("\n");
  return lines.map((line, i) => (i < lines.length - 1 ? line + "\n" : line));
}

export const editNotebookTool = defineTool("EditNotebook", true, async (input, _signal, _callId, ctx) => {
  if (blockedInMultitask(ctx)) return MULTITASK_BLOCK;
  const target = String(input?.target_notebook ?? "");
  if (!target) return { output: "error: target_notebook is required" };
  if (!target.toLowerCase().endsWith(".ipynb")) {
    return { output: "error: EditNotebook only edits .ipynb files" };
  }
  const cellIdx = Number(input?.cell_idx);
  if (!Number.isInteger(cellIdx) || cellIdx < 0) {
    return { output: "error: cell_idx must be a non-negative integer" };
  }
  const isNew = input?.is_new_cell === true;
  const language = String(input?.cell_language ?? "");
  if (language && !NB_LANGS.has(language.toLowerCase())) {
    return { output: `error: cell_language must be one of: ${[...NB_LANGS].join(", ")}` };
  }
  const oldString = String(input?.old_string ?? "");
  const newString = String(input?.new_string ?? "");

  const abs = safePath(target);

  // Read (or scaffold) the notebook JSON.
  let nb: any;
  let before = "";
  try {
    before = await fs.readFile(abs, "utf8");
    nb = JSON.parse(before);
  } catch (e: any) {
    if (e?.code === "ENOENT" && isNew) {
      nb = { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 };
    } else {
      return { output: `error: cannot read notebook: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  if (!nb || typeof nb !== "object" || !Array.isArray(nb.cells)) {
    return { output: "error: not a valid notebook (missing cells array)" };
  }

  const cellType = nbCellType(language);
  const makeCell = (content: string) => {
    const cell: any = { cell_type: cellType, metadata: {}, source: nbStringToSource(content) };
    if (cellType === "code") {
      cell.execution_count = null;
      cell.outputs = [];
      cell.metadata.vscode = { languageId: nbLanguageId(language) };
    }
    return cell;
  };

  if (isNew) {
    // Insert a new cell at cell_idx (clamped to the end of the list).
    const at = Math.min(cellIdx, nb.cells.length);
    nb.cells.splice(at, 0, makeCell(newString));
  } else {
    const cell = nb.cells[cellIdx];
    if (!cell) {
      return { output: `error: cell ${cellIdx} does not exist (notebook has ${nb.cells.length} cells)` };
    }
    const src = nbSourceToString(cell.source);
    if (oldString === "") {
      return { output: "error: old_string is required when editing an existing cell (set is_new_cell=true to create one)" };
    }
    // old_string must uniquely identify the target text within the cell.
    const first = src.indexOf(oldString);
    if (first === -1) {
      return { output: `error: old_string not found in cell ${cellIdx}` };
    }
    if (src.indexOf(oldString, first + 1) !== -1) {
      return { output: `error: old_string is not unique in cell ${cellIdx}; add more surrounding context` };
    }
    const updated = src.slice(0, first) + newString + src.slice(first + oldString.length);
    cell.source = nbStringToSource(updated);
    // Honor an explicit language change, keeping code/markdown/raw cells valid.
    cell.cell_type = cellType;
    if (cellType === "code") {
      if (cell.execution_count === undefined) cell.execution_count = null;
      if (!Array.isArray(cell.outputs)) cell.outputs = [];
      cell.metadata = { ...(cell.metadata ?? {}), vscode: { languageId: nbLanguageId(language) } };
    } else {
      // markdown / raw cells must not carry code-only keys.
      delete cell.execution_count;
      delete cell.outputs;
      if (cell.metadata && cell.metadata.vscode) delete cell.metadata.vscode;
    }
  }

  const after = JSON.stringify(nb, null, 1) + "\n";
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, after, "utf8");

  const action = isNew
    ? `Created ${cellType} cell at index ${Math.min(cellIdx, nb.cells.length - 1)}`
    : `Edited cell ${cellIdx}`;
  return { output: `${action} in ${target}`, diff: makeDiff(abs, before, after) };
});

// ---- ReadLints ----
export const readLintsTool = defineTool("ReadLints", false, async (input) => {
  const root = getWorkspaceRoot();
  const all = vscode.languages.getDiagnostics();

  // Normalize each requested path (absolute OR workspace-relative) to a
  // workspace-relative, forward-slashed prefix. A path equal to the workspace
  // root (or "."/"") means "all files" (empty filter list -> no filtering).
  const toRel = (raw: string): string | null => {
    const trimmed = String(raw).trim();
    if (trimmed === "" || trimmed === ".") return null; // means "all"
    const abs = path.resolve(root, trimmed);
    let rel = path.relative(root, abs).split(path.sep).join("/");
    if (rel === "" ) return null; // path resolves to the root itself -> all
    rel = rel.replace(/\/+$/, "");
    return rel.startsWith("..") ? `\u0000outside\u0000` : rel; // outside workspace -> never matches
  };

  let allFiles = false;
  const filters: string[] = [];
  if (Array.isArray(input.paths)) {
    for (const p of input.paths) {
      const r = toRel(p);
      if (r === null) allFiles = true;
      else filters.push(r);
    }
  }
  // Case-insensitive comparison on win32 (drive-letter / path casing).
  const ci = process.platform === "win32";
  const norm = (s: string) => (ci ? s.toLowerCase() : s);
  const filtersN = filters.map(norm);

  const out: string[] = [];
  for (const [uri, diags] of all) {
    const relRaw = path.relative(root, uri.fsPath).split(path.sep).join("/");
    if (relRaw.startsWith("..")) continue; // outside workspace
    const rel = norm(relRaw);
    if (!allFiles && filtersN.length && !filtersN.some((f) => rel === f || rel.startsWith(f + "/"))) continue;
    for (const d of diags) {
      if (d.severity > vscode.DiagnosticSeverity.Warning) continue;
      const sev = d.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning";
      out.push(`${relRaw}:${d.range.start.line + 1}:${d.range.start.character + 1} ${sev}: ${d.message}`);
    }
  }
  return { output: out.slice(0, 100).join("\n") || "(no diagnostics)" };
});

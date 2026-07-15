/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

// Real local semantic codebase index.
// - Embeddings: @huggingface/transformers (Xenova/all-MiniLM-L6-v2, q8 ONNX/WASM)
//   → 100% local, no server, no API key. Model downloads once to globalStorage.
// - Chunking: sliding line-window per file (simple, language-agnostic).
//   ponytail: line-window chunking; upgrade to tree-sitter AST chunks when
//   ranking quality on large funcs matters.
// - Store: plain JSON in globalStorage + in-memory cosine top-k.
//   ponytail: O(n) cosine scan; swap for sqlite-vec/HNSW when repo > ~50k chunks.
// - Incremental: per-file mtime hash skips unchanged files on re-index.

import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";
import { walk } from "./tools/shared";
import { importRuntimeDep } from "../runtimeDeps";

// Selectable local embedding models. Add entries here to offer more choices.
export interface EmbedModel {
  id: string;
  name: string;
  repo: string;
  dtype: "fp32" | "fp16" | "q8";
  pooling: "mean" | "last_token";
  dim: number;
}
export const EMBED_MODELS: EmbedModel[] = [
  { id: "minilm", name: "all-MiniLM-L6-v2 (fast, default)", repo: "Xenova/all-MiniLM-L6-v2", dtype: "q8", pooling: "mean", dim: 384 },
];

let activeModel: EmbedModel = EMBED_MODELS[0];

/** Remote (provider API) embedding model, e.g. OpenAI text-embedding-3-small. */
export interface RemoteEmbedConfig {
  id: string;
  baseUrl: string;
  apiKey: string;
}
let remoteCfg: RemoteEmbedConfig | null = null;

export function getEmbedModelId(): string {
  return remoteCfg ? remoteCfg.id : activeModel.id;
}

/** Switch to a LOCAL embedding model. Invalidates the loaded extractor (re-index needed). */
export function setEmbedModel(id: string): void {
  const m = EMBED_MODELS.find((x) => x.id === id);
  if (!m) return;
  const changed = remoteCfg !== null || m.id !== activeModel.id;
  remoteCfg = null;
  if (m.id !== activeModel.id) {
    activeModel = m;
    extractorP = null; // force reload with new repo/dtype
  }
  if (changed) {
    memIndex = null; // index built with old model is stale
    memRoot = null;
  }
}

/** Switch to a REMOTE (provider) embedding model via the OpenAI-compatible /embeddings API. */
export function setRemoteEmbedModel(cfg: RemoteEmbedConfig): void {
  if (remoteCfg?.id === cfg.id && remoteCfg.baseUrl === cfg.baseUrl) {
    remoteCfg = cfg; // refresh key silently
    return;
  }
  remoteCfg = cfg;
  memIndex = null;
  memRoot = null;
}

const CHUNK_LINES = 40;
const CHUNK_OVERLAP = 10;
const EMBED_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java",
  ".c", ".h", ".cpp", ".cc", ".hpp", ".cs", ".rb", ".php", ".swift", ".kt",
  ".scala", ".md", ".json", ".html", ".css", ".scss", ".vue", ".svelte", ".sql",
]);
const MAX_FILE_BYTES = 512 * 1024;

export interface Chunk {
  path: string; // workspace-relative, posix
  start: number; // 1-based
  end: number;
  text: string;
  vec: number[]; // normalized, length = model dim
}
interface IndexFile {
  model: string; // EmbedModel.id the vectors were built with
  files: Record<string, string>; // relPath -> mtime+size hash
  chunks: Chunk[];
}

let storageDir: string | undefined;
export function setIndexStorageDir(dir: string): void {
  storageDir = dir;
}

// ---- Embedder (lazy, singleton) ----
let extractorP: Promise<any> | null = null;
async function getExtractor(): Promise<any | null> {
  if (!storageDir) return null;
  if (!extractorP) {
    const m = activeModel;
    extractorP = (async () => {
      const t = await importRuntimeDep("@huggingface/transformers");
      t.env.allowRemoteModels = true;
      t.env.cacheDir = path.join(storageDir!, "models");
      return t.pipeline("feature-extraction", m.repo, { dtype: m.dtype });
    })().catch((e) => {
      console.error("[semanticIndex] embedder load failed:", e);
      extractorP = null;
      return null;
    });
  }
  return extractorP;
}

/** Embed via a provider's OpenAI-compatible /embeddings endpoint. */
async function embedRemote(texts: string[]): Promise<number[][] | null> {
  if (!remoteCfg) return null;
  try {
    const res = await fetch(`${remoteCfg.baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${remoteCfg.apiKey}` },
      body: JSON.stringify({ model: remoteCfg.id, input: texts }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json: any = await res.json();
    const vecs: number[][] = json.data.sort((a: any, b: any) => a.index - b.index).map((d: any) => d.embedding);
    // Normalize (cosine expects unit vectors; some APIs don't normalize).
    return vecs.map((v) => {
      let n = 0;
      for (const x of v) n += x * x;
      n = Math.sqrt(n) || 1;
      return v.map((x) => x / n);
    });
  } catch (e) {
    console.error("[semanticIndex] remote embed failed:", e);
    return null;
  }
}

async function embed(texts: string[]): Promise<number[][] | null> {
  if (remoteCfg) return embedRemote(texts);
  const ex = await getExtractor();
  if (!ex) return null;
  const out = await ex(texts, { pooling: activeModel.pooling, normalize: true });
  const data = out.tolist ? out.tolist() : out;
  return data as number[][];
}

export async function embedQuery(q: string): Promise<number[] | null> {
  const r = await embed([q]);
  return r ? r[0] : null;
}

/** Batch-embed arbitrary texts with the active local model (docs index reuses this). */
export async function embedTexts(texts: string[]): Promise<number[][] | null> {
  return embed(texts);
}

// ---- Index lifecycle ----
/** Stable workspace key so Windows drive-letter case / trailing slashes don't orphan the index. */
function normRoot(root: string): string {
  const r = path.resolve(root);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

function indexPath(root: string): string {
  const id = crypto.createHash("sha1").update(normRoot(root)).digest("hex").slice(0, 16);
  const mid = getEmbedModelId().replace(/[^\w.-]+/g, "_");
  return path.join(storageDir!, `index-${id}-${mid}.json`);
}

let memIndex: IndexFile | null = null;
let memRoot: string | null = null; // normRoot key
let indexingEnabled = true;

export function setIndexingEnabled(on: boolean): void {
  indexingEnabled = on;
}

export function isIndexingEnabled(): boolean {
  return indexingEnabled;
}

async function load(root: string): Promise<IndexFile> {
  const key = normRoot(root);
  if (memIndex && memRoot === key) return memIndex;
  try {
    const raw = await fs.readFile(indexPath(root), "utf8");
    const parsed = JSON.parse(raw) as IndexFile;
    if (parsed.model === getEmbedModelId() && parsed.files && Array.isArray(parsed.chunks)) {
      memIndex = parsed;
      memRoot = key;
      return parsed;
    }
  } catch {}
  memIndex = { model: getEmbedModelId(), files: {}, chunks: [] };
  memRoot = key;
  return memIndex;
}

async function save(root: string, idx: IndexFile): Promise<void> {
  if (!storageDir) return;
  await fs.mkdir(storageDir, { recursive: true });
  await fs.writeFile(indexPath(root), JSON.stringify(idx), "utf8");
  memIndex = idx;
  memRoot = normRoot(root);
}

/** Load persisted index into memory (no embed work). Call on activate so status/UI show prior work. */
export async function warmIndex(root: string): Promise<IndexStatus> {
  if (!storageDir || !root) return getStatus(root);
  await load(root);
  emitStatus(root);
  return getStatus(root);
}

function chunkFile(rel: string, text: string): { start: number; end: number; text: string }[] {
  const lines = text.split("\n");
  const out: { start: number; end: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i += CHUNK_LINES - CHUNK_OVERLAP) {
    const slice = lines.slice(i, i + CHUNK_LINES);
    const body = slice.join("\n").trim();
    if (!body) continue;
    out.push({ start: i + 1, end: Math.min(i + CHUNK_LINES, lines.length), text: body });
    if (i + CHUNK_LINES >= lines.length) break;
  }
  return out;
}

let indexing = false;
export function isIndexing(): boolean {
  return indexing;
}

// Progress reported to UI subscribers (e.g. settings panel).
export interface IndexStatus {
  indexing: boolean;
  done: number;
  total: number;
  files: number; // indexed files in store
  chunks: number;
  model: string; // active EmbedModel.id
}
let progress = { done: 0, total: 0 };
const statusSubs = new Set<(s: IndexStatus) => void>();
export function onIndexStatus(fn: (s: IndexStatus) => void): () => void {
  statusSubs.add(fn);
  return () => statusSubs.delete(fn);
}
export function getStatus(root: string): IndexStatus {
  const idx = memRoot === normRoot(root) ? memIndex : null;
  return {
    indexing,
    done: progress.done,
    total: progress.total,
    files: idx ? Object.keys(idx.files).length : 0,
    chunks: idx ? idx.chunks.length : 0,
    model: getEmbedModelId(),
  };
}
function emitStatus(root: string): void {
  const s = getStatus(root);
  for (const fn of statusSubs) fn(s);
}

/** Delete the persisted index for a workspace. */
export async function deleteIndex(root: string): Promise<void> {
  memIndex = { model: getEmbedModelId(), files: {}, chunks: [] };
  memRoot = normRoot(root);
  progress = { done: 0, total: 0 };
  try { await fs.unlink(indexPath(root)); } catch {}
  emitStatus(root);
}

function isIndexableRel(rel: string): boolean {
  return EMBED_EXTS.has(path.extname(rel).toLowerCase());
}

async function embedFileInto(idx: IndexFile, root: string, rel: string): Promise<boolean> {
  const abs = path.join(root, rel);
  let st;
  try { st = await fs.stat(abs); } catch { return false; }
  if (st.size > MAX_FILE_BYTES) return false;
  let text: string;
  try { text = await fs.readFile(abs, "utf8"); } catch { return false; }
  // Drop old chunks for this path first.
  idx.chunks = idx.chunks.filter((c) => c.path !== rel);
  const pieces = chunkFile(rel, text);
  if (pieces.length) {
    const vecs = await embed(pieces.map((p) => p.text));
    if (vecs) {
      pieces.forEach((p, i) => idx.chunks.push({ path: rel, start: p.start, end: p.end, text: p.text, vec: vecs[i] }));
    }
  }
  idx.files[rel] = `${Math.round(st.mtimeMs)}:${st.size}`;
  return true;
}

/** Pending single-file updates while a full build runs (or coalesced watcher queue). */
const pendingUpserts = new Map<string, Set<string>>(); // rootKey -> rel paths
const pendingDeletes = new Map<string, Set<string>>();
let drainRunning = false;

function queueKey(root: string): string {
  return normRoot(root);
}

/** Index/update one file immediately (or queue if full build busy). */
export async function upsertFile(root: string, absOrRel: string): Promise<void> {
  if (!storageDir || !indexingEnabled || !root) return;
  const abs = path.isAbsolute(absOrRel) ? absOrRel : path.join(root, absOrRel);
  const rel = path.relative(root, abs).split(path.sep).join("/");
  if (!rel || rel.startsWith("..") || !isIndexableRel(rel)) return;
  const key = queueKey(root);
  if (indexing || drainRunning) {
    if (!pendingUpserts.has(key)) pendingUpserts.set(key, new Set());
    pendingUpserts.get(key)!.add(rel);
    pendingDeletes.get(key)?.delete(rel);
    return;
  }
  const idx = await load(root);
  let st;
  try { st = await fs.stat(abs); } catch {
    await removeFile(root, abs);
    return;
  }
  const hash = `${Math.round(st.mtimeMs)}:${st.size}`;
  if (idx.files[rel] === hash || idx.files[rel] === `${st.mtimeMs}:${st.size}`) return;
  await embedFileInto(idx, root, rel);
  await save(root, idx);
  emitStatus(root);
}

/** Remove a file from the index (delete/rename). */
export async function removeFile(root: string, absOrRel: string): Promise<void> {
  if (!storageDir || !indexingEnabled || !root) return;
  const abs = path.isAbsolute(absOrRel) ? absOrRel : path.join(root, absOrRel);
  const rel = path.relative(root, abs).split(path.sep).join("/");
  if (!rel || rel.startsWith("..")) return;
  const key = queueKey(root);
  if (indexing || drainRunning) {
    if (!pendingDeletes.has(key)) pendingDeletes.set(key, new Set());
    pendingDeletes.get(key)!.add(rel);
    pendingUpserts.get(key)?.delete(rel);
    return;
  }
  const idx = await load(root);
  if (!idx.files[rel] && !idx.chunks.some((c) => c.path === rel)) return;
  idx.chunks = idx.chunks.filter((c) => c.path !== rel);
  delete idx.files[rel];
  await save(root, idx);
  emitStatus(root);
}

async function drainPending(root: string): Promise<void> {
  if (drainRunning || indexing || !indexingEnabled) return;
  const key = queueKey(root);
  const ups = pendingUpserts.get(key);
  const dels = pendingDeletes.get(key);
  if ((!ups || !ups.size) && (!dels || !dels.size)) return;
  drainRunning = true;
  try {
    const idx = await load(root);
    if (dels?.size) {
      for (const rel of dels) {
        idx.chunks = idx.chunks.filter((c) => c.path !== rel);
        delete idx.files[rel];
      }
      dels.clear();
    }
    if (ups?.size) {
      const list = [...ups];
      ups.clear();
      progress = { done: 0, total: list.length };
      indexing = true;
      emitStatus(root);
      let done = 0;
      for (const rel of list) {
        await embedFileInto(idx, root, rel);
        done++;
        progress = { done, total: list.length };
        emitStatus(root);
      }
      indexing = false;
    }
    await save(root, idx);
    emitStatus(root);
  } finally {
    drainRunning = false;
    indexing = false;
    // More events may have arrived.
    if ((pendingUpserts.get(key)?.size || 0) + (pendingDeletes.get(key)?.size || 0) > 0) {
      void drainPending(root);
    }
  }
}

/** (Re)build the index incrementally. Only re-embeds changed files. No-op if disabled/busy. */
export async function buildIndex(root: string, onProgress?: (done: number, total: number) => void): Promise<void> {
  if (!storageDir || !root || indexing || !indexingEnabled) return;
  indexing = true;
  progress = { done: 0, total: 0 };
  emitStatus(root);
  try {
    const idx = await load(root);
    const all: string[] = [];
    await walk(root, all, 0);
    const targets: string[] = [];
    const seen = new Set<string>();
    for (const f of all) {
      if (!EMBED_EXTS.has(path.extname(f).toLowerCase())) continue;
      const rel = path.relative(root, f).split(path.sep).join("/");
      let st;
      try { st = await fs.stat(f); } catch { continue; }
      if (st.size > MAX_FILE_BYTES) continue;
      seen.add(rel);
      const hash = `${Math.round(st.mtimeMs)}:${st.size}`;
      const prev = idx.files[rel];
      // Accept either rounded or raw mtime strings from older indexes.
      if (prev !== hash && prev !== `${st.mtimeMs}:${st.size}`) targets.push(rel);
    }
    const changed = new Set(targets);
    idx.chunks = idx.chunks.filter((c) => seen.has(c.path) && !changed.has(c.path));
    for (const rel of Object.keys(idx.files)) {
      if (!seen.has(rel)) delete idx.files[rel];
    }

    // Nothing to do — still save cleaned deletions if any, emit status.
    if (!targets.length) {
      await save(root, idx);
      return;
    }

    let done = 0;
    progress = { done: 0, total: targets.length };
    emitStatus(root);
    for (const rel of targets) {
      await embedFileInto(idx, root, rel);
      // Prefer stable rounded hash going forward.
      const st = await fs.stat(path.join(root, rel)).catch(() => null);
      if (st) idx.files[rel] = `${Math.round(st.mtimeMs)}:${st.size}`;
      done++;
      progress = { done, total: targets.length };
      onProgress?.(done, targets.length);
      emitStatus(root);
      // Persist periodically so reopen mid-index keeps progress.
      if (done % 25 === 0) await save(root, idx);
    }
    await save(root, idx);
  } finally {
    indexing = false;
    emitStatus(root);
    void drainPending(root);
  }
}

/** Cosine top-k. Returns [] if index empty / embedder unavailable. */
export async function search(
  root: string,
  query: string,
  k = 12,
  filter?: (rel: string) => boolean
): Promise<{ path: string; start: number; end: number; text: string; score: number }[]> {
  const qv = await embedQuery(query);
  if (!qv) return [];
  const idx = await load(root);
  if (!idx.chunks.length) return [];
  const dim = qv.length;
  const scored: { c: Chunk; score: number }[] = [];
  for (const c of idx.chunks) {
    if (filter && !filter(c.path)) continue;
    if (c.vec.length !== dim) continue;
    let dot = 0;
    for (let i = 0; i < dim; i++) dot += qv[i] * c.vec[i]; // both normalized → cosine
    scored.push({ c, score: dot });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map(({ c, score }) => ({ path: c.path, start: c.start, end: c.end, text: c.text, score }));
}

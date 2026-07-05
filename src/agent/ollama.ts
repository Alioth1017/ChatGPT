/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

// Ollama local model manager.
// - Uses the `ollama` CLI for install-check / pull / delete, and the daemon's
//   /api/tags for a structured model list (the CLI has no JSON output).
// - Chat goes through Ollama's OpenAI-compatible endpoint at /v1 (served by the
//   running daemon), so we never spawn a server ourselves.

import { spawn, execFile } from "child_process";
import * as vscode from "vscode";

/** Base URL of the Ollama daemon (no trailing slash). */
let HOST = "http://localhost:11434";
const CLI = "ollama";

export function setOllamaHost(host: string): void {
  HOST = host.replace(/\/+$/, "");
}

/** OpenAI-compatible endpoint Ollama serves for chat. */
export function ollamaOpenAIBase(): string {
  return `${HOST}/v1`;
}

export interface OllamaModel {
  /** e.g. "llama3.1:8b" — also the id used in chat requests. */
  name: string;
  sizeBytes?: number;
  parameterSize?: string;
  quantization?: string;
  family?: string;
}

export interface OllamaStatus {
  installed: boolean;
  /** model name -> download progress percent (0-100) while pulling. */
  pulling: Record<string, number>;
  /** model name -> last error. */
  errors: Record<string, string>;
}

const pulling = new Map<string, number>();
const errors = new Map<string, string>();
const pullProcs = new Map<string, ReturnType<typeof spawn>>();
let installedCache = false;

const _onStatus = new vscode.EventEmitter<OllamaStatus>();
export const onOllamaStatus = _onStatus.event;

function snapshot(): OllamaStatus {
  const p: Record<string, number> = {};
  for (const [k, v] of pulling) p[k] = v;
  const e: Record<string, string> = {};
  for (const [k, v] of errors) e[k] = v;
  return { installed: installedCache, pulling: p, errors: e };
}
function emit() {
  _onStatus.fire(snapshot());
}

export function getStatus(): OllamaStatus {
  return snapshot();
}

/** Whether the `ollama` CLI is installed (`ollama --version`). */
export function checkInstalled(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(CLI, ["--version"], (err) => {
      installedCache = !err;
      emit();
      resolve(!err);
    });
  });
}

/** List models pulled locally (via /api/tags — the CLI has no JSON output). */
export async function listModels(): Promise<OllamaModel[]> {
  const r = await fetch(`${HOST}/api/tags`);
  if (!r.ok) throw new Error(`ollama tags ${r.status}`);
  const d: any = await r.json();
  return (d?.models ?? []).map((m: any) => ({
    name: m.name,
    sizeBytes: m.size,
    parameterSize: m.details?.parameter_size,
    quantization: m.details?.quantization_level,
    family: m.details?.family,
  }));
}

/**
 * Pull (download) a model via `ollama pull <name>`. Progress is printed to
 * stderr as a percentage; we parse it and report 0-100. Resolves on success.
 */
export function pullModel(name: string, onProgress?: (pct: number) => void): Promise<void> {
  errors.delete(name);
  pulling.set(name, 0);
  emit();
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(CLI, ["pull", name], { stdio: ["ignore", "pipe", "pipe"] });
    pullProcs.set(name, proc);
    let stderrTail = "";
    const onData = (b: Buffer) => {
      const text = b.toString();
      stderrTail = (stderrTail + text).slice(-500);
      // Progress lines look like: "pulling manifest... 42%" (CR-updated).
      const matches = text.match(/(\d+)\s*%/g);
      if (matches?.length) {
        const pct = parseInt(matches[matches.length - 1], 10);
        if (!Number.isNaN(pct)) {
          pulling.set(name, pct);
          onProgress?.(pct);
          emit();
        }
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", (e) => {
      pullProcs.delete(name);
      pulling.delete(name);
      errors.set(name, e.message);
      emit();
      reject(e);
    });
    proc.on("exit", (code) => {
      pullProcs.delete(name);
      pulling.delete(name);
      if (code === 0) {
        emit();
        resolve();
      } else {
        const msg = stderrTail.trim() || `ollama pull exited (${code})`;
        errors.set(name, msg);
        emit();
        reject(new Error(msg));
      }
    });
  });
}

/** Cancel an in-flight pull. */
export function cancelPull(name: string): void {
  pullProcs.get(name)?.kill();
  pullProcs.delete(name);
  pulling.delete(name);
  emit();
}

/** Delete a locally-pulled model via `ollama rm <name>`. */
export function deleteModel(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(CLI, ["rm", name], (err, _out, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      emit();
      resolve();
    });
  });
}

/** Open Ollama's install page. */
export async function installOllama(): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse("https://ollama.com/download"));
}

// ---- library search (scrapes ollama.com — no official registry API) ----
export interface OllamaLibraryModel {
  name: string;
  description?: string;
  pulls?: string;
}

/** Search the Ollama library by scraping ollama.com/search. */
export async function searchLibrary(query: string): Promise<OllamaLibraryModel[]> {
  const r = await fetch(`https://ollama.com/search?q=${encodeURIComponent(query)}`, {
    headers: { "user-agent": "Mozilla/5.0", accept: "text/html" },
  });
  if (!r.ok) throw new Error(`ollama search ${r.status}`);
  const html = await r.text();
  const out: OllamaLibraryModel[] = [];
  const seen = new Set<string>();
  // Each result is an <a href="/library/<name>"> block with a description.
  const re = /<a[^>]+href="\/library\/([^"#?]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const name = m[1].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const inner = m[2];
    const desc = stripTags(firstMatch(inner, /<p[^>]*>([\s\S]*?)<\/p>/));
    const pulls = stripTags(firstMatch(inner, /([\d.]+[KMB]?)\s*Pulls/i));
    out.push({ name, description: desc || undefined, pulls: pulls || undefined });
  }
  return out;
}

/** List the available pull tags for a library model (scrapes its tags page). */
export async function listLibraryTags(name: string): Promise<string[]> {
  const r = await fetch(`https://ollama.com/library/${encodeURIComponent(name)}/tags`, {
    headers: { "user-agent": "Mozilla/5.0", accept: "text/html" },
  });
  if (!r.ok) throw new Error(`ollama tags ${r.status}`);
  const html = await r.text();
  const tags = new Set<string>();
  const re = new RegExp(`href="/library/${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}:([^"#?]+)"`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) tags.add(`${name}:${m[1]}`);
  return [...tags];
}

function firstMatch(s: string, re: RegExp): string {
  const m = re.exec(s);
  return m ? m[1] : "";
}
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

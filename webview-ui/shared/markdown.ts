/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { Marked } from "marked";

// GFM markdown (tables, task lists, fenced code, etc.). marked passes raw HTML
// through, so we sanitize the output before injecting into the webview.
const marked = new Marked({ gfm: true, breaks: true });

// Drop dangerous nodes/attributes. AI output is semi-trusted; the webview CSP
// also blocks inline scripts, but defence in depth is cheap here.
function sanitize(html: string): string {
  return html
    .replace(/<\/?(script|style|iframe|object|embed|link|meta|base)\b[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"');
}

export function renderMarkdown(srcIn: string): string {
  const src = String(srcIn == null ? "" : srcIn);
  try {
    return sanitize(marked.parse(src, { async: false }) as string);
  } catch {
    // Fallback: render as escaped plain text on parser failure.
    return "<p>" + src.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</p>";
  }
}

export function basename(p: string): string {
  if (!p) return "";
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

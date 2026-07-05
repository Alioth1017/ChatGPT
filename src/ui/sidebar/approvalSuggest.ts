/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { ApprovalActionType } from "../../agent/approvalPolicy";

/** Strip a provider-scoped composite picker id ("<providerId>::<modelId>") to the real id. */
export function stripModelScope(id: string): string {
  const i = id.indexOf("::");
  return i >= 0 ? id.slice(i + 2) : id;
}

/**
 * Suggest an allow/deny pattern for a subject (e.g. "git *", "*.md",
 * "https://x.com/*"), used to pre-fill the approval prompt.
 */
export function suggestPattern(type: ApprovalActionType, toolName: string, subject: string): string | undefined {
  if (type === "shell") {
    const tokens = subject.trim().split(/\s+/);
    if (!tokens[0]) return undefined;
    // Multi-word tools get a "git push *" style prefix; everything else "node *".
    const multi = new Set(["git", "npm", "pnpm", "yarn", "docker", "kubectl", "cargo", "go", "dotnet", "pip", "python", "node", "npx"]);
    const base = multi.has(tokens[0].toLowerCase()) && tokens[1] ? `${tokens[0]} ${tokens[1]}` : tokens[0];
    return `${base} *`;
  }
  if (type === "edits" || type === "delete") {
    const base = subject.replace(/\\/g, "/").split("/").pop() ?? subject;
    const i = base.lastIndexOf(".");
    return i > 0 ? `*${base.slice(i)}` : base || undefined;
  }
  if (type === "outside") {
    // Allowing the containing directory is the least-surprising default.
    const dir = subject.replace(/\\/g, "/").split("/").slice(0, -1).join("/");
    return dir ? `${dir}/**` : undefined;
  }
  if (type === "web") {
    try { return `${new URL(subject).origin}/*`; } catch { return undefined; }
  }
  if (type === "mcp") return toolName;
  return undefined;
}

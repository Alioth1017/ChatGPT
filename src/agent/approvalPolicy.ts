/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

/**
 * Per-action-type approval policy for agent tools.
 *
 * Each action type has a mode plus allow/deny pattern lists:
 *   - "allow"  → run without asking
 *   - "ask"    → prompt the user every time
 *   - "review" → auto-review: allow when it looks safe, ask when risky
 *   - "deny"   → always block
 * Deny list beats allow list beats mode.
 */

export type ApprovalMode = "allow" | "ask" | "review" | "deny";

export interface ApprovalRule {
	mode: ApprovalMode;
	/** Patterns that always allow (command prefix/wildcard, or path glob). */
	allowlist: string[];
	/** Patterns that always deny. */
	denylist: string[];
}

export type ApprovalActionType = "shell" | "edits" | "delete" | "mcp" | "web" | "outside";

export type ApprovalPolicy = Record<ApprovalActionType, ApprovalRule>;

const rule = (mode: ApprovalMode): ApprovalRule => ({ mode, allowlist: [], denylist: [] });

/** Safe defaults: everything prompts until the user loosens it. */
export const DEFAULT_APPROVAL: ApprovalPolicy = {
	shell: rule("ask"),
	edits: rule("ask"),
	delete: rule("ask"),
	mcp: rule("ask"),
	web: rule("ask"),
	outside: rule("ask"),
};

/** Map a tool name to its approval action type (undefined = ungated). */
export function actionTypeFor(toolName: string): ApprovalActionType | undefined {
	if (toolName === "Shell") return "shell";
	if (toolName === "Delete") return "delete";
	if (toolName === "StrReplace" || toolName === "Write" || toolName === "EditNotebook") return "edits";
	if (toolName === "WebSearch" || toolName === "WebFetch") return "web";
	if (toolName.startsWith("mcp__")) return "mcp";
	return undefined;
}

/** Tools whose `path`-like input can reach outside the workspace. */
const PATH_TOOLS = new Set(["Read", "StrReplace", "Write", "Delete", "EditNotebook"]);

/** True when a file path lands outside the workspace root. */
export function isOutsideWorkspace(path: string, root: string | undefined): boolean {
	if (!root || !path) return false;
	const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	const p = norm(path);
	// Relative paths resolve inside the workspace.
	if (!/^([a-z]:\/|\/)/.test(p)) return false;
	return !(p === norm(root) || p.startsWith(norm(root) + "/"));
}

/**
 * Action type for a concrete call: file tools targeting paths outside the
 * workspace escalate to "outside" (covers Read, which is otherwise ungated).
 */
export function actionTypeForCall(toolName: string, input: any, root: string | undefined): ApprovalActionType | undefined {
	if (PATH_TOOLS.has(toolName)) {
		const path = String(input?.path ?? input?.target_notebook ?? "");
		if (isOutsideWorkspace(path, root)) return "outside";
	}
	return actionTypeFor(toolName);
}

/** The string a rule's patterns match against, per action type. */
export function subjectFor(type: ApprovalActionType, toolName: string, input: any): string {
	switch (type) {
		case "shell": return String(input?.command ?? "");
		case "edits":
		case "delete":
		case "outside": return String(input?.path ?? input?.target_notebook ?? "");
		case "web": return String(input?.url ?? input?.search_term ?? input?.query ?? "");
		case "mcp": return toolName;
	}
}

/**
 * Wildcard pattern match. `prefixOk` distinguishes command-like subjects
 * (shell/mcp/web: `*` = any chars, exact/prefix match) from path-like ones
 * (edits/delete: glob semantics with `*` vs `**` + basename fallback).
 */
export function matchPattern(pattern: string, subject: string, prefixOk: boolean): boolean {
	const p = pattern.trim();
	if (!p) return false;
	const s = subject.replace(/\\/g, "/");
	if (p.includes("*")) {
		const esc = p.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		if (prefixOk) {
			// Command-like: `*` crosses everything (slashes included).
			const re = new RegExp(`^(?:${esc.replace(/\*+/g, ".*")})$`, "i");
			return re.test(s);
		}
		// Path-like: `**` crosses dirs, `*` stays within a segment.
		const rx = esc.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
		// Also try matching the basename so "*.md" works without "**/".
		const base = s.split("/").pop() ?? s;
		const re = new RegExp(`^(?:${rx})$`, "i");
		return re.test(s) || re.test(base);
	}
	const pl = p.toLowerCase();
	const sl = s.toLowerCase();
	return prefixOk ? sl === pl || sl.startsWith(pl + " ") || sl.startsWith(pl) : sl === pl || sl.endsWith("/" + pl);
}

// Risky-looking subjects for "review" mode. ponytail: heuristic regexes; swap for
// an LLM judge (autoJudgeModel) if pattern coverage proves too coarse.
const RISKY_SHELL = /(\brm\s+-\w*[rf]|\brmdir\b|\bdel\s+\/|\bformat\b|\bmkfs|\bdd\s+if=|\bshutdown\b|\breboot\b|\bsudo\b|\bchmod\s+777|\bchown\b|\bgit\s+push\s+--force|\bgit\s+reset\s+--hard|\bgit\s+clean|\bnpm\s+publish|\bcurl[^|]*\|\s*(ba)?sh|\bwget[^|]*\|\s*(ba)?sh|Remove-Item.*-Recurse|Stop-Computer|Restart-Computer|\breg\s+delete|\btaskkill)/i;
const RISKY_PATH = /(^|[\\/])(\.env[^\\/]*|.*\.(pem|key|pfx|p12)|id_rsa[^\\/]*|credentials[^\\/]*|secrets?[^\\/]*|\.git[\\/])$/i;

function looksRisky(type: ApprovalActionType, subject: string): boolean {
	if (type === "shell") return RISKY_SHELL.test(subject);
	if (type === "edits" || type === "delete") return type === "delete" || RISKY_PATH.test(subject);
	if (type === "outside") return true; // outside-workspace access is always worth asking about in review mode
	return false; // mcp/web reviewed as safe by default
}

export type ApprovalDecision = "allow" | "ask" | "deny";

/** Evaluate the policy for a tool call: deny list > allow list > mode. */
export function evaluateApproval(policy: ApprovalPolicy, toolName: string, input: any, workspaceRoot?: string): ApprovalDecision {
	const type = actionTypeForCall(toolName, input, workspaceRoot);
	if (!type) return "allow";
	const r = policy[type] ?? DEFAULT_APPROVAL[type];
	const subject = subjectFor(type, toolName, input);
	const prefixOk = type === "shell" || type === "mcp" || type === "web";

	if ((r.denylist ?? []).some((p) => matchPattern(p, subject, prefixOk))) return "deny";
	if ((r.allowlist ?? []).some((p) => matchPattern(p, subject, prefixOk))) return "allow";

	const mode: ApprovalMode = r.mode ?? "ask";
	if (mode === "allow") return "allow";
	if (mode === "deny") return "deny";
	if (mode === "review") return looksRisky(type, subject) ? "ask" : "allow";
	return "ask";
}

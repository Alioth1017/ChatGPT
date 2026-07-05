/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as vscode from "vscode";

/** Cumulative token usage for one model. */
export interface ModelUsage {
	promptTokens: number;
	completionTokens: number;
	requests: number;
	lastUsed: number;
}

const KEY = "ocursor.usage";
let ctx: vscode.ExtensionContext | undefined;

export function initUsage(context: vscode.ExtensionContext) {
	ctx = context;
}

export function getUsage(): Record<string, ModelUsage> {
	return ctx?.globalState.get<Record<string, ModelUsage>>(KEY) ?? {};
}

/** Accumulate tokens for a model. Called on every streamed usage event. */
export async function recordUsage(model: string, promptTokens = 0, completionTokens = 0): Promise<void> {
	if (!ctx || !model) return;
	const all = getUsage();
	const u = all[model] ?? { promptTokens: 0, completionTokens: 0, requests: 0, lastUsed: 0 };
	all[model] = {
		promptTokens: u.promptTokens + promptTokens,
		completionTokens: u.completionTokens + completionTokens,
		requests: u.requests + 1,
		lastUsed: Date.now(),
	};
	await ctx.globalState.update(KEY, all);
}

export async function resetUsage(): Promise<void> {
	await ctx?.globalState.update(KEY, undefined);
}

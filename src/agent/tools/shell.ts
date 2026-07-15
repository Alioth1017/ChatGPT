/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { safePath, getWorkspaceRoot } from "../../context/workspaceUtils";
import { defineTool } from "./types";
import {
  bgShells,
  nextShellId,
  waitForShell,
  renderShell,
  pushShellOutput,
  getShellSession,
  type BgShell,
  type ShellNotify,
} from "./shared";

const SENTINEL = "__OC_SHELL_DONE__";
const isWin = process.platform === "win32";

/** Build a notify_on_output config from the tool input, if present. */
function buildNotify(input: any, ctx: any): ShellNotify | undefined {
  const cfg = input?.notify_on_output;
  if (!cfg || !cfg.pattern) return undefined;
  let re: RegExp;
  try {
    re = new RegExp(String(cfg.pattern));
  } catch {
    return undefined;
  }
  return {
    re,
    reason: String(cfg.reason ?? "output"),
    debounceMs: Math.max(5000, Number(cfg.debounce_ms) || 0),
    lastNotified: 0,
    emit: ctx?.emitShellNotify,
  };
}

// ---- Shell (stateful session; backgrounds a command past block_until_ms) ----
// A persistent shell per run keeps cwd/env across calls. Each command is framed
// by a sentinel echo so we can detect completion and capture the exit code.
export const runTerminalTool = defineTool("Shell", true, async (input, abortSignal, _callId, ctx) => {
  const root = getWorkspaceRoot();
  // Cap foreground wait: default 30s, hard max 90s so a hung command cannot
  // block the agent loop. block_until_ms=0 still backgrounds immediately.
  const rawBlock = typeof input.block_until_ms === "number" ? input.block_until_ms : 30_000;
  const blockMs = rawBlock <= 0 ? 0 : Math.min(Math.max(0, rawBlock), 90_000);
  const command = String(input.command ?? "");

  // Prune finished shells older than 10 minutes to bound the registry.
  for (const [k, v] of bgShells) {
    if (v.done && Date.now() - v.startedAt > 600_000) bgShells.delete(k);
  }

  // Persistent session keyed per run (falls back to a shared key if absent).
  const sessionKey = (ctx as any)?.shellSessionKey ?? "default";
  const session = getShellSession(sessionKey, root);

  const sh: BgShell = {
    id: nextShellId(),
    command,
    proc: session.proc,
    output: "",
    done: false,
    exitCode: null,
    startedAt: Date.now(),
    notify: buildNotify(input, ctx),
  };
  bgShells.set(sh.id, sh);

  // Mark where this command's output begins so we can slice the session buffer.
  const startLen = session.buffer.length;
  let lastSeen = startLen;
  const sentinelRe = new RegExp(SENTINEL + ":(-?\\d+)");

  // Drain this command's slice of the session buffer into the BgShell and
  // detect the sentinel (printed with the exit code) marking completion.
  // Stored on `sh` so AwaitShell can keep draining after we background.
  sh.pump = () => {
    if (session.buffer.length > lastSeen) {
      pushShellOutput(sh, session.buffer.slice(lastSeen));
      lastSeen = session.buffer.length;
    }
    const m = sh.output.match(sentinelRe);
    if (m && !sh.done) {
      sh.exitCode = Number(m[1]);
      sh.done = true;
    }
  };
  const pumpTimer = setInterval(() => sh.pump?.(), 100);

  const killSession = () => {
    try {
      if (process.platform === "win32") session.proc.kill();
      else session.proc.kill("SIGTERM");
    } catch { /* ignore */ }
  };
  const onAbort = () => {
    if (!sh.done) {
      sh.output += "\n(aborted)";
      sh.done = true;
    }
    killSession();
  };
  abortSignal?.addEventListener("abort", onAbort);

  // Optional per-command working directory (a `cd` that does not persist).
  const cd = input.working_directory ? safePath(input.working_directory) : "";
  const wrapped = isWin
    ? `${cd ? `Push-Location -LiteralPath '${cd.replace(/'/g, "''")}'; ` : ""}${command}${cd ? "; Pop-Location" : ""}\nWrite-Output "${SENTINEL}:$LASTEXITCODE"\n`
    : `${cd ? `pushd '${cd.replace(/'/g, "'\\''")}' && ` : ""}${command}\n__oc_rc=$?\n${cd ? "popd >/dev/null 2>&1\n" : ""}echo "${SENTINEL}:$__oc_rc"\n`;
  try {
    session.proc.stdin?.write(wrapped);
  } catch (e) {
    clearInterval(pumpTimer);
    abortSignal?.removeEventListener("abort", onAbort);
    sh.done = true;
    return { output: `error: shell write failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  await waitForShell(sh, blockMs, undefined, abortSignal);
  sh.pump?.();
  clearInterval(pumpTimer);
  abortSignal?.removeEventListener("abort", onAbort);

  // Hard timeout with no sentinel: mark done so AwaitShell does not hang, and
  // note that the process may still be running in the session.
  if (!sh.done && blockMs > 0) {
    sh.output += `\n(timeout after ${blockMs}ms — command still running in background shell ${sh.id}; use AwaitShell or cancel)`;
  }

  // Strip the sentinel line from the rendered body.
  sh.output = sh.output.replace(new RegExp("\\n?" + SENTINEL + ":-?\\d+\\s*"), "");
  return { output: renderShell(sh) };
});

// ---- AwaitShell (poll a backgrounded shell, or just sleep) ----
export const awaitShellTool = defineTool("AwaitShell", false, async (input) => {
  const blockMs = typeof input?.block_until_ms === "number" ? input.block_until_ms : 30_000;
  const id = input?.shell_id ? String(input.shell_id) : "";

  // No shell id: sleep for the full duration (renders nicely vs. sleeping in the
  // shell). shell_id is required for a non-blocking status check (block_until_ms 0).
  if (!id) {
    if (blockMs <= 0) return { output: "error: shell_id is required when block_until_ms is 0" };
    await new Promise((r) => setTimeout(r, blockMs));
    return { output: `Slept for ${blockMs}ms.` };
  }

  const sh = bgShells.get(id);
  if (!sh) {
    // A common misuse is passing a Task/subagent call id (e.g. "toolu_…"). Subagents
    // are NOT shells; they stream their own events and are awaited automatically
    // before the turn ends, so there is nothing to poll here.
    if (/^toolu_|^call_/i.test(id)) {
      return { output: `error: "${id}" looks like a subagent/Task call id, not a background shell. Subagents are not shells — do not poll them with AwaitShell. They stream results on their own and are awaited automatically before your turn ends; just continue or finish.` };
    }
    return { output: `error: no background shell with id ${id}` };
  }

  let pattern: RegExp | undefined;
  if (input?.pattern) {
    try {
      pattern = new RegExp(String(input.pattern), "m");
    } catch (e) {
      return { output: `error: invalid pattern: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  // Cap AwaitShell polls too so a stuck bg job cannot hang the loop forever.
  const capped = blockMs <= 0 ? 0 : Math.min(blockMs, 120_000);
  await waitForShell(sh, capped, pattern);
  return { output: renderShell(sh) };
});

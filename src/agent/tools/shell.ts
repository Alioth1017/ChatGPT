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
  disposeShellSession,
  type BgShell,
  type ShellNotify,
} from "./shared";

const SENTINEL = "__OC_SHELL_DONE__";
const isWin = process.platform === "win32";
/** Default foreground wait for simple commands; hard max keeps the loop responsive. */
const DEFAULT_BLOCK_MS = 15_000;
const MAX_BLOCK_MS = 30_000;
const MAX_AWAIT_MS = 45_000;

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

/**
 * Frame a command so the session always prints a unique sentinel with exit code.
 * PowerShell: use `if ($?)` — `$LASTEXITCODE` is often $null for native/cmdlets
 * and would never emit a sentinel (classic hang).
 */
function wrapCommand(command: string, cd: string): string {
  if (isWin) {
    const loc = cd
      ? `Push-Location -LiteralPath '${cd.replace(/'/g, "''")}'; try { `
      : "";
    const endLoc = cd ? ` } finally { Pop-Location } ` : " ";
    // Always write the sentinel, even if the command throws.
    // Use [Console]::Out so the line is not stuck in PowerShell's output pipeline.
    return (
      `${loc}${command}${endLoc}\n` +
      `if ($?) { [Console]::Out.WriteLine("${SENTINEL}:0") } else { ` +
      `$__oc = if ($null -ne $LASTEXITCODE -and "$LASTEXITCODE" -ne "") { $LASTEXITCODE } else { 1 }; ` +
      `[Console]::Out.WriteLine("${SENTINEL}:$__oc") }\n`
    );
  }
  const push = cd ? `pushd '${cd.replace(/'/g, `'\\''`)}' >/dev/null 2>&1 || true\n` : "";
  const pop = cd ? `popd >/dev/null 2>&1 || true\n` : "";
  return (
    `${push}${command}\n` +
    `__oc_rc=$?\n` +
    `${pop}` +
    `echo "${SENTINEL}:$__oc_rc"\n`
  );
}

// ---- Shell (stateful session; backgrounds a command past block_until_ms) ----
export const runTerminalTool = defineTool("Shell", true, async (input, abortSignal, _callId, ctx) => {
  const root = getWorkspaceRoot();
  const rawBlock = typeof input.block_until_ms === "number" ? input.block_until_ms : DEFAULT_BLOCK_MS;
  const blockMs = rawBlock <= 0 ? 0 : Math.min(Math.max(0, rawBlock), MAX_BLOCK_MS);
  const command = String(input.command ?? "").trim();
  if (!command) return { output: "error: command is required" };

  // Prune finished shells older than 10 minutes to bound the registry.
  for (const [k, v] of bgShells) {
    if (v.done && Date.now() - v.startedAt > 600_000) bgShells.delete(k);
  }

  const sessionKey = (ctx as any)?.shellSessionKey ?? "default";
  let session = getShellSession(sessionKey, root);

  // Serialize commands on this session so sentinels don't interleave.
  // Always settle the queue slot even if this command errors/times out.
  let releaseQueue!: () => void;
  const prev = session.queue.catch(() => {});
  session.queue = new Promise<void>((r) => {
    releaseQueue = r;
  });
  try {
    // Never block forever on a stuck prior command's queue slot.
    await Promise.race([
      prev,
      new Promise<void>((r) => setTimeout(r, MAX_BLOCK_MS + 5_000)),
    ]);
  } catch {
    /* ignore prior failure */
  }
  // Session may have been replaced while we waited.
  session = getShellSession(sessionKey, root);

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

  const startLen = session.buffer.length;
  let lastSeen = startLen;
  const sentinelRe = new RegExp(SENTINEL + ":(-?\\d+)");

  sh.pump = () => {
    try {
      if (session.buffer.length > lastSeen) {
        pushShellOutput(sh, session.buffer.slice(lastSeen));
        lastSeen = session.buffer.length;
      }
      const m = sh.output.match(sentinelRe);
      if (m && !sh.done) {
        sh.exitCode = Number(m[1]);
        sh.done = true;
      }
      // Dead process with no sentinel → force complete so we never hang.
      if (!sh.done && (session.proc.killed || session.proc.exitCode != null)) {
        sh.exitCode = session.proc.exitCode ?? 1;
        sh.done = true;
        sh.output += "\n(shell session exited)";
      }
    } catch (e) {
      if (!sh.done) {
        sh.done = true;
        sh.exitCode = 1;
        sh.output += `\n(pump error: ${e instanceof Error ? e.message : String(e)})`;
      }
    }
  };

  const killSession = () => {
    try {
      disposeShellSession(sessionKey);
    } catch {
      /* ignore */
    }
  };
  const onAbort = () => {
    if (!sh.done) {
      sh.output += "\n(aborted)";
      sh.done = true;
      sh.exitCode = sh.exitCode ?? 130;
    }
    killSession();
  };
  abortSignal?.addEventListener("abort", onAbort);

  const cd = input.working_directory ? safePath(input.working_directory) : "";
  const wrapped = wrapCommand(command, cd);

  try {
    const stdin = session.proc.stdin;
    if (!stdin || stdin.destroyed) {
      killSession();
      session = getShellSession(sessionKey, root);
      sh.proc = session.proc;
    }
    const ok = session.proc.stdin?.write(wrapped);
    if (ok === false) {
      // Backpressure: wait briefly for drain, then continue (pump still works).
      await new Promise<void>((r) => {
        const t = setTimeout(r, 2_000);
        session.proc.stdin?.once("drain", () => {
          clearTimeout(t);
          r();
        });
      });
    }
  } catch (e) {
    abortSignal?.removeEventListener("abort", onAbort);
    sh.done = true;
    sh.exitCode = 1;
    releaseQueue();
    return {
      output: `error: shell write failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  try {
    await waitForShell(sh, blockMs, undefined, abortSignal);
    try {
      sh.pump?.();
    } catch {
      /* ignore */
    }

    // Timed out with no sentinel: do NOT leave a hung command poisoning the
    // session — kill and respawn so the next Shell call is clean.
    if (!sh.done && blockMs > 0) {
      sh.output += `\n(timeout after ${blockMs}ms — session reset; re-run with a shorter command or block_until_ms=0 to background)`;
      sh.done = true;
      sh.exitCode = sh.exitCode ?? 124;
      killSession();
    } else if (!sh.done && blockMs === 0) {
      // Immediate background: keep pumping via interval until done/timeout later.
      const bgPump = setInterval(() => {
        try {
          sh.pump?.();
        } catch {
          /* ignore */
        }
        if (sh.done) clearInterval(bgPump);
      }, 100);
      // Hard stop background pump after 10 min.
      setTimeout(() => clearInterval(bgPump), 600_000).unref?.();
    }

    // Strip the sentinel line from the rendered body.
    sh.output = sh.output.replace(new RegExp("\\n?" + SENTINEL + ":-?\\d+\\s*"), "");
    return { output: renderShell(sh) };
  } catch (e) {
    if (!sh.done) {
      sh.done = true;
      sh.exitCode = 1;
      sh.output += `\n(error: ${e instanceof Error ? e.message : String(e)})`;
    }
    killSession();
    return { output: renderShell(sh) };
  } finally {
    abortSignal?.removeEventListener("abort", onAbort);
    releaseQueue();
  }
});

// ---- AwaitShell (poll a backgrounded shell, or just sleep) ----
export const awaitShellTool = defineTool("AwaitShell", false, async (input, abortSignal) => {
  const raw = typeof input?.block_until_ms === "number" ? input.block_until_ms : 15_000;
  const blockMs = raw <= 0 ? 0 : Math.min(raw, MAX_AWAIT_MS);
  const id = input?.shell_id ? String(input.shell_id) : "";

  if (!id) {
    if (blockMs <= 0) return { output: "error: shell_id is required when block_until_ms is 0" };
    await new Promise<void>((r) => {
      const t = setTimeout(r, blockMs);
      const onAbort = () => {
        clearTimeout(t);
        r();
      };
      if (abortSignal?.aborted) {
        clearTimeout(t);
        r();
        return;
      }
      abortSignal?.addEventListener("abort", onAbort, { once: true });
    });
    return { output: `Slept for ${blockMs}ms.` };
  }

  const sh = bgShells.get(id);
  if (!sh) {
    if (/^toolu_|^call_/i.test(id)) {
      return {
        output: `error: "${id}" looks like a subagent/Task call id, not a background shell. Subagents are not shells — do not poll them with AwaitShell.`,
      };
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

  try {
    await waitForShell(sh, blockMs, pattern, abortSignal);
    try {
      sh.pump?.();
    } catch {
      /* ignore */
    }
    sh.output = sh.output.replace(new RegExp("\\n?" + SENTINEL + ":-?\\d+\\s*"), "");
    return { output: renderShell(sh) };
  } catch (e) {
    return {
      output: `error: AwaitShell failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
});

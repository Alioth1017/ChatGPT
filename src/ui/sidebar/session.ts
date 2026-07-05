/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import type { Turn } from "../../shared/turns";
import type { ApprovalActionType } from "../../agent/approvalPolicy";

/** An in-chat approval request awaiting the user's decision. */
export interface PendingApproval {
  requestId: string;
  convId: string;
  /** Tool call this approval belongs to (renders the prompt on that tool card). */
  callId?: string;
  toolName: string;
  actionType: ApprovalActionType;
  subject: string;
  detail: string;
  /** Suggested allow/deny pattern (command prefix or path glob). */
  suggestion?: string;
  input: any;
}

/** State for one independent agent run, keyed by conversation id. */
export interface RunSession {
  abort: AbortController;
  subagentAborts: Map<string, () => void>;
  pendingQuestions: Map<string, (answers: Record<string, string[]>) => void>;
  /** In-chat approval requests keyed by requestId. */
  pendingApprovals: Map<string, { info: PendingApproval; resolve: (ok: boolean) => void }>;
  /** Authoritative live UI turns, owned by the host so the run survives any webview churn. */
  turns: Turn[];
  /** Pending throttled persist timer. */
  persistTimer?: NodeJS.Timeout;
}

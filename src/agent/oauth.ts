/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as vscode from "vscode";
import * as crypto from "crypto";
import * as http from "http";
import { ProviderEvent, ToolSchema, WireMessage } from "./types";
import { ChatHTTPError, applyAnthropicReasoning } from "./provider";

export type {
  OAuthKind,
  OAuthAccount,
  OAuthBalanceStrategy,
  OAuthLimit,
  OAuthUsage,
  OAuthAccountInfo,
  OAuthStatus,
} from "./oauth/types";
import type {
  OAuthKind,
  OAuthAccount,
  OAuthBalanceStrategy,
  OAuthLimit,
  OAuthUsage,
  OAuthAccountInfo,
  OAuthStatus,
} from "./oauth/types";

export const BALANCE_LABELS: Record<OAuthBalanceStrategy, string> = {
  "first": "First account",
  "round-robin": "Round robin",
  "highest-limit": "Highest remaining limit",
  "nearest-reset": "Nearest reset time",
};

// ---- Constants (verified against auth2api / codex-rs / claude-code) ----

const ANTHROPIC = {
  authUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://api.anthropic.com/v1/oauth/token",
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  port: 54545,
  path: "/callback",
  scope: "org:create_api_key user:profile user:inference",
  models: ["claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6", "claude-opus-4-5", "claude-haiku-4-5"],
} as const;

const CODEX = {
  authUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  port: 1455,
  path: "/auth/callback",
  scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
  originator: "codex_cli_rs",
  cliVersion: "0.125.0",
  responsesUrl: "https://chatgpt.com/backend-api/codex/responses",
  modelsUrl: "https://chatgpt.com/backend-api/codex/models",
  fallbackModels: ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"],
} as const;

const ANTIGRAVITY = {
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userInfoUrl: "https://www.googleapis.com/oauth2/v1/userinfo",
  clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  clientSecret: "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",
  port: 8723,
  path: "/callback",
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ],
  loadCodeAssistUrl: "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
  onboardUserUrl: "https://cloudcode-pa.googleapis.com/v1internal:onboardUser",
  quotaUrl: "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
  apiBase: "https://daily-cloudcode-pa.googleapis.com",
  userAgent: "antigravity/1.107.0",
  apiClient: "google-cloud-sdk vscode_cloudshelleditor/0.1",
  models: ["gemini-3-flash-agent", "gemini-3.5-flash-low", "gemini-pro-agent", "gemini-3.1-pro-low", "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium", "gemini-3-flash"],
} as const;

export const OAUTH_LABEL: Record<OAuthKind, string> = { "claude-code": "Claude Code", codex: "OpenAI Codex", antigravity: "Google Antigravity" };

const redirectUri = (k: OAuthKind) =>
  k === "claude-code" ? `http://localhost:${ANTHROPIC.port}${ANTHROPIC.path}`
  : k === "codex" ? `http://localhost:${CODEX.port}${CODEX.path}`
  : `http://localhost:${ANTIGRAVITY.port}${ANTIGRAVITY.path}`;

// ---- Module state ----

let ctx: vscode.ExtensionContext | undefined;
/** Live in-memory accounts keyed by account id. */
const accounts = new Map<string, OAuthAccount>();
let pendingKind: OAuthKind | undefined;
const loginErrors: Partial<Record<OAuthKind, string>> = {};
const emitter = new vscode.EventEmitter<OAuthStatus>();
export const onOAuthStatus = emitter.event;
/** In-flight login per kind: pkce + state + loopback server. */
const pending = new Map<OAuthKind, { verifier: string; state: string; server: http.Server }>();
/** Single-flight refresh lock per account id (Codex rotates refresh tokens). */
const refreshing = new Map<string, Promise<OAuthAccount>>();

/** Index of account ids persisted in globalState. */
const INDEX_KEY = "ocursor.oauth.accountIds";
const SECRET_KEY = (id: string) => `ocursor.oauth.acct.${id}`;

export function initOAuth(context: vscode.ExtensionContext) {
  ctx = context;
  const ids = ctx.globalState.get<string[]>(INDEX_KEY, []) ?? [];
  void Promise.all(ids.map(async (id) => {
    const raw = await ctx?.secrets.get(SECRET_KEY(id));
    if (!raw) return;
    try {
      const acc = JSON.parse(raw) as OAuthAccount;
      accounts.set(acc.id, acc);
    } catch {
      /* skip corrupt */
    }
  })).then(() => emit());
}

function info(acc: OAuthAccount): OAuthAccountInfo {
  return { id: acc.id, kind: acc.kind, email: acc.email, accountId: acc.accountId, disabled: acc.disabled };
}

function emit() {
  emitter.fire(getStatus());
}

export function getStatus(): OAuthStatus {
  return { accounts: [...accounts.values()].map(info), pending: pendingKind, errors: { ...loginErrors }, balanceStrategy: getBalanceStrategy() };
}

// ---- Enable/disable + load balancing ----

const STRATEGY_KEY = "ocursor.oauth.balanceStrategy";
/** Round-robin cursor per kind (session-scoped). */
const rrCursor = new Map<OAuthKind, number>();

export function getBalanceStrategy(): OAuthBalanceStrategy {
  return ctx?.globalState.get<OAuthBalanceStrategy>(STRATEGY_KEY) ?? "first";
}

export async function setBalanceStrategy(s: OAuthBalanceStrategy) {
  await ctx?.globalState.update(STRATEGY_KEY, s);
  emit();
}

export async function setAccountEnabled(id: string, enabled: boolean) {
  const acc = accounts.get(id);
  if (!acc) return;
  await saveAccount({ ...acc, disabled: !enabled });
  emit();
}

/** Enabled accounts of a kind, in insertion order. */
function enabledOfKind(kind: OAuthKind): OAuthAccount[] {
  return [...accounts.values()].filter((a) => a.kind === kind && !a.disabled);
}

/** Pick the account to use for a request, honoring the balance strategy. */
async function pickAccount(kind: OAuthKind): Promise<OAuthAccount | undefined> {
  const pool = enabledOfKind(kind);
  if (pool.length <= 1) return pool[0];
  const strategy = getBalanceStrategy();
  if (strategy === "round-robin") {
    const i = (rrCursor.get(kind) ?? -1) + 1;
    rrCursor.set(kind, i);
    return pool[i % pool.length];
  }
  if (strategy === "highest-limit" || strategy === "nearest-reset") {
    // Score each account by its limits; fall back to first on any failure.
    const scored = await Promise.all(pool.map(async (a) => {
      try {
        const u = await getAccountLimits(a.id);
        const remaining = u.limits.length ? Math.min(...u.limits.map((l) => l.remaining)) : 100;
        const resetAt = Math.min(...u.limits.map((l) => l.resetsAt ?? Number.MAX_SAFE_INTEGER));
        return { a, remaining, resetAt };
      } catch {
        return { a, remaining: -1, resetAt: Number.MAX_SAFE_INTEGER };
      }
    }));
    if (strategy === "highest-limit") scored.sort((x, y) => y.remaining - x.remaining);
    else scored.sort((x, y) => x.resetAt - y.resetAt);
    return scored[0]?.a ?? pool[0];
  }
  return pool[0];
}

export function listAccounts(): OAuthAccountInfo[] {
  return [...accounts.values()].map(info);
}

/** Any enabled account of the given kind connected? */
export function isConnected(kind: OAuthKind): boolean {
  return [...accounts.values()].some((a) => a.kind === kind && !a.disabled);
}

export function hasAnyAccount(): boolean {
  return accounts.size > 0;
}

// ---- PKCE ----

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function pkce() {
  const verifier = b64url(crypto.randomBytes(96));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// ---- Persistence ----

async function saveAccount(acc: OAuthAccount) {
  accounts.set(acc.id, acc);
  await ctx?.secrets.store(SECRET_KEY(acc.id), JSON.stringify(acc));
  await ctx?.globalState.update(INDEX_KEY, [...accounts.keys()]);
}

export async function disconnect(id: string) {
  accounts.delete(id);
  await ctx?.secrets.delete(SECRET_KEY(id));
  await ctx?.globalState.update(INDEX_KEY, [...accounts.keys()]);
  emit();
}

// ---- Login flow (loopback redirect) ----

export async function login(kind: OAuthKind) {
  // Tear down any previous attempt for this kind.
  pending.get(kind)?.server.close();
  pending.delete(kind);
  delete loginErrors[kind];

  const { verifier, challenge } = pkce();
  const state = crypto.randomBytes(16).toString("hex");
  const cfg = kind === "claude-code" ? ANTHROPIC : kind === "codex" ? CODEX : ANTIGRAVITY;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://localhost:${cfg.port}`);
      if (!url.pathname.startsWith(cfg.path)) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code") || "";
      const retState = url.searchParams.get("state") || "";
      res.writeHead(200, { "content-type": "text/html" }).end(
        "<html><body style='font-family:sans-serif;padding:40px'><h2>Login successful</h2><p>You can close this tab and return to VS Code.</p></body></html>"
      );
      server.close();
      pending.delete(kind);
      pendingKind = undefined;
      await completeLogin(kind, code, retState, state, verifier);
    } catch (e: any) {
      loginErrors[kind] = String(e?.message || e);
      pendingKind = undefined;
      emit();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(cfg.port, "127.0.0.1", resolve);
  });

  pending.set(kind, { verifier, state, server });
  pendingKind = kind;
  emit();

  const authUrl = buildAuthUrl(kind, challenge, state);
  await vscode.env.openExternal(vscode.Uri.parse(authUrl));
}

export function cancelLogin(kind: OAuthKind) {
  pending.get(kind)?.server.close();
  pending.delete(kind);
  pendingKind = undefined;
  emit();
}

/**
 * Manual fallback: the user pastes the callback URL (or just "code#state" /
 * the raw code) when the loopback redirect never reaches us.
 */
export async function completeManual(kind: OAuthKind, pasted: string): Promise<void> {
  const p = pending.get(kind);
  if (!p) throw new Error("No login in progress — click Add account first");
  let code = "";
  let retState = p.state;
  const text = pasted.trim();
  try {
    const url = new URL(text);
    code = url.searchParams.get("code") || "";
    retState = url.searchParams.get("state") || retState;
  } catch {
    // Not a URL — accept "code#state" (Anthropic's copy box) or a bare code.
    const [c, s] = text.split("#");
    code = c;
    if (s) retState = s;
  }
  try {
    p.server.close();
    pending.delete(kind);
    pendingKind = undefined;
    await completeLogin(kind, code, retState, p.state, p.verifier);
  } catch (e: any) {
    loginErrors[kind] = String(e?.message || e);
    emit();
    throw e;
  }
}

function buildAuthUrl(kind: OAuthKind, challenge: string, state: string): string {
  if (kind === "claude-code") {
    // Anthropic requires unencoded colons + `+`-joined scope and a `code=true` flag.
    const scope = ANTHROPIC.scope.replace(/ /g, "+");
    return (
      `${ANTHROPIC.authUrl}?code=true` +
      `&client_id=${ANTHROPIC.clientId}` +
      `&response_type=code` +
      `&redirect_uri=${encodeURIComponent(redirectUri(kind))}` +
      `&code_challenge=${challenge}` +
      `&code_challenge_method=S256` +
      `&state=${state}` +
      `&scope=${scope}`
    );
  }
  if (kind === "antigravity") {
    // Standard Google OAuth2 code flow (no PKCE; uses client secret).
    const params = new URLSearchParams({
      client_id: ANTIGRAVITY.clientId,
      response_type: "code",
      redirect_uri: redirectUri(kind),
      scope: ANTIGRAVITY.scopes.join(" "),
      state,
      access_type: "offline",
      prompt: "consent",
    });
    return `${ANTIGRAVITY.authUrl}?${params.toString()}`;
  }
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CODEX.clientId,
    redirect_uri: redirectUri(kind),
    scope: CODEX.scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: CODEX.originator,
  });
  return `${CODEX.authUrl}?${params.toString()}`;
}

async function completeLogin(kind: OAuthKind, code: string, retState: string, expectState: string, verifier: string) {
  if (!code) throw new Error("No authorization code returned");
  if (retState !== expectState) throw new Error("OAuth state mismatch");
  const acc = kind === "claude-code" ? await exchangeAnthropic(code, verifier, expectState)
    : kind === "codex" ? await exchangeCodex(code, verifier)
    : await exchangeAntigravity(code);
  await saveAccount(acc);
  emit();
}

// ---- Token exchange / refresh ----

function decodeJwt(token: string): any {
  try {
    const payload = token.split(".")[1];
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/** Build a stable account id; fall back to a random suffix if no native id. */
function accountId(kind: OAuthKind, nativeId?: string): string {
  return `${kind}:${nativeId || crypto.randomBytes(6).toString("hex")}`;
}

async function exchangeAnthropic(code: string, verifier: string, state: string): Promise<OAuthAccount> {
  const r = await fetch(ANTHROPIC.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      grant_type: "authorization_code",
      client_id: ANTHROPIC.clientId,
      redirect_uri: redirectUri("claude-code"),
      code_verifier: verifier,
      state,
    }),
  });
  if (!r.ok) throw new Error(`Anthropic token exchange ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d: any = await r.json();
  const acctUuid = d.account?.uuid;
  return {
    id: accountId("claude-code", acctUuid),
    kind: "claude-code",
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    expiresAt: Date.now() + (d.expires_in ?? 3600) * 1000,
    email: d.account?.email_address,
    accountId: acctUuid,
  };
}

async function exchangeCodex(code: string, verifier: string): Promise<OAuthAccount> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri("codex"),
    client_id: CODEX.clientId,
    code_verifier: verifier,
  });
  const r = await fetch(CODEX.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!r.ok) throw new Error(`Codex token exchange ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d: any = await r.json();
  const claims = decodeJwt(d.id_token || "");
  const authClaims = claims["https://api.openai.com/auth"] || {};
  const chatgptAccountId = authClaims.chatgpt_account_id || claims.chatgpt_account_id || "";
  return {
    id: accountId("codex", chatgptAccountId),
    kind: "codex",
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    idToken: d.id_token,
    expiresAt: Date.now() + (d.expires_in ?? 3600) * 1000,
    email: claims.email,
    accountId: chatgptAccountId,
  };
}

const AG_METADATA = { ideType: 9, platform: 1, pluginType: 2 };

function agHeaders(token: string) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": ANTIGRAVITY.userAgent,
    "x-goog-api-client": ANTIGRAVITY.apiClient,
  };
}

async function exchangeAntigravity(code: string): Promise<OAuthAccount> {
  const r = await fetch(ANTIGRAVITY.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: ANTIGRAVITY.clientId,
      client_secret: ANTIGRAVITY.clientSecret,
      code,
      redirect_uri: redirectUri("antigravity"),
    }).toString(),
  });
  if (!r.ok) throw new Error(`Antigravity token exchange ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d: any = await r.json();
  const token = d.access_token as string;

  // Identify the user + resolve the Google Cloud project for Code Assist.
  let email: string | undefined;
  try {
    const ui = await fetch(`${ANTIGRAVITY.userInfoUrl}?alt=json`, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
    if (ui.ok) email = ((await ui.json()) as any)?.email;
  } catch { /* non-fatal */ }

  const { projectId, tierId } = await agLoadCodeAssist(token);
  if (projectId && tierId) { try { await agOnboard(token, tierId); } catch { /* best effort */ } }

  return {
    id: accountId("antigravity", email || projectId),
    kind: "antigravity",
    accessToken: token,
    refreshToken: d.refresh_token,
    expiresAt: Date.now() + (d.expires_in ?? 3600) * 1000,
    email,
    accountId: email,
    projectId,
  };
}

async function agLoadCodeAssist(token: string): Promise<{ projectId?: string; tierId?: string }> {
  const r = await fetch(ANTIGRAVITY.loadCodeAssistUrl, {
    method: "POST",
    headers: agHeaders(token),
    body: JSON.stringify({ metadata: AG_METADATA }),
  });
  if (!r.ok) return {};
  const d: any = await r.json();
  let projectId = d.cloudaicompanionProject;
  if (projectId && typeof projectId === "object") projectId = projectId.id;
  let tierId = "legacy-tier";
  if (Array.isArray(d.allowedTiers)) {
    const def = d.allowedTiers.find((t: any) => t.isDefault && t.id);
    if (def) tierId = String(def.id).trim();
  }
  return { projectId, tierId };
}

async function agOnboard(token: string, tierId: string) {
  await fetch(ANTIGRAVITY.onboardUserUrl, {
    method: "POST",
    headers: agHeaders(token),
    body: JSON.stringify({ tierId, metadata: AG_METADATA }),
  });
}

async function refreshAccount(acc: OAuthAccount): Promise<OAuthAccount> {
  const existing = refreshing.get(acc.id);
  if (existing) return existing;
  const p = (async () => {
    let next: OAuthAccount;
    if (acc.kind === "claude-code") {
      const r = await fetch(ANTHROPIC.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: ANTHROPIC.clientId, grant_type: "refresh_token", refresh_token: acc.refreshToken }),
      });
      if (!r.ok) throw new Error(`Anthropic refresh ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const d: any = await r.json();
      next = { ...acc, accessToken: d.access_token, refreshToken: d.refresh_token || acc.refreshToken, expiresAt: Date.now() + (d.expires_in ?? 3600) * 1000 };
    } else if (acc.kind === "antigravity") {
      const r = await fetch(ANTIGRAVITY.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: ANTIGRAVITY.clientId, client_secret: ANTIGRAVITY.clientSecret, refresh_token: acc.refreshToken }).toString(),
      });
      if (!r.ok) throw new Error(`Antigravity refresh ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const d: any = await r.json();
      next = { ...acc, accessToken: d.access_token, refreshToken: d.refresh_token || acc.refreshToken, expiresAt: Date.now() + (d.expires_in ?? 3600) * 1000 };
    } else {
      const r = await fetch(CODEX.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: CODEX.clientId, grant_type: "refresh_token", refresh_token: acc.refreshToken }),
      });
      if (!r.ok) throw new Error(`Codex refresh ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const d: any = await r.json();
      next = { ...acc, accessToken: d.access_token, refreshToken: d.refresh_token || acc.refreshToken, idToken: d.id_token || acc.idToken, expiresAt: Date.now() + (d.expires_in ?? 3600) * 1000 };
    }
    await saveAccount(next);
    return next;
  })();
  refreshing.set(acc.id, p);
  try {
    return await p;
  } finally {
    refreshing.delete(acc.id);
  }
}

/** Return an account with a fresh access token (refreshing if near expiry). */
async function validAccount(id: string): Promise<OAuthAccount> {
  const acc = accounts.get(id);
  if (!acc) throw new Error(`Account ${id} is not connected`);
  // Refresh 5 min before expiry.
  if (Date.now() > acc.expiresAt - 5 * 60 * 1000) {
    try {
      return await refreshAccount(acc);
    } catch (e) {
      loginErrors[acc.kind] = String((e as any)?.message || e);
      emit();
      throw e;
    }
  }
  return acc;
}

/** First enabled account of a kind (default for routing). */
function firstOfKind(kind: OAuthKind): OAuthAccount | undefined {
  return [...accounts.values()].find((a) => a.kind === kind && !a.disabled);
}

// ---- Usage limits ----
// ponytail: placeholder values — real limit-fetching backend wired in later.

/** Parse a reset value (epoch s/ms or ISO string) into epoch ms. */
function parseResetMs(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    if (/^\d+$/.test(v)) { const n = Number(v); return n < 1e12 ? n * 1000 : n; }
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

export async function getAccountLimits(id: string): Promise<OAuthUsage> {
  const acc = accounts.get(id);
  if (!acc) return { limits: [] };
  const fresh = await validAccount(id);
  if (fresh.kind === "claude-code") return { limits: await getClaudeLimits(fresh) };
  if (fresh.kind === "antigravity") return { limits: await getAntigravityLimits(fresh) };
  return getCodexUsage(fresh);
}

// Claude Code usage: % utilization per rolling window (5h + weekly).
async function getClaudeLimits(acc: OAuthAccount): Promise<OAuthLimit[]> {
  const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      authorization: `Bearer ${acc.accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
    },
  });
  if (!r.ok) throw new Error(`Claude usage ${r.status}`);
  const d: any = await r.json();
  const out: OAuthLimit[] = [];
  const win = (w: any, label: string) => {
    if (!w || typeof w.utilization !== "number") return;
    out.push({ label, remaining: Math.max(0, 100 - Math.round(w.utilization)), limit: 100, resetsAt: parseResetMs(w.resets_at) });
  };
  win(d.five_hour, "Session (5h)");
  win(d.seven_day, "Weekly (7d)");
  for (const [k, v] of Object.entries(d)) {
    if (k.startsWith("seven_day_") && k !== "seven_day") win(v, `Weekly ${k.slice("seven_day_".length)} (7d)`);
  }
  return out;
}

// Codex usage: rate_limit primary/secondary windows + available reset credits.
async function getCodexUsage(acc: OAuthAccount): Promise<OAuthUsage> {
  const r = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: { authorization: `Bearer ${acc.accessToken}`, accept: "application/json" },
  });
  if (!r.ok) throw new Error(`Codex usage ${r.status}`);
  const d: any = await r.json();
  const rl = d.rate_limit ?? d.rate_limits ?? d.rate_limits_by_limit_id?.codex ?? d;
  const limits: OAuthLimit[] = [];
  const win = (w: any, label: string) => {
    if (!w) return;
    const used = Number(w.used_percent ?? w.percent_used ?? 0);
    limits.push({ label, remaining: Math.max(0, Math.min(100, 100 - Math.round(used))), limit: 100, resetsAt: parseResetMs(w.reset_at ?? w.resets_at ?? w.resetAt) });
  };
  win(rl.primary_window ?? rl.primary, "Session (5h)");
  win(rl.secondary_window ?? rl.secondary, "Weekly");
  const resetCredits = Math.max(0, Number(d.rate_limit_reset_credits?.available_count ?? 0));
  return { limits, resetCredits };
}

/** Spend one Codex rate-limit reset credit (irreversible). Returns true on success. */
export async function consumeCodexResetCredit(id: string): Promise<{ ok: boolean; message?: string }> {
  const acc = accounts.get(id);
  if (!acc || acc.kind !== "codex") return { ok: false, message: "Not a Codex account" };
  const fresh = await validAccount(id);
  const redeemId = crypto.randomUUID();
  const r = await fetch("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume", {
    method: "POST",
    headers: { authorization: `Bearer ${fresh.accessToken}`, accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ redeem_request_id: redeemId }),
  });
  const text = await r.text();
  const d: any = text ? JSON.parse(text) : null;
  const ok = r.ok && (d?.code === "reset" || Number(d?.windows_reset ?? 0) > 0);
  return { ok, message: d?.message || (d?.code === "no_credit" ? "No reset credits available" : undefined) };
}

// Antigravity usage: per-model remainingFraction via fetchAvailableModels.
async function getAntigravityLimits(acc: OAuthAccount): Promise<OAuthLimit[]> {
  const r = await fetch(ANTIGRAVITY.quotaUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${acc.accessToken}`,
      "user-agent": ANTIGRAVITY.userAgent,
      "content-type": "application/json",
      "x-request-source": "local",
    },
    body: JSON.stringify(acc.projectId ? { project: acc.projectId } : {}),
  });
  if (!r.ok) throw new Error(`Antigravity usage ${r.status}`);
  const d: any = await r.json();
  const out: OAuthLimit[] = [];
  for (const [key, info] of Object.entries<any>(d.models ?? {})) {
    if (!info?.quotaInfo || info.isInternal) continue;
    if (!(ANTIGRAVITY.models as readonly string[]).includes(key)) continue;
    const remaining = Number(info.quotaInfo.remainingFraction ?? 0);
    out.push({ label: info.displayName || key, remaining: Math.max(0, Math.min(100, Math.round(remaining * 100))), limit: 100, resetsAt: parseResetMs(info.quotaInfo.resetTime) });
  }
  return out;
}

// ---- Model listing ----

export async function listOAuthModels(kind: OAuthKind): Promise<string[]> {
  if (kind === "claude-code") {
    const acc = firstOfKind("claude-code");
    if (!acc) return [...ANTHROPIC.models];
    try {
      const fresh = await validAccount(acc.id);
      // /v1/models is reachable with the OAuth bearer + oauth beta header.
      const r = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
        headers: {
          authorization: `Bearer ${fresh.accessToken}`,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "oauth-2025-04-20",
          "anthropic-dangerous-direct-browser-access": "true",
        },
      });
      if (r.ok) {
        const d: any = await r.json();
        const ids = (d?.data ?? []).map((m: any) => m.id).filter(Boolean);
        if (ids.length) return ids;
      }
    } catch {
      /* fall through to preset */
    }
    return [...ANTHROPIC.models];
  }
  if (kind === "antigravity") {
    const acc = firstOfKind("antigravity");
    if (!acc) return [...ANTIGRAVITY.models];
    try {
      const fresh = await validAccount(acc.id);
      const r = await fetch(ANTIGRAVITY.quotaUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${fresh.accessToken}`, "user-agent": ANTIGRAVITY.userAgent, "content-type": "application/json", "x-request-source": "local" },
        body: JSON.stringify(fresh.projectId ? { project: fresh.projectId } : {}),
      });
      if (r.ok) {
        const d: any = await r.json();
        const ids = Object.entries<any>(d.models ?? {})
          .filter(([, info]) => info?.quotaInfo && !info.isInternal)
          .map(([id]) => id);
        if (ids.length) return ids;
      }
    } catch {
      /* fall through to preset */
    }
    return [...ANTIGRAVITY.models];
  }
  const acc = firstOfKind("codex");
  if (!acc) return [...CODEX.fallbackModels];
  try {
    const fresh = await validAccount(acc.id);
    const r = await fetch(`${CODEX.modelsUrl}?client_version=ocursor`, {
      headers: {
        authorization: `Bearer ${fresh.accessToken}`,
        accept: "application/json",
        ...(fresh.accountId ? { "ChatGPT-Account-ID": fresh.accountId } : {}),
      },
    });
    if (r.ok) {
      const d: any = await r.json();
      const ids = (d?.models ?? []).map((m: any) => m.slug).filter(Boolean);
      if (ids.length) return ids;
    }
  } catch {
    /* fall through to fallback list */
  }
  return [...CODEX.fallbackModels];
}

/** Whether a model id belongs to a connected OAuth provider. */
export async function oauthKindForModel(modelId: string): Promise<OAuthKind | undefined> {
  if (isConnected("claude-code") && /^claude-/i.test(modelId)) return "claude-code";
  if (isConnected("codex") && /^(gpt-5(\.|-|$)|o\d|codex-)/i.test(modelId)) return "codex";
  return undefined;
}

// ---- Chat streaming ----

export async function* streamOAuthChat(kind: OAuthKind, opts: {
  model: string;
  messages: WireMessage[];
  tools?: ToolSchema[];
  maxTokens?: number;
  modelParams?: { thinking?: string; reasoningEffort?: string; maxContext?: string };
  signal: AbortSignal;
}): AsyncGenerator<ProviderEvent> {
  const acc = (await pickAccount(kind)) ?? firstOfKind(kind);
  if (!acc) throw new Error(`${OAUTH_LABEL[kind]} is not connected`);
  if (kind === "claude-code") return yield* streamClaudeCode(acc.id, opts);
  if (kind === "antigravity") return yield* streamAntigravity(acc.id, opts);
  return yield* streamCodex(acc.id, opts);
}

// Claude Code reuses Anthropic message shaping but with Bearer + oauth beta and
// the mandated "You are Claude Code" system prefix.
async function* streamClaudeCode(id: string, opts: {
  model: string;
  messages: WireMessage[];
  tools?: ToolSchema[];
  maxTokens?: number;
  modelParams?: { thinking?: string; reasoningEffort?: string; maxContext?: string };
  signal: AbortSignal;
}): AsyncGenerator<ProviderEvent> {
  const acc = await validAccount(id);
  const { system, messages } = toAnthropic(opts.messages);
  // OAuth requires the Claude Code identity as the first system block.
  system.unshift({ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." });
  const maxTokens = opts.maxTokens && opts.maxTokens > 0 ? opts.maxTokens : 8192;
  const body: Record<string, unknown> = { model: opts.model, system, messages, stream: true, max_tokens: maxTokens };
  const reasoningBetas = applyAnthropicReasoning(body, opts.model, maxTokens, opts.modelParams);
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
  }

  const betas = ["oauth-2025-04-20", ...reasoningBetas];
  if (opts.modelParams?.maxContext === "1m") betas.push("context-1m-2025-08-07");
  const r = await fetch("https://api.anthropic.com/v1/messages?beta=true", {
    method: "POST",
    headers: {
      authorization: `Bearer ${acc.accessToken}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": betas.join(","),
      "anthropic-dangerous-direct-browser-access": "true",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!r.ok || !r.body) {
    throw new ChatHTTPError(r.status, `claude-code ${r.status}: ${(await r.text().catch(() => "")).slice(0, 500)}`);
  }
  yield* parseAnthropicStream(r.body.getReader());
}

// Codex talks the Responses API: translate chat messages → input items, stream
// Responses SSE → ProviderEvents.
async function* streamCodex(id: string, opts: {
  model: string;
  messages: WireMessage[];
  tools?: ToolSchema[];
  modelParams?: { reasoningEffort?: string };
  signal: AbortSignal;
}): AsyncGenerator<ProviderEvent> {
  const acc = await validAccount(id);
  const { instructions, input } = toResponsesInput(opts.messages);
  const body: Record<string, unknown> = {
    model: opts.model,
    instructions: instructions || "",
    input,
    stream: true,
    store: false,
  };
  body.reasoning = { effort: opts.modelParams?.reasoningEffort || "medium", summary: "auto" };
  if (opts.tools?.length) {
    body.tools = opts.tools.map((t) => ({ type: "function", name: t.function.name, description: t.function.description, parameters: t.function.parameters }));
  }

  const r = await fetch(CODEX.responsesUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${acc.accessToken}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      originator: CODEX.originator,
      version: CODEX.cliVersion,
      "user-agent": `codex_cli_rs/${CODEX.cliVersion}`,
      ...(acc.accountId ? { "ChatGPT-Account-ID": acc.accountId } : {}),
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!r.ok || !r.body) {
    throw new ChatHTTPError(r.status, `codex ${r.status}: ${(await r.text().catch(() => "")).slice(0, 500)}`);
  }
  yield* parseCodexStream(r.body.getReader());
}

// ---- Anthropic message shaping (mirrors provider.ts) ----

interface AnthBlock { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: any; source?: any; }

function toAnthropic(messages: WireMessage[]): { system: AnthBlock[]; messages: { role: "user" | "assistant"; content: string | AnthBlock[] }[] } {
  const system: AnthBlock[] = [];
  const out: { role: "user" | "assistant"; content: string | AnthBlock[] }[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      const t = typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p: any) => p.text).join("\n");
      if (t) system.push({ type: "text", text: t });
    } else if (m.role === "user") {
      if (typeof m.content === "string") out.push({ role: "user", content: m.content });
      else {
        const blocks: AnthBlock[] = [];
        for (const part of m.content) {
          if (part.type === "text") blocks.push({ type: "text", text: part.text });
          else if (part.type === "image_url") {
            const mt = part.image_url.url.match(/^data:([^;]+);base64,(.*)$/);
            if (mt) blocks.push({ type: "image", source: { type: "base64", media_type: mt[1], data: mt[2] } });
          }
        }
        out.push({ role: "user", content: blocks });
      }
    } else if (m.role === "assistant") {
      const blocks: AnthBlock[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        let input: unknown = {};
        try { input = JSON.parse(tc.function.arguments || "{}"); } catch { /* keep {} */ }
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }
      out.push({ role: "assistant", content: blocks.length ? blocks : "" });
    } else if (m.role === "tool") {
      const content = typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p: any) => p.text).join("\n");
      const block: AnthBlock = { type: "tool_result", tool_use_id: m.tool_call_id, content };
      const last = out[out.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) last.content.push(block);
      else out.push({ role: "user", content: [block] });
    }
  }
  return { system, messages: out };
}

async function* parseAnthropicStream(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<ProviderEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  let finishReason = "stop";
  const toolBlocks: Record<number, { id: string; name: string; args: string }> = {};
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let chunk: any;
      try { chunk = JSON.parse(data); } catch { continue; }
      if (chunk.type === "content_block_start" && chunk.content_block?.type === "tool_use") {
        const cb = chunk.content_block;
        toolBlocks[chunk.index] = { id: cb.id, name: cb.name, args: "" };
        yield { type: "tool-call-start", index: chunk.index, id: cb.id || `call_${chunk.index}`, name: cb.name };
      } else if (chunk.type === "content_block_delta") {
        const d = chunk.delta;
        if (d?.type === "text_delta") yield { type: "text-delta", text: d.text };
        else if (d?.type === "thinking_delta") yield { type: "thinking-delta", text: d.thinking ?? d.text ?? "" };
        else if (d?.type === "input_json_delta") {
          const tb = toolBlocks[chunk.index];
          if (tb) { tb.args += d.partial_json ?? ""; yield { type: "tool-call-args-delta", index: chunk.index, delta: d.partial_json ?? "" }; }
        }
      } else if (chunk.type === "message_delta") {
        if (chunk.delta?.stop_reason) finishReason = chunk.delta.stop_reason;
        if (chunk.usage) yield { type: "usage", completionTokens: chunk.usage.output_tokens };
      } else if (chunk.type === "message_start" && chunk.message?.usage) {
        yield { type: "usage", promptTokens: chunk.message.usage.input_tokens, completionTokens: chunk.message.usage.output_tokens };
      }
    }
  }
  for (const idx of Object.keys(toolBlocks).map(Number).sort((a, b) => a - b)) {
    const a = toolBlocks[idx];
    if (a.name) yield { type: "tool-call", call: { id: a.id || `call_${idx}`, name: a.name, arguments: a.args || "{}" } };
  }
  yield { type: "done", finishReason };
}

// ---- Codex Responses API translation ----

function toResponsesInput(messages: WireMessage[]): { instructions: string; input: any[] } {
  const instr: string[] = [];
  const input: any[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      instr.push(typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p: any) => p.text).join("\n"));
    } else if (m.role === "user") {
      if (typeof m.content === "string") input.push({ role: "user", content: [{ type: "input_text", text: m.content }] });
      else {
        const parts = m.content.map((p: any) => (p.type === "text" ? { type: "input_text", text: p.text } : { type: "input_image", image_url: p.image_url.url }));
        input.push({ role: "user", content: parts });
      }
    } else if (m.role === "assistant") {
      if (m.content) input.push({ role: "assistant", content: [{ type: "output_text", text: m.content }] });
      for (const tc of m.tool_calls ?? []) {
        input.push({ type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || "{}" });
      }
    } else if (m.role === "tool") {
      const out = typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p: any) => p.text).join("\n");
      input.push({ type: "function_call_output", call_id: m.tool_call_id, output: out });
    }
  }
  return { instructions: instr.filter(Boolean).join("\n\n"), input };
}

async function* parseCodexStream(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<ProviderEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  let finishReason = "stop";
  let toolIndex = 0;
  // Map internal item_id (fc_…) → tool call index/metadata.
  const items = new Map<string, { index: number; id: string; name: string; args: string }>();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let ev: any;
      try { ev = JSON.parse(data); } catch { continue; }
      switch (ev.type) {
        case "response.output_text.delta":
          if (ev.delta) yield { type: "text-delta", text: ev.delta };
          break;
        case "response.reasoning_summary_text.delta":
          if (ev.delta) yield { type: "thinking-delta", text: ev.delta };
          break;
        case "response.output_item.added": {
          const it = ev.item;
          if (it?.type === "function_call") {
            const meta = { index: toolIndex++, id: it.call_id || it.id, name: it.name || "", args: "" };
            items.set(it.id, meta);
            yield { type: "tool-call-start", index: meta.index, id: meta.id, name: meta.name };
          }
          break;
        }
        case "response.function_call_arguments.delta": {
          const meta = items.get(ev.item_id);
          if (meta) { meta.args += ev.delta ?? ""; yield { type: "tool-call-args-delta", index: meta.index, delta: ev.delta ?? "" }; }
          break;
        }
        case "response.output_item.done": {
          const it = ev.item;
          if (it?.type === "function_call") {
            const meta = items.get(it.id);
            if (meta) { meta.name = it.name || meta.name; meta.args = it.arguments ?? meta.args; }
          }
          break;
        }
        case "response.completed":
          if (ev.response?.usage) yield { type: "usage", promptTokens: ev.response.usage.input_tokens, completionTokens: ev.response.usage.output_tokens };
          break;
        case "response.failed":
          throw new ChatHTTPError(500, `codex: ${ev.response?.error?.message || "response failed"}`);
      }
    }
  }
  for (const meta of [...items.values()].sort((a, b) => a.index - b.index)) {
    if (meta.name) yield { type: "tool-call", call: { id: meta.id, name: meta.name, arguments: meta.args || "{}" } };
  }
  yield { type: "done", finishReason };
}

// ---- Antigravity (Google Cloud Code, Gemini wire format) ----

interface GeminiPart { text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { name: string; args: any }; functionResponse?: { name: string; response: any }; inlineData?: { mimeType: string; data: string }; }

/**
 * Gemini 3+ (via Antigravity) rejects history `functionCall` parts that lack a
 * `thoughtSignature` ("Function call is missing a thought_signature"). Clients
 * don't persist the per-call signature, so we backfill this default placeholder
 * on every replayed function call — matching the Antigravity Cloud Code backend.
 */
const ANTIGRAVITY_THOUGHT_SIGNATURE =
  "EuwGCukGAXLI2nxwZIq54WWSoL/YN0P3TsDZ7zRnLi8g0S4aVr2HUGxvaHKySuY6HAVzcE0GPGjXrytLIldxthSvfxgUlJh6Qa9Z+Oj5QZBlYdg6HaJ6yuY5R7waE6rdwBsRf7Ft2j3DJ9rMi9qhWFqApewYtPhls3VHtuvND3l8Rm09+lbAXQs6KKWEWrxNLKTBkfpMgXhRERc/TQRMZu1twAablm6/Zk1tsYRvfWKLsNbeKF+CCojJdXJKvnR/8Ouuoa+Y2Ti20hcW7aZIIjZDFYPU//k6Ybmhg69J/imbFai2ckhfLaisqdDkdoIiBJScTOUvYqP6AE9d4MsydSC+UlhIMk4hoP76R8vUSCZRMkjOaDXstf/QoVZKbt94wyRZgAJ1G0BqI8L5ow86kLpA4wJEtxsRGymOE4bKUvApveBakYDNM9APkf+LbtbzWSseGjoZcSlycF9iN8Q2XNYKRrHbv3Lr5Y8JjdH/5y/6SHkNehTEZugaeGnSPSyCTWto1kQgHpxdWmhkLfJGNUGLmue7Mesj4TSms4J33mRpYVhNB/J333FCqIP0hr/E7BkkjEn7yZ4X7SQlh+xKPurapsnHRwiKmtsilmEFrnTE9iQr+pMr6M29qqFNv1tr5yumbaJw8JW9sB15tNsRv+dW6BjNanbsKz7HCgKUBc8tGy+7YuhXzAfViyRefcjK7eZW0Fbyt7AbybJTKz78W8NH7ye6LAwzOebXpeZ4D43fNIt8bKh26qgduSQv/7o+pAflkuqHZ99YWgHQ8h8OkZFi3eOiSYjsjhdZ/czWOdoPI/OnqIldzMPF5YlrKBLFX8VhRKVmqgsmWf5PHGulHhMkVlS+XG2UIseGy69ARa93D78Gsa+1n1kJr7EEB7Rh+27vUMxVYLdz1yMSvE5nalTAlg/ZeG8+XQ0cHuAI3KbQpHW2Q++RdXfm5JzD5WdJZUU+Zn8t8UUn85BH4RxZLeE0qJikgSsKoYVBc6YhiMjhPgkR95ReimY4Z0xCJdRo1gjexOFeODZMpQF6Yxnoic7IrdgsFA3iePTbFnPp3IAM1fAThWhXJUn3QInUOTd5o1qmTmn6REbL15g/JQNl+dqUoPkhleeb2V3kjqp1okmO3wMZbPknR3S1LZNmlS72/iBQUm+n2b/RCn4PjmM2";

/** Convert our wire messages into Gemini `contents` + `systemInstruction`. */
function toGemini(messages: WireMessage[]): { system?: { parts: GeminiPart[] }; contents: { role: "user" | "model"; parts: GeminiPart[] }[] } {
  const sys: GeminiPart[] = [];
  const contents: { role: "user" | "model"; parts: GeminiPart[] }[] = [];
  const pushUserPart = (p: GeminiPart) => {
    const last = contents[contents.length - 1];
    if (last && last.role === "user") last.parts.push(p);
    else contents.push({ role: "user", parts: [p] });
  };
  for (const m of messages) {
    if (m.role === "system") {
      const t = typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p: any) => p.text).join("\n");
      if (t) sys.push({ text: t });
    } else if (m.role === "user") {
      if (typeof m.content === "string") pushUserPart({ text: m.content });
      else for (const part of m.content) {
        if (part.type === "text") pushUserPart({ text: part.text });
        else if (part.type === "image_url") {
          const mt = part.image_url.url.match(/^data:([^;]+);base64,(.*)$/);
          if (mt) pushUserPart({ inlineData: { mimeType: mt[1], data: mt[2] } });
        }
      }
    } else if (m.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (m.content) parts.push({ text: m.content });
      for (const tc of m.tool_calls ?? []) {
        let args: any = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* keep {} */ }
        // Gemini 3+ requires a thoughtSignature on every function call in history.
        parts.push({ thoughtSignature: ANTIGRAVITY_THOUGHT_SIGNATURE, functionCall: { name: tc.function.name, args } });
      }
      contents.push({ role: "model", parts: parts.length ? parts : [{ text: "" }] });
    } else if (m.role === "tool") {
      const out = typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p: any) => p.text).join("\n");
      let response: any;
      try { response = JSON.parse(out); } catch { response = { result: out }; }
      pushUserPart({ functionResponse: { name: m.tool_call_id, response } });
    }
  }
  return { system: sys.length ? { parts: sys } : undefined, contents };
}

async function* streamAntigravity(id: string, opts: {
  model: string;
  messages: WireMessage[];
  tools?: ToolSchema[];
  maxTokens?: number;
  modelParams?: { thinking?: string; reasoningEffort?: string; maxContext?: string };
  signal: AbortSignal;
}): AsyncGenerator<ProviderEvent> {
  const acc = await validAccount(id);
  const { system, contents } = toGemini(opts.messages);
  const maxTokens = Math.min(opts.maxTokens && opts.maxTokens > 0 ? opts.maxTokens : 8192, 16384);

  const request: Record<string, unknown> = {
    contents,
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature: 1,
      thinkingConfig: { includeThoughts: true },
    },
  };
  if (system) request.systemInstruction = system;
  if (opts.tools?.length) {
    request.tools = [{ functionDeclarations: opts.tools.map((t) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })) }];
    request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
  }

  const body = {
    project: acc.projectId,
    model: opts.model,
    userAgent: "antigravity",
    requestType: "agent",
    requestId: `agent-${crypto.randomUUID()}`,
    request,
  };

  const r = await fetch(`${ANTIGRAVITY.apiBase}/v1internal:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${acc.accessToken}`,
      "content-type": "application/json",
      "user-agent": ANTIGRAVITY.userAgent,
      accept: "text/event-stream",
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!r.ok || !r.body) {
    throw new ChatHTTPError(r.status, `antigravity ${r.status}: ${(await r.text().catch(() => "")).slice(0, 500)}`);
  }
  yield* parseGeminiStream(r.body.getReader());
}

async function* parseGeminiStream(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<ProviderEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  let finishReason = "stop";
  let toolIndex = 0;
  const calls: { id: string; name: string; args: string }[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let chunk: any;
      try { chunk = JSON.parse(data); } catch { continue; }
      // Antigravity may wrap the Gemini payload under `response`.
      const resp = chunk.response ?? chunk;
      const cand = resp.candidates?.[0];
      if (!cand) {
        if (resp.usageMetadata) yield { type: "usage", promptTokens: resp.usageMetadata.promptTokenCount, completionTokens: resp.usageMetadata.candidatesTokenCount };
        continue;
      }
      for (const part of cand.content?.parts ?? []) {
        if (part.functionCall) {
          const id = `call_${toolIndex}`;
          const name = part.functionCall.name;
          const args = JSON.stringify(part.functionCall.args ?? {});
          yield { type: "tool-call-start", index: toolIndex, id, name };
          calls.push({ id, name, args });
          toolIndex++;
        } else if (typeof part.text === "string") {
          if (part.thought) yield { type: "thinking-delta", text: part.text };
          else yield { type: "text-delta", text: part.text };
        }
      }
      if (cand.finishReason) finishReason = String(cand.finishReason).toLowerCase();
      if (resp.usageMetadata) yield { type: "usage", promptTokens: resp.usageMetadata.promptTokenCount, completionTokens: resp.usageMetadata.candidatesTokenCount };
    }
  }
  for (const c of calls) yield { type: "tool-call", call: { id: c.id, name: c.name, arguments: c.args || "{}" } };
  yield { type: "done", finishReason: finishReason === "stop" ? "stop" : calls.length ? "tool_calls" : finishReason };
}

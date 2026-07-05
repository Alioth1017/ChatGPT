/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as React from "react";
import { Icon } from "../../shared/icons";
import { vscode } from "../../shared/vscode";
import {
  BALANCE_OPTIONS,
  FeatureConfig,
  OAUTH_LABEL,
  OAUTH_PROVIDERS,
  OAuthAccountInfo,
  OAuthLimit,
  OAuthStatus,
  POPULAR_KINDS,
  PROVIDER_PRESETS,
  ProviderConfig,
  ProviderKind,
  uid,
} from "../features";
import { Toggle } from "./Toggle";

// Custom providers are OpenAI- or Anthropic-compatible endpoints only.
const KIND_ORDER: ProviderKind[] = ["openai", "anthropic"];

const customKindLabel = (kind: ProviderKind): string =>
  kind === "anthropic" ? "Anthropic-compatible" : PROVIDER_PRESETS[kind].label;

type TestState = { status: "idle" | "testing" | "ok" | "error"; message?: string };

function ProviderModal({
  provider,
  onClose,
  onSave,
}: {
  provider: ProviderConfig;
  onClose: () => void;
  onSave: (p: ProviderConfig) => void;
}) {
  const [draft, setDraft] = React.useState<ProviderConfig>(provider);
  const [keyDraft, setKeyDraft] = React.useState("");
  const [test, setTest] = React.useState<TestState>({ status: "idle" });

  const set = (patch: Partial<ProviderConfig>) => setDraft((d) => ({ ...d, ...patch }));
  const onKind = (kind: ProviderKind) => set({ kind, baseUrl: PROVIDER_PRESETS[kind].baseUrl });

  // The test result arrives as a modelsFetched message scoped to this provider.
  React.useEffect(() => {
    const handler = (e: MessageEvent) => {
      const m = e.data;
      if (m?.type === "modelsFetched" && m.providerId === draft.id) {
        if (m.error) setTest({ status: "error", message: String(m.error).slice(0, 200) });
        else setTest({ status: "ok", message: `${(m.models || []).length} models available` });
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [draft.id]);

  const runTest = () => {
    setTest({ status: "testing" });
    vscode.postMessage({
      type: "fetchModels",
      apiBaseUrl: draft.baseUrl,
      providerId: draft.id,
      anthropic: draft.kind === "anthropic",
      // Prefer the unsaved draft key; fall back to the stored one.
      apiKey: keyDraft.trim() ? keyDraft : undefined,
    });
  };

  const save = () => {
    if (keyDraft.trim()) {
      vscode.postMessage({ type: "saveProviderKey", providerId: draft.id, apiKey: keyDraft });
    }
    onSave({ ...draft, hasKey: draft.hasKey || !!keyDraft.trim() });
    onClose();
  };

  const showKey = PROVIDER_PRESETS[draft.kind].needsKey;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Edit Provider</h2>
          <button className="icon-btn close" onClick={onClose} title="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="modal-body">
          <label className="fc-field">
            <span>Name</span>
            <input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="My Provider" />
          </label>
          <label className="fc-field">
            <span>Type</span>
            <select value={draft.kind} onChange={(e) => onKind(e.target.value as ProviderKind)}>
              {KIND_ORDER.map((k) => (
                <option key={k} value={k}>
                  {customKindLabel(k)}
                </option>
              ))}
            </select>
          </label>
          <label className="fc-field">
            <span>Base URL</span>
            <input value={draft.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://…/v1" />
          </label>
          {showKey && (
            <label className="fc-field">
              <span>API Key {draft.hasKey ? "(saved)" : ""}</span>
              <input
                type="password"
                value={keyDraft}
                placeholder={draft.hasKey ? "●●●●●●●● — enter to replace" : "Enter API key"}
                onChange={(e) => setKeyDraft(e.target.value)}
              />
            </label>
          )}
          <div className="test-row">
            <button className="btn-ghost" onClick={runTest} disabled={test.status === "testing"}>
              {test.status === "testing" ? "Testing…" : "Test connection"}
            </button>
            {test.status === "ok" && (
              <span className="test-result ok">
                <Icon name="check" size={13} /> {test.message}
              </span>
            )}
            {test.status === "error" && (
              <span className="test-result err">
                <Icon name="close" size={13} /> {test.message || "Failed"}
              </span>
            )}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}

function PopularProviderCard({
  kind,
  provider,
  onConnect,
  onToggle,
  onDisconnect,
}: {
  kind: ProviderKind;
  provider?: ProviderConfig;
  onConnect: (kind: ProviderKind, apiKey: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onDisconnect: (id: string) => void;
}) {
  const [keyDraft, setKeyDraft] = React.useState("");
  const preset = PROVIDER_PRESETS[kind];
  // The "openai" preset reads "OpenAI-compatible" for custom providers; here the
  // card connects to OpenAI itself, so show plain "OpenAI".
  const label = kind === "openai" ? "OpenAI" : preset.label;
  const connected = !!provider?.hasKey;
  const on = provider?.enabled !== false;

  return (
    <div className={"provider-row" + (connected && on ? " active" : "")}>
      <div className="pr-text">
        <div className="pr-name">{label}</div>
        <div className="pr-sub">{connected ? "Connected · key set" : "Add your API key to connect"}</div>
      </div>
      {connected ? (
        <>
          <button className="icon-btn" onClick={() => provider && onDisconnect(provider.id)} title="Disconnect">
            <Icon name="trash" size={14} />
          </button>
          <Toggle checked={on} onChange={(v) => provider && onToggle(provider.id, v)} />
        </>
      ) : (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            type="password"
            value={keyDraft}
            placeholder="Enter API key"
            onChange={(e) => setKeyDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && keyDraft.trim()) { onConnect(kind, keyDraft.trim()); setKeyDraft(""); } }}
            style={{ width: 200 }}
          />
          <button className="btn-primary" disabled={!keyDraft.trim()} onClick={() => { onConnect(kind, keyDraft.trim()); setKeyDraft(""); }}>
            Connect
          </button>
        </div>
      )}
    </div>
  );
}

/** A connected OAuth account card, expandable to show usage limits. */
export function OAuthAccountCard({ account, defaultOpen }: { account: OAuthAccountInfo; defaultOpen?: boolean }) {
  const [open, setOpen] = React.useState(!!defaultOpen);
  const [limits, setLimits] = React.useState<OAuthLimit[] | null>(null);
  const [resetCredits, setResetCredits] = React.useState<number | undefined>(undefined);
  const [error, setError] = React.useState<string | undefined>(undefined);
  const [loading, setLoading] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);
  const [resetMsg, setResetMsg] = React.useState<string | undefined>(undefined);
  React.useEffect(() => {
    const handler = (e: MessageEvent) => {
      const m = e.data;
      if (m?.type === "oauthLimits" && m.id === account.id) {
        setLimits(m.limits || []);
        setResetCredits(m.resetCredits);
        setError(m.error);
        setLoading(false);
      } else if (m?.type === "oauthResetResult" && m.id === account.id) {
        setResetting(false);
        setResetMsg(m.ok ? "Windows reset." : (m.message || "Reset failed."));
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [account.id]);
  const load = () => { setLoading(true); setError(undefined); vscode.postMessage({ type: "oauthLimits", id: account.id }); };
  // Auto-load limits when rendered open (the Usage & Quota page).
  React.useEffect(() => { if (defaultOpen) load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && limits === null) load();
  };
  const refresh = (e: React.MouseEvent) => { e.stopPropagation(); load(); };
  const doReset = () => { setResetting(true); setResetMsg(undefined); vscode.postMessage({ type: "oauthResetCredit", id: account.id }); };
  const enabled = account.disabled !== true;
  return (
    <div className="feature-card" style={enabled ? undefined : { opacity: 0.55 }}>
      <div className="fc-head" style={{ cursor: "pointer" }} onClick={toggle}>
        <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Icon name={open ? "chevD" : "chevR"} size={14} />
          <span>{OAUTH_LABEL[account.kind]}</span>
          {account.email && <span className="row-desc">· {account.email}</span>}
          {!enabled && <span className="badge-tag">Disabled</span>}
        </div>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
          {open && (
            <button className="icon-btn" onClick={refresh} title="Refresh limits" disabled={loading}>
              <Icon name="reset" size={14} />
            </button>
          )}
          <button className="icon-btn" onClick={() => vscode.postMessage({ type: "oauthDisconnect", id: account.id })} title="Sign out">
            <Icon name="trash" size={14} />
          </button>
          <Toggle checked={enabled} onChange={(v) => vscode.postMessage({ type: "oauthSetEnabled", id: account.id, enabled: v })} />
        </div>
      </div>
      {open && (
        <div className="fc-body">
          {loading && limits === null ? (
            <div className="row-desc">Loading limits…</div>
          ) : error ? (
            <div className="row-desc">{error}</div>
          ) : limits && limits.length === 0 ? (
            <div className="row-desc">No usage limits available.</div>
          ) : (
            (limits || []).map((l) => {
              const pct = Math.max(0, Math.min(100, Math.round(l.remaining)));
              return (
                <div key={l.label}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginBottom: 4 }}>
                    <span className="row-desc">{l.label}</span>
                    <span className="row-desc">
                      {pct}% left{l.resetsAt ? ` · resets ${new Date(l.resetsAt).toLocaleString()}` : ""}
                    </span>
                  </div>
                  <div className="index-bar"><div className="index-bar-fill" style={{ width: `${pct}%` }} /></div>
                </div>
              );
            })
          )}
          {account.kind === "codex" && resetCredits !== undefined && (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, paddingTop: 10, borderTop: "1px solid var(--vscode-panel-border, #333)" }}>
              <span className="row-desc">Reset credits: {resetCredits}{resetMsg ? ` · ${resetMsg}` : ""}</span>
              <button className="btn-ghost" onClick={doReset} disabled={resetting || resetCredits <= 0} title="Spend one credit to reset your rate-limit windows now">
                {resetting ? "Resetting…" : "Reset windows"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** "Add account" button with a kind-picker menu (Claude Code / OpenAI Codex). */
function OAuthAddMenu({ status }: { status: OAuthStatus }) {
  const [open, setOpen] = React.useState(false);
  const [manual, setManual] = React.useState("");
  const pending = status.pending;
  const submitManual = () => {
    if (!manual.trim() || !pending) return;
    vscode.postMessage({ type: "oauthManualCallback", kind: pending, url: manual.trim() });
    setManual("");
  };
  return (
    <div className="oauth-add" style={{ position: "relative", display: "inline-block" }}>
      {pending ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <button className="btn-ghost" onClick={() => vscode.postMessage({ type: "oauthCancel", kind: pending })}>
            Waiting for browser… Cancel
          </button>
          <input
            style={{ minWidth: 260 }}
            placeholder="Or paste the callback URL / code here"
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitManual(); }}
          />
          <button className="btn-ghost" disabled={!manual.trim()} onClick={submitManual}>Submit</button>
        </div>
      ) : (
        <button className="btn-ghost" onClick={() => setOpen((v) => !v)}>
          <Icon name="plus" size={14} /> Add account
        </button>
      )}
      {open && !pending && (
        <div className="menu-pop" style={{ position: "absolute", zIndex: 10, marginTop: 4, background: "var(--vscode-menu-background, #252526)", border: "1px solid var(--vscode-menu-border, #454545)", borderRadius: 6, minWidth: 180, boxShadow: "0 2px 8px rgba(0,0,0,0.4)" }}>
          {OAUTH_PROVIDERS.map((p) => (
            <button
              key={p.kind}
              className="menu-item"
              style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", background: "none", border: "none", color: "inherit", cursor: "pointer" }}
              onClick={() => { setOpen(false); vscode.postMessage({ type: "oauthLogin", kind: p.kind }); }}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ProvidersPanel({
  features,
  setFeatures,
  oauthStatus,
}: {
  features: FeatureConfig;
  setFeatures: (f: Partial<FeatureConfig>) => void;
  oauthStatus: OAuthStatus;
}) {
  const [editId, setEditId] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<"popular" | "accounts" | "custom">("popular");
  React.useEffect(() => { vscode.postMessage({ type: "oauthGet" }); }, []);

  const remove = (id: string) => {
    vscode.postMessage({ type: "saveProviderKey", providerId: id, apiKey: "" });
    setFeatures({ providers: features.providers.filter((p) => p.id !== id) });
  };

  const toggleEnabled = (id: string, enabled: boolean) =>
    setFeatures({ providers: features.providers.map((p) => (p.id === id ? { ...p, enabled } : p)) });

  const onSave = (p: ProviderConfig) =>
    setFeatures({ providers: features.providers.map((x) => (x.id === p.id ? p : x)) });

  // Connect a popular provider: reuse an existing one of that kind or create it.
  const connectPopular = (kind: ProviderKind, apiKey: string) => {
    const existing = features.providers.find((p) => p.id === `popular:${kind}`);
    const id = existing?.id ?? `popular:${kind}`;
    vscode.postMessage({ type: "saveProviderKey", providerId: id, apiKey });
    const card: ProviderConfig = {
      id,
      name: kind === "openai" ? "OpenAI" : PROVIDER_PRESETS[kind].label,
      kind,
      baseUrl: PROVIDER_PRESETS[kind].baseUrl,
      hasKey: true,
      enabled: true,
    };
    const next = existing
      ? features.providers.map((p) => (p.id === id ? { ...p, ...card } : p))
      : [...features.providers, card];
    setFeatures({ providers: next });
  };

  const addCustom = () => {
    const id = uid("prov");
    const next = [...features.providers, { id, name: "Custom Provider", kind: "openai" as ProviderKind, baseUrl: PROVIDER_PRESETS.openai.baseUrl }];
    setFeatures({ providers: next });
    setEditId(id);
  };

  const popularByKind = (kind: ProviderKind) => features.providers.find((p) => p.id === `popular:${kind}`);
  const customProviders = features.providers.filter((p) => !p.id.startsWith("popular:"));
  const editing = features.providers.find((p) => p.id === editId) || null;

  return (
    <>
      <h1 className="page-title">Providers</h1>

      <div className="sub-tabs">
        <button className={"sub-tab" + (tab === "popular" ? " active" : "")} onClick={() => setTab("popular")}>Popular Providers</button>
        <button className={"sub-tab" + (tab === "accounts" ? " active" : "")} onClick={() => setTab("accounts")}>OAuth Accounts</button>
        <button className={"sub-tab" + (tab === "custom" ? " active" : "")} onClick={() => setTab("custom")}>Custom Providers</button>
      </div>

      {tab === "popular" && (
        <>
          <p className="panel-hint">Connect a hosted provider by adding its API key. Models from connected providers appear in the chat picker.</p>
          {POPULAR_KINDS.map((kind) => (
            <PopularProviderCard
              key={kind}
              kind={kind}
              provider={popularByKind(kind)}
              onConnect={connectPopular}
              onToggle={toggleEnabled}
              onDisconnect={remove}
            />
          ))}
        </>
      )}

      {tab === "accounts" && (
        <>
          <div className="oauth-warning">
            ⚠️ This isn't an official integration. Your provider's terms may not allow it, so the account could be rate-limited, restricted, or banned. Use at your own risk.
          </div>
          <p className="panel-hint">Sign in with your existing subscription. Tokens are stored securely and refreshed automatically. You can add multiple accounts.</p>
          {(oauthStatus.errors["claude-code"] || oauthStatus.errors.codex) && (
            <div className="fc-error">{oauthStatus.errors["claude-code"] || oauthStatus.errors.codex}</div>
          )}
          {oauthStatus.accounts.length > 1 && (
            <div className="settings-row" style={{ marginBottom: 10 }}>
              <div className="row-text">
                <div className="row-title">Load balancing</div>
                <div className="row-desc">{BALANCE_OPTIONS.find((o) => o.value === (oauthStatus.balanceStrategy ?? "first"))?.desc}</div>
              </div>
              <select
                value={oauthStatus.balanceStrategy ?? "first"}
                onChange={(e) => vscode.postMessage({ type: "oauthSetBalance", strategy: e.target.value })}
              >
                {BALANCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          )}
          {oauthStatus.accounts.length === 0 ? (
            <div className="empty-card">No accounts connected. Click “Add account”.</div>
          ) : (
            oauthStatus.accounts.map((a) => <OAuthAccountCard key={a.id} account={a} />)
          )}
          <div className="panel-actions">
            <OAuthAddMenu status={oauthStatus} />
          </div>
        </>
      )}

      {tab === "custom" && (
        <>
          <p className="panel-hint">Add any OpenAI-compatible or Anthropic-compatible endpoint (self-hosted, proxies, alternative gateways).</p>
          {customProviders.length === 0 ? (
            <div className="empty-card">No custom providers yet.</div>
          ) : (
            customProviders.map((p) => {
              const on = p.enabled !== false;
              return (
                <div className={"provider-row" + (on ? " active" : "")} key={p.id}>
                  <div className="pr-text">
                    <div className="pr-name">{p.name || "(unnamed)"}</div>
                    <div className="pr-sub">
                      {customKindLabel(p.kind)} · {p.baseUrl}
                      {p.hasKey ? " · key set" : PROVIDER_PRESETS[p.kind].needsKey ? " · no key" : ""}
                    </div>
                  </div>
                  <button className="btn-ghost sm" onClick={() => setEditId(p.id)}>
                    <Icon name="settings" size={13} /> Edit
                  </button>
                  <button className="icon-btn" onClick={() => remove(p.id)} title="Remove">
                    <Icon name="trash" size={14} />
                  </button>
                  <Toggle checked={on} onChange={(v) => toggleEnabled(p.id, v)} />
                </div>
              );
            })
          )}
          <div className="panel-actions">
            <button className="btn-ghost" onClick={addCustom}>
              <Icon name="plus" size={14} /> Add Custom Provider
            </button>
          </div>
        </>
      )}

      {editing && (
        <ProviderModal provider={editing} onClose={() => setEditId(null)} onSave={onSave} />
      )}
    </>
  );
}

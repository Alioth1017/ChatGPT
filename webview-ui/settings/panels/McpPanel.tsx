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
import { FeatureConfig, McpServerConfig, McpStatus, uid } from "../features";
import { Toggle } from "./Toggle";

export function McpPanel({
  features,
  setFeatures,
  status,
  onSync,
}: {
  features: FeatureConfig;
  setFeatures: (f: Partial<FeatureConfig>) => void;
  status: McpStatus[];
  onSync: () => void;
}) {
  // null = closed; { index: -1 } = adding a new server; otherwise editing that index.
  const [editing, setEditing] = React.useState<{ index: number; draft: McpServerConfig } | null>(null);
  const [tab, setTab] = React.useState<"installed" | "marketplace">("installed");

  const remove = (i: number) => {
    setFeatures({ mcpServers: features.mcpServers.filter((_, idx) => idx !== i) });
    setTimeout(onSync, 0);
  };
  const toggle = (i: number, enabled: boolean) => {
    setFeatures({ mcpServers: features.mcpServers.map((s, idx) => (idx === i ? { ...s, enabled } : s)) });
    setTimeout(onSync, 0);
  };

  const openAdd = () => setEditing({ index: -1, draft: { name: "", transport: "stdio", command: "", args: [], enabled: true } });
  const openEdit = (i: number) => setEditing({ index: i, draft: { ...features.mcpServers[i] } });

  const save = (cfg: McpServerConfig) => {
    const next = editing && editing.index >= 0
      ? features.mcpServers.map((s, idx) => (idx === editing.index ? cfg : s))
      : [...features.mcpServers, cfg];
    setFeatures({ mcpServers: next });
    setEditing(null);
    setTimeout(onSync, 0);
  };

  const statusFor = (name: string) => status.find((s) => s.name === name);

  // One-click install from the marketplace: append the derived config and reconnect.
  const install = (cfg: McpServerConfig) => {
    const name = features.mcpServers.some((s) => s.name === cfg.name) ? `${cfg.name}-${uid("").slice(0, 4)}` : cfg.name;
    setFeatures({ mcpServers: [...features.mcpServers, { ...cfg, name }] });
    setTimeout(onSync, 0);
  };

  return (
    <>
      <h1 className="page-title">Tools &amp; MCPs</h1>

      <div className="sub-tabs">
        <button className={"sub-tab" + (tab === "installed" ? " active" : "")} onClick={() => setTab("installed")}>Installed</button>
        <button className={"sub-tab" + (tab === "marketplace" ? " active" : "")} onClick={() => setTab("marketplace")}>Marketplace</button>
      </div>

      {tab === "installed" && (<>
      <div className="section-label">MCP Servers</div>
      <p className="panel-hint">Connected Model Context Protocol servers and the tools they expose. Browse the <button className="link-btn" onClick={() => setTab("marketplace")}>Marketplace</button> to install with one click.</p>
      {features.mcpServers.length === 0 && (
        <div className="empty-card">No MCP servers yet. Add one or install from the Marketplace.</div>
      )}
      {features.mcpServers.map((srv, i) => {
        const st = statusFor(srv.name);
        const tools = st?.tools ?? [];
        return (
          <div className="feature-card" key={i}>
            <div className="fc-head">
              <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Icon name="link" size={14} />
                <span>{srv.name || "(unnamed)"}</span>
                <span className={"mcp-status " + (st?.connected ? "ok" : st?.error ? "err" : "idle")}>
                  {st?.connected ? `${st.toolCount} tools` : st?.error ? "error" : "idle"}
                </span>
              </div>
              <Toggle checked={srv.enabled} onChange={(v) => toggle(i, v)} />
              <button className="btn-ghost sm" onClick={() => openEdit(i)}>
                <Icon name="settings" size={13} /> Edit
              </button>
              <button className="icon-btn" onClick={() => remove(i)} title="Remove">
                <Icon name="trash" size={14} />
              </button>
            </div>
            <div className="fc-body">
              {st?.error ? (
                <div className="fc-error">{st.error}</div>
              ) : tools.length === 0 ? (
                <div className="row-desc">{st?.connected ? "No tools exposed." : "Not connected — enable and Reconnect."}</div>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {tools.map((t) => (
                    <span className="badge-tag glob" key={t}>{t}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
      <div className="panel-actions">
        <button className="btn-ghost" onClick={openAdd}>
          <Icon name="plus" size={14} /> Add MCP Server
        </button>
        <button className="btn-ghost" onClick={onSync}>
          Reconnect
        </button>
      </div>
      </>)}

      {tab === "marketplace" && (
        <McpMarketplace installedNames={new Set(features.mcpServers.map((s) => s.name))} onInstall={install} />
      )}

      {editing && (
        <McpModal
          server={editing.draft}
          isNew={editing.index < 0}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
    </>
  );
}

function McpModal({ server, isNew, onClose, onSave }: { server: McpServerConfig; isNew: boolean; onClose: () => void; onSave: (s: McpServerConfig) => void }) {
  const [draft, setDraft] = React.useState<McpServerConfig>(server);
  const set = (patch: Partial<McpServerConfig>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{isNew ? "Add MCP Server" : "Edit MCP Server"}</h2>
          <button className="icon-btn close" onClick={onClose} title="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="modal-body">
          <label className="fc-field">
            <span>Name</span>
            <input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="my-server" />
          </label>
          <label className="fc-field">
            <span>Command</span>
            <input value={draft.command ?? ""} onChange={(e) => set({ command: e.target.value })} placeholder="npx" />
          </label>
          <label className="fc-field">
            <span>Args (space-separated)</span>
            <input
              value={(draft.args ?? []).join(" ")}
              onChange={(e) => set({ args: e.target.value.split(/\s+/).filter(Boolean) })}
              placeholder="-y @modelcontextprotocol/server-filesystem ."
            />
          </label>
        </div>
        <div className="modal-foot">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!draft.name.trim() || !draft.command?.trim()} onClick={() => onSave({ ...draft, name: draft.name.trim() })}>Save</button>
        </div>
      </div>
    </div>
  );
}

// Marketplace: registry.modelcontextprotocol.io
interface RegistryPackage {
  registryType?: string;
  identifier?: string;
  version?: string;
  runtimeHint?: string;
  transport?: { type?: string };
  runtimeArguments?: { type?: string; name?: string; value?: string }[];
  packageArguments?: { type?: string; name?: string; value?: string }[];
  environmentVariables?: { name?: string; description?: string; isRequired?: boolean; isSecret?: boolean }[];
}
interface RegistryServer {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  packages?: RegistryPackage[];
}

/** Default runtime command for a registry package type. */
function runtimeFor(pkg: RegistryPackage): string {
  if (pkg.runtimeHint) return pkg.runtimeHint;
  switch (pkg.registryType) {
    case "npm": return "npx";
    case "pypi": return "uvx";
    case "oci": return "docker";
    case "nuget": return "dnx";
    default: return "npx";
  }
}

/** Build an args list from registry argument descriptors (positional/named values only). */
function argValues(args?: { type?: string; name?: string; value?: string }[]): string[] {
  if (!args) return [];
  const out: string[] = [];
  for (const a of args) {
    if (a.name) out.push(a.name);
    if (a.value) out.push(a.value);
  }
  return out;
}

/**
 * Derive a runnable stdio McpServerConfig from a registry server, or null if it
 * has no installable stdio package (e.g. remote-only servers).
 */
function configFromRegistry(srv: RegistryServer): McpServerConfig | null {
  const pkg = (srv.packages || []).find((p) => (p.transport?.type ?? "stdio") === "stdio" && p.identifier);
  if (!pkg) return null;
  const runtime = runtimeFor(pkg);
  const args: string[] = [...argValues(pkg.runtimeArguments)];
  // npx/dnx default to a non-interactive install flag, then the package id.
  if (runtime === "npx") args.push("-y");
  if (pkg.registryType === "oci") args.push("run", "-i", "--rm");
  args.push(pkg.identifier!);
  args.push(...argValues(pkg.packageArguments));
  const env: Record<string, string> = {};
  for (const e of pkg.environmentVariables ?? []) if (e.name) env[e.name] = "";
  const shortName = srv.name.split("/").pop() || srv.name;
  return {
    name: shortName,
    transport: "stdio",
    command: runtime,
    args,
    env: Object.keys(env).length ? env : undefined,
    enabled: true,
  };
}

function McpMarketplace({ installedNames, onInstall }: { installedNames: Set<string>; onInstall: (cfg: McpServerConfig) => void }) {
  const [query, setQuery] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [results, setResults] = React.useState<RegistryServer[]>([]);

  // The registry fetch runs in the extension host (webview CSP blocks direct fetch).
  const search = React.useCallback((q: string) => {
    setLoading(true);
    setError("");
    vscode.postMessage({ type: "mcpRegistrySearch", query: q.trim() });
  }, []);

  React.useEffect(() => {
    const handler = (e: MessageEvent) => {
      const m = e.data;
      if (m?.type === "mcpRegistryResults") {
        setLoading(false);
        setResults(m.servers || []);
        setError(m.error || "");
      }
    };
    window.addEventListener("message", handler);
    search("");
    return () => window.removeEventListener("message", handler);
  }, [search]);

  return (
    <>
      <div className="section-label">Marketplace</div>
      <p className="panel-hint">Search the official <code>registry.modelcontextprotocol.io</code> and install a server with one click. Servers with required environment variables are added with empty values — fill them in on the Installed tab.</p>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          type="search"
          value={query}
          placeholder="e.g. filesystem, github, playwright"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") search(query); }}
          style={{ flex: 1 }}
        />
        <button className="btn-primary" onClick={() => search(query)} disabled={loading}>
          {loading ? "Searching…" : "Search"}
        </button>
      </div>
      {error && <div className="fc-error">{error}</div>}
      {!loading && results.length === 0 && !error && <div className="empty-card">No servers found.</div>}
      {results.map((srv) => {
        const cfg = configFromRegistry(srv);
        const shortName = srv.name.split("/").pop() || srv.name;
        const installed = installedNames.has(shortName);
        return (
          <div className="feature-card" key={srv.name}>
            <div className="fc-head">
              <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Icon name="link" size={14} />
                <span>{srv.title || shortName}</span>
                {srv.version && <span className="badge-tag glob">v{srv.version}</span>}
              </div>
              {installed ? (
                <span className="badge-tag glob">added</span>
              ) : cfg ? (
                <button className="btn-primary sm" onClick={() => onInstall(cfg)}>
                  <Icon name="plus" size={13} /> Install
                </button>
              ) : (
                <span className="badge-tag" title="No stdio package — remote/unsupported">remote</span>
              )}
            </div>
            <div className="fc-body">
              {srv.description && <div className="row-desc">{srv.description}</div>}
              {cfg && <div className="row-desc" style={{ marginTop: 6, opacity: 0.7, fontFamily: "var(--vscode-editor-font-family, monospace)" }}>{cfg.command} {(cfg.args || []).join(" ")}</div>}
              <div className="row-desc" style={{ marginTop: 4, opacity: 0.6 }}>{srv.name}</div>
            </div>
          </div>
        );
      })}
    </>
  );
}

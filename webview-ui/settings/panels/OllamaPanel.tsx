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
import { OllamaLibraryModel, OllamaModel, OllamaStatus } from "../features";
import { fmtSize } from "./localShared";

export function OllamaPanel({
  status,
  models,
}: {
  status: OllamaStatus;
  models: OllamaModel[];
}) {
  const [tab, setTab] = React.useState<"models" | "search">("models");
  const [query, setQuery] = React.useState("");
  const [searching, setSearching] = React.useState(false);
  const [searchErr, setSearchErr] = React.useState("");
  const [results, setResults] = React.useState<OllamaLibraryModel[]>([]);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [tags, setTags] = React.useState<Record<string, string[]>>({});

  React.useEffect(() => {
    vscode.postMessage({ type: "ollamaGet" });
    const handler = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "ollamaSearchResults") {
        setSearching(false);
        setResults(m.results || []);
        setSearchErr(m.error || "");
      } else if (m.type === "ollamaTags") {
        setTags((prev) => ({ ...prev, [m.name]: m.tags || [] }));
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const pull = (name: string) => {
    const n = name.trim();
    if (!n) return;
    vscode.postMessage({ type: "ollamaPull", name: n });
  };

  const search = () => {
    if (!query.trim()) return;
    setSearching(true);
    setSearchErr("");
    vscode.postMessage({ type: "ollamaSearch", query: query.trim() });
  };

  const toggleModel = (name: string) => {
    if (expanded === name) {
      setExpanded(null);
      return;
    }
    setExpanded(name);
    if (!tags[name]) vscode.postMessage({ type: "ollamaTags", name });
  };

  return (
    <>
      <h1 className="page-title">Ollama</h1>

      <div className="section-label">Runtime</div>
      <div className="row">
        <div className="row-text">
          <div className="row-title">Ollama {status.installed ? "running" : "not found"}</div>
          <div className="row-desc">
            Requires the <code>ollama</code> CLI + daemon. Install from <code>ollama.com/download</code>, then start it. Models are served at <code>http://localhost:11434/v1</code>.
          </div>
        </div>
        <div className="row-control" style={{ display: "flex", gap: 8 }}>
          {!status.installed && (
            <button className="btn-primary" onClick={() => vscode.postMessage({ type: "ollamaInstall" })}>
              Install
            </button>
          )}
          <button className="btn-ghost" onClick={() => vscode.postMessage({ type: "ollamaGet" })}>
            <Icon name="reset" size={13} /> Re-check
          </button>
        </div>
      </div>

      <div className="sub-tabs" style={{ marginTop: 20 }}>
        <button className={"sub-tab" + (tab === "models" ? " active" : "")} onClick={() => setTab("models")}>Models</button>
        <button className={"sub-tab" + (tab === "search" ? " active" : "")} onClick={() => setTab("search")}>Search &amp; Download</button>
      </div>

      {tab === "models" && (<>
      <div className="panel-actions" style={{ marginBottom: 8 }}>
        <button className="btn-ghost" onClick={() => setTab("search")}>
          <Icon name="database" size={14} /> Search &amp; download models
        </button>
      </div>

      {Object.entries(status.pulling).map(([name, pct]) => (
        <div className="feature-card" key={`pull-${name}`}>
          <div className="fc-head">
            <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="llama-spinner" />
              <span>{name}</span>
              <span className="badge-tag loading">pulling {pct}%</span>
            </div>
            <button className="btn-ghost sm" onClick={() => vscode.postMessage({ type: "ollamaCancelPull", name })}>Cancel</button>
          </div>
          <div className="fc-body">
            <div className="index-bar"><div className="index-bar-fill" style={{ width: `${pct}%` }} /></div>
          </div>
        </div>
      ))}

      <div className="section-label" style={{ marginTop: 16 }}>Your Models</div>
      {Object.entries(status.errors).map(([name, err]) => (
        <div className="fc-error" key={`err-${name}`} style={{ marginBottom: 8 }}>{name}: {err}</div>
      ))}
      {models.length === 0 ? (
        <div className="empty-card">No Ollama models yet. Pull one above.</div>
      ) : (
        models.map((m) => (
          <div className="feature-card" key={m.name}>
            <div className="fc-head">
              <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Icon name="model" size={14} />
                <span>{m.name}</span>
              </div>
              <button className="icon-btn" title="Remove" onClick={() => vscode.postMessage({ type: "ollamaRemove", name: m.name })}>
                <Icon name="trash" size={14} />
              </button>
            </div>
            <div className="fc-body">
              <div className="row-desc">
                {[m.parameterSize, m.quantization, m.family, m.sizeBytes ? fmtSize(m.sizeBytes) : ""].filter(Boolean).join(" · ")}
              </div>
            </div>
          </div>
        ))
      )}
      </>)}

      {tab === "search" && (<>
      <div className="section-label" style={{ marginTop: 0 }}>Search Library</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          type="search"
          value={query}
          placeholder="e.g. qwen, llama, deepseek-r1"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") search(); }}
          style={{ flex: 1 }}
        />
        <button className="btn-primary" onClick={search} disabled={searching}>
          {searching ? "Searching…" : "Search"}
        </button>
      </div>
      {searchErr && <div className="fc-error">{searchErr}</div>}
      {results.map((r) => {
        const open = expanded === r.name;
        const variants = tags[r.name];
        const have = (name: string) => models.some((m) => m.name === name);
        return (
          <div className="feature-card" key={r.name}>
            <div className="fc-head" style={{ cursor: "pointer" }} onClick={() => toggleModel(r.name)}>
              <div className="fc-title-input" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Icon name={open ? "chevD" : "chevR"} size={14} />
                <span>{r.name}</span>
              </div>
              <span className="row-desc">{r.pulls ? `${r.pulls} pulls` : ""}</span>
            </div>
            {open && (
              <div className="fc-body">
                {r.description && <div className="row-desc" style={{ marginBottom: 8 }}>{r.description}</div>}
                {!variants ? (
                  <div className="row-desc">Loading tags…</div>
                ) : variants.length === 0 ? (
                  <div className="model-row">
                    <div className="model-name"><Icon name="model" /><span>{r.name}:latest</span></div>
                    {have(`${r.name}:latest`) ? <span className="badge-tag glob">added</span> : status.pulling[`${r.name}:latest`] != null ? (
                      <span className="row-desc">{status.pulling[`${r.name}:latest`]}%</span>
                    ) : (
                      <button className="btn-ghost sm" onClick={() => pull(`${r.name}:latest`)}><Icon name="database" size={13} /> Pull</button>
                    )}
                  </div>
                ) : (
                  variants.map((tag) => (
                    <div className="model-row" key={tag}>
                      <div className="model-name"><Icon name="model" /><span>{tag}</span></div>
                      {have(tag) ? (
                        <span className="badge-tag glob">added</span>
                      ) : status.pulling[tag] != null ? (
                        <span className="row-desc">{status.pulling[tag]}%</span>
                      ) : (
                        <button className="btn-ghost sm" onClick={() => pull(tag)}><Icon name="database" size={13} /> Pull</button>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
      </>)}
    </>
  );
}

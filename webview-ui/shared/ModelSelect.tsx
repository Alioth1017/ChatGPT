/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as React from "react";

/** Minimal structural shape shared by sidebar ModelDef and settings ModelDef. */
export interface ModelSelectItem {
  id: string;
  name: string;
  kind?: string | string[];
  providerName?: string;
}

/** Custom entries pinned above the model list (e.g. "First enabled model", "(inherit chat model)"). */
export interface ModelSelectCustom {
  value: string;
  label: string;
  desc?: string;
}

const groupOf = (m: ModelSelectItem): string => {
  const k = Array.isArray(m.kind) ? m.kind[0] : m.kind;
  if (k === "llamacpp") return "Local · llama.cpp";
  if (k === "ollama") return "Local · Ollama";
  return m.providerName || "Other";
};

/**
 * Unified model selector: a trigger button that opens a modal dialog with
 * search, provider filter chips, and the enabled models grouped by provider.
 * `customItems` render pinned at the top (judge "first enabled", subagent
 * "inherit chat model", etc.).
 */
export function ModelSelect({
  models,
  value,
  onChange,
  customItems,
  style,
}: {
  models: ModelSelectItem[];
  value: string;
  onChange: (id: string) => void;
  customItems?: ModelSelectCustom[];
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [provider, setProvider] = React.useState<string | null>(null); // null = all

  const groups = React.useMemo(() => {
    const map = new Map<string, ModelSelectItem[]>();
    for (const m of models) {
      const g = groupOf(m);
      (map.get(g) ?? map.set(g, []).get(g)!).push(m);
    }
    return [...map.entries()].sort((a, b) => Number(a[0].startsWith("Local ")) - Number(b[0].startsWith("Local ")));
  }, [models]);

  const q = query.trim().toLowerCase();
  const visibleGroups = groups
    .filter(([g]) => provider === null || g === provider)
    .map(([g, list]) => [g, q ? list.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) : list] as const)
    .filter(([, list]) => list.length > 0);
  const visibleCustom = (customItems || []).filter(
    (c) => (provider === null) && (!q || c.label.toLowerCase().includes(q))
  );

  const current =
    customItems?.find((c) => c.value === value)?.label ??
    models.find((m) => m.id === value)?.name ??
    (value || customItems?.[0]?.label || "Select model");

  const close = () => {
    setOpen(false);
    setQuery("");
    setProvider(null);
  };
  const pick = (v: string) => {
    onChange(v);
    close();
  };

  // Esc closes the dialog.
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <>
      <button type="button" className="msel-trigger" style={style} onClick={() => setOpen(true)} title={value || current}>
        <span className="msel-trigger-label">{current}</span>
        <span className="msel-trigger-chev">▾</span>
      </button>
      {open && (
        <div className="msel-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
          <div className="msel-dialog" role="dialog" aria-modal="true">
            <div className="msel-head">
              <input
                autoFocus
                className="msel-search"
                placeholder="Search models…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button className="msel-close" onClick={close} aria-label="Close">✕</button>
            </div>
            <div className="msel-filters">
              <button className={"msel-chip" + (provider === null ? " active" : "")} onClick={() => setProvider(null)}>
                All
              </button>
              {groups.map(([g]) => (
                <button key={g} className={"msel-chip" + (provider === g ? " active" : "")} onClick={() => setProvider(provider === g ? null : g)}>
                  {g}
                </button>
              ))}
            </div>
            <div className="msel-body">
              {visibleCustom.map((c) => (
                <div
                  key={c.value || "__custom__"}
                  className={"msel-item custom" + (value === c.value ? " active" : "")}
                  onClick={() => pick(c.value)}
                >
                  <span className="msel-item-name">{c.label}</span>
                  {c.desc && <span className="msel-item-sub">{c.desc}</span>}
                  {value === c.value && <span className="msel-item-check">✓</span>}
                </div>
              ))}
              {visibleCustom.length > 0 && visibleGroups.length > 0 && <div className="msel-divider" />}
              {visibleGroups.length === 0 && visibleCustom.length === 0 && <div className="msel-empty">No matches</div>}
              {visibleGroups.map(([g, list]) => (
                <React.Fragment key={g}>
                  <div className="msel-group">{g}</div>
                  {list.map((m) => (
                    <div key={m.id} className={"msel-item" + (value === m.id ? " active" : "")} onClick={() => pick(m.id)}>
                      <span className="msel-item-name">{m.name}</span>
                      {m.id !== m.name && <span className="msel-item-sub">{m.id}</span>}
                      {value === m.id && <span className="msel-item-check">✓</span>}
                    </div>
                  ))}
                </React.Fragment>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

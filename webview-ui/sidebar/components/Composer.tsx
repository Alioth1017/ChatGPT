/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as React from "react";
import { createPortal } from "react-dom";
import { ArrowUp, AtSign, ChevronRight, Square } from "lucide-react";
import { Icon, IconName } from "../../shared/icons";
import { vscode } from "../../shared/vscode";
import type { Attachment, FileIconInfo, MentionCategory, MentionItem, Mode, ModelDef, ModelOption, OutMessage } from "../types";

/** Cursor-style top-level @ menu categories (same items/order as Cursor). */
const MENTION_CATEGORIES: { id: MentionCategory; label: string; icon: IconName; leaf?: boolean }[] = [
  { id: "files", label: "Files & Folders", icon: "file" },
  { id: "docs", label: "Docs", icon: "book" },
  { id: "terminals", label: "Terminals", icon: "terminal" },
  { id: "chats", label: "Past Chats", icon: "chat" },
];

const KIND_ICON: Record<string, IconName> = {
  file: "file",
  folder: "folder",
  code: "code",
  doc: "book",
  git: "gitCommit",
  composer: "chat",
  terminal: "terminal",
  rule: "ruler",
  branch_diff: "gitBranch",
  link: "link",
};

function post(msg: OutMessage) {
  vscode.postMessage(msg);
}

// ---- Mention pill icons (raw SVG: pills are plain DOM nodes, not React) ----
const SVG_ATTRS = `xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
export const KIND_SVG: Record<string, string> = {
  file: `<svg ${SVG_ATTRS}><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>`,
  folder: `<svg ${SVG_ATTRS}><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`,
  code: `<svg ${SVG_ATTRS}><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>`,
  doc: `<svg ${SVG_ATTRS}><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>`,
  git: `<svg ${SVG_ATTRS}><circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/></svg>`,
  composer: `<svg ${SVG_ATTRS}><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>`,
  terminal: `<svg ${SVG_ATTRS}><polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/></svg>`,
  rule: `<svg ${SVG_ATTRS}><path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/></svg>`,
  branch_diff: `<svg ${SVG_ATTRS}><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`,
  link: `<svg ${SVG_ATTRS}><circle cx="12" cy="12" r="10"/><line x1="2" x2="22" y1="12" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
};
const X_SVG = `<svg ${SVG_ATTRS}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

// Cache of IDE file-icon lookups shared by all pills (host resolves them from
// the active icon theme; same protocol as Tool.tsx).
const pillIconCache = new Map<string, FileIconInfo | null>();
const pillIconWaiters = new Map<string, ((i: FileIconInfo | null) => void)[]>();
const pillLoadedFonts = new Set<string>();
window.addEventListener("message", (e: MessageEvent) => {
  const m = e.data;
  if (m?.type !== "fileIcon") return;
  const icon: FileIconInfo | null = m.icon || null;
  pillIconCache.set(m.filename, icon);
  if (icon?.kind === "font" && !pillLoadedFonts.has(icon.fontFamily)) {
    pillLoadedFonts.add(icon.fontFamily);
    const style = document.createElement("style");
    style.textContent = `@font-face { font-family: "${icon.fontFamily}"; src: url("${icon.src}") format("${icon.format}"); }`;
    document.head.appendChild(style);
  }
  (pillIconWaiters.get(m.filename) || []).forEach((fn) => fn(icon));
  pillIconWaiters.delete(m.filename);
});

function decodePillFontChar(ch: string): string {
  const m = ch.match(/^\\+([0-9a-fA-F]{4,6})$/);
  return m ? String.fromCodePoint(parseInt(m[1], 16)) : ch;
}

/** Fill `el` with the IDE's exact file icon once resolved (async). */
export function applyFileIconTo(el: HTMLElement, path: string) {
  const filename = (path.split(/[\\/]/).pop() || path).replace(/:\d+(-\d+)?$/, "").toLowerCase();
  const render = (icon: FileIconInfo | null) => {
    if (!icon) return; // keep the generic SVG fallback
    if (icon.kind === "img") {
      el.innerHTML = "";
      const img = document.createElement("img");
      img.className = "file-icon-img";
      img.src = icon.src;
      img.alt = "";
      el.appendChild(img);
    } else {
      el.innerHTML = "";
      const span = document.createElement("span");
      span.className = "file-icon-font";
      span.style.fontFamily = icon.fontFamily;
      if (icon.color) span.style.color = icon.color;
      if (icon.size) span.style.fontSize = icon.size;
      span.textContent = decodePillFontChar(icon.char);
      el.appendChild(span);
    }
  };
  if (pillIconCache.has(filename)) {
    render(pillIconCache.get(filename) ?? null);
    return;
  }
  pillIconWaiters.set(filename, [...(pillIconWaiters.get(filename) || []), render]);
  post({ type: "getFileIcon", filename });
}

let mentionReqId = 0;

function uriToPath(uri: string): string {
  let p = uri.trim();
  try {
    // file:///c:/foo -> c:/foo ; file:///home/x -> /home/x
    p = decodeURIComponent(p.replace(/^file:\/\/\/?/i, (m) => (/^[a-z]:/i.test(p.replace(m, "")) ? "" : "/")));
  } catch {}
  return p.replace(/^\/([a-z]:)/i, "$1");
}

/** Parse the various clipboard/drag payloads VS Code emits into file paths. */
function parseDroppedPaths(raws: string[]): string[] {
  // Payloads all describe the SAME dropped file(s) in different formats, so
  // return the first one that parses — never merge them (dupes/[object Object]).
  const uriString = (item: unknown): string => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      for (const k of ["resource", "uri", "external"]) {
        const v = o[k];
        if (typeof v === "string") return v;
        if (v && typeof v === "object") {
          const vo = v as Record<string, unknown>;
          if (typeof vo.fsPath === "string") return vo.fsPath;
          if (typeof vo.path === "string") return vo.path;
          if (typeof vo.external === "string") return vo.external;
        }
      }
      if (typeof o.fsPath === "string") return o.fsPath;
      if (typeof o.path === "string") return o.path;
    }
    return "";
  };
  for (const raw of raws) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (p: string) => {
      const v = p.trim();
      const key = v.replace(/\\/g, "/").toLowerCase();
      if (v && !seen.has(key)) {
        seen.add(key);
        out.push(v);
      }
    };
    // JSON array payloads (codeeditors / resourceurls).
    if (trimmed.startsWith("[")) {
      try {
        const arr = JSON.parse(trimmed);
        if (Array.isArray(arr)) {
          for (const item of arr) {
            const u = uriString(item);
            if (u) push(uriToPath(u));
          }
        }
      } catch {}
    } else {
      for (const line of trimmed.split(/\r?\n/)) {
        const l = line.trim();
        if (!l || l.startsWith("#")) continue;
        push(/^file:/i.test(l) ? uriToPath(l) : l);
      }
    }
    if (out.length) return out;
  }
  return [];
}

let attachCounter = 0;
function newAttachId() {
  return `a_${Date.now()}_${attachCounter++}`;
}

const TEXT_EXT = /\.(txt|md|json|ya?ml|toml|csv|log|js|jsx|ts|tsx|py|java|c|cpp|h|hpp|cs|go|rs|rb|php|html|css|scss|sh|xml|sql)$/i;

function fileToAttachment(file: File): Promise<Attachment | null> {
  return new Promise((resolve) => {
    const isImage = file.type.startsWith("image/");
    const isText = !isImage && (file.type.startsWith("text/") || TEXT_EXT.test(file.name));
    if (!isImage && !isText) {
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      resolve({
        id: newAttachId(),
        name: file.name || (isImage ? "pasted-image.png" : "file.txt"),
        mime: file.type || (isImage ? "image/png" : "text/plain"),
        data: String(reader.result || ""),
        kind: isImage ? "image" : "text",
      });
    };
    reader.onerror = () => resolve(null);
    if (isImage) {
      reader.readAsDataURL(file);
    } else {
      reader.readAsText(file);
    }
  });
}

// Cursor's order: Agent, Plan, Multitask, Ask.
const MODES: { id: Mode; label: string; icon: IconName }[] = [
  { id: "agent", label: "Agent", icon: "infinity" },
  { id: "plan", label: "Plan", icon: "list" },
  { id: "multitask", label: "Multitask", icon: "task" },
  { id: "ask", label: "Ask", icon: "chat" },
];

/** Parse a context-size label ("200k", "1m", "128k") to a token count. */
function parseContextSize(v: string | undefined): number {
  if (!v) return 0;
  const m = /^([\d.]+)\s*([km])?$/i.exec(v.trim());
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = (m[2] || "").toLowerCase();
  return Math.round(n * (unit === "m" ? 1_000_000 : unit === "k" ? 1_000 : 1));
}

/** Cursor-style context usage ring shown at the right of the composer bar. */
function ContextRing({ used, total }: { used: number; total: number }) {
  const pct = Math.min(1, used / total);
  const r = 5.5;
  const c = 2 * Math.PI * r;
  const label = `${(used / 1000).toFixed(used >= 100_000 ? 0 : 1)}k / ${total >= 1_000_000 ? `${total / 1_000_000}M` : `${Math.round(total / 1000)}k`} context used`;
  return (
    <span className="ctx-ring" title={label}>
      <svg width="16" height="16" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
        <circle
          cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct)} strokeLinecap="round"
          transform="rotate(-90 8 8)"
        />
      </svg>
    </span>
  );
}

function useOutsideClose(open: boolean, close: () => void) {
  React.useEffect(() => {
    if (!open) return;
    const h = () => close();
    document.addEventListener("click", h);
    return () => document.removeEventListener("click", h);
  }, [open, close]);
}

/**
 * Anchor a position:fixed dropdown to its trigger, adapting to viewport space:
 * opens above when there's room, flips below otherwise; clamps horizontally.
 * Returns inline styles (left/top or left/bottom) + max height for the menu.
 */
function useAnchoredMenu(open: boolean, triggerRef: React.RefObject<HTMLElement | null>, menuRef: React.RefObject<HTMLElement | null>, deps: unknown[] = []) {
  const [style, setStyle] = React.useState<React.CSSProperties>({});
  const [maxH, setMaxH] = React.useState(340);
  React.useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const t = triggerRef.current?.getBoundingClientRect();
      const m = menuRef.current;
      if (!t || !m) return;
      const margin = 8;
      const w = m.offsetWidth;
      let left = t.left;
      if (left + w > window.innerWidth - margin) left = window.innerWidth - margin - w;
      if (left < margin) left = margin;
      const spaceAbove = t.top - margin * 2;
      const spaceBelow = window.innerHeight - t.bottom - margin * 2;
      const needed = Math.min(340, m.scrollHeight || 340);
      if (spaceAbove >= needed || spaceAbove >= spaceBelow) {
        setStyle({ left, bottom: window.innerHeight - t.top + 6, top: "auto" });
        setMaxH(Math.min(340, spaceAbove));
      } else {
        setStyle({ left, top: t.bottom + 6, bottom: "auto" });
        setMaxH(Math.min(340, spaceBelow));
      }
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ...deps]);
  return { style, maxH };
}

function ModePicker({ mode, onMode }: { mode: Mode; onMode: (m: Mode) => void }) {
  const [open, setOpen] = React.useState(false);
  useOutsideClose(open, () => setOpen(false));
  const triggerRef = React.useRef<HTMLSpanElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const { style } = useAnchoredMenu(open, triggerRef, menuRef);
  const meta = MODES.find((m) => m.id === mode) || MODES[0];
  return (
    <span
      ref={triggerRef}
      className="pill mode-pill"
      onClick={(e) => {
        e.stopPropagation();
        setOpen((o) => !o);
      }}
    >
      <Icon name={meta.icon} />
      <span>{meta.label}</span>
      <Icon name="chevD" className="cd" />
      {open && createPortal(
        <div ref={menuRef} className="mode-dropdown" style={style}>
          {MODES.map((o) => (
            <div
              key={o.id}
              className={"mode-item" + (o.id === mode ? " active" : "")}
              onClick={(e) => {
                e.stopPropagation();
                onMode(o.id);
                setOpen(false);
              }}
            >
              <span className="mi-icon">
                <Icon name={o.icon} />
              </span>
              <span className="mi-label">{o.label}</span>
              {o.id === mode && (
                <span className="mi-check">
                  <Icon name="check" />
                </span>
              )}
            </div>
          ))}
        </div>,
        document.body
      )}
    </span>
  );
}

/** True when max_context was injected as a fallback (no catalog preset). */
function isFallbackContext(m?: ModelDef): boolean {
  if (!m) return false;
  const o = m.options.find((x) => x.key === "max_context");
  if (!o?.values) return false;
  return o.values.length >= 5 && o.values.includes("32k") && o.values.includes("1m");
}

/** Context-size dropdown beside model picker for models without catalog presets. */
function ContextPicker({
  model,
  onSave,
}: {
  model?: ModelDef;
  onSave: (modelId: string, options: ModelOption[]) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [style, setStyle] = React.useState<React.CSSProperties>({});
  const opt = model?.options.find((o) => o.key === "max_context");

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  if (!model || !opt || !isFallbackContext(model)) return null;
  const values = opt.values || [];
  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      setStyle({
        position: "fixed",
        left: Math.max(8, r.left),
        bottom: window.innerHeight - r.top + 6,
        zIndex: 200,
      });
    }
    setOpen(true);
  };
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="pill ctx-pill"
        title="Context window size"
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <span>{opt.value || "ctx"}</span>
        <Icon name="chevD" className="cd" />
      </button>
      {open && createPortal(
        <div ref={menuRef} className="mode-dropdown ctx-dropdown" style={style} onClick={(e) => e.stopPropagation()}>
          {values.map((v) => (
            <button
              key={v}
              type="button"
              className={"mode-item" + (v === opt.value ? " active" : "")}
              onClick={() => {
                const next = model.options.map((o) => (o.key === "max_context" ? { ...o, value: v } : o));
                onSave(model.id, next);
                setOpen(false);
              }}
            >
              <span className="mi-label">{v}</span>
              {v === opt.value && (
                <span className="mi-check">
                  <Icon name="check" size={13} />
                </span>
              )}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Short summary of a model's options, e.g. "Low · Thinking". */
function optionSummary(opts: ModelOption[]): string {
  const parts: string[] = [];
  for (const o of opts) {
    if (o.key === "thinking") {
      // Adaptive-only models: "adaptive" IS thinking, so label it "Thinking".
      const adaptiveOnly = !(o.values || []).includes("enabled");
      if (o.value && o.value !== "disabled") parts.push(o.value === "adaptive" && !adaptiveOnly ? "Adaptive" : "Thinking");
    } else if (o.type === "toggle") {
      if (o.value === "true") parts.push(o.label);
    } else if (o.value) {
      parts.push(VALUE_LABELS[o.value] ?? o.value);
    }
  }
  return parts.join(" · ");
}

/**
 * Thinking control: an on/off switch, with a nested "Adaptive" switch shown only
 * when the model supports BOTH adaptive and enabled. The available modes come
 * from the option's `values`:
 *  - [disabled, adaptive, enabled] → toggle + adaptive sub-switch.
 *  - [disabled, adaptive]          → toggle; on = always adaptive (no sub-switch).
 *  - [disabled, enabled]           → toggle; on = manual enabled (no sub-switch).
 */
function ThinkingControl({ value, values, onChange }: { value: string; values: string[]; onChange: (v: string) => void }) {
  const hasAdaptive = values.includes("adaptive");
  const hasEnabled = values.includes("enabled");
  const canChooseAdaptive = hasAdaptive && hasEnabled;
  const onValue = hasAdaptive ? "adaptive" : "enabled"; // what "on" turns into
  const on = value !== "disabled" && value !== "" && value != null;
  const adaptive = value === "adaptive";
  return (
    <div className="mo-thinking">
      <div className="mo-toggle" onClick={() => onChange(on ? "disabled" : onValue)}>
        <span className="mo-label">Thinking</span>
        <span className={"mo-switch" + (on ? " on" : "")}><span className="mo-knob" /></span>
      </div>
      {on && canChooseAdaptive && (
        <div className="mo-toggle sub" onClick={() => onChange(adaptive ? "enabled" : "adaptive")}>
          <span className="mo-label">Adaptive</span>
          <span className={"mo-switch" + (adaptive ? " on" : "")}><span className="mo-knob" /></span>
        </div>
      )}
    </div>
  );
}

/** Friendly labels for option values (reasoning effort tiers etc.). */
const VALUE_LABELS: Record<string, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/** Editable option groups for one model (left column of the picker). */
function ModelOptions({ model, onChange }: { model: ModelDef; onChange: (opts: ModelOption[]) => void }) {
  const setOpt = (i: number, value: string) => onChange(model.options.map((o, idx) => (idx === i ? { ...o, value } : o)));
  if (model.options.length === 0) {
    return <div className="mo-empty">No options for this model.</div>;
  }
  return (
    <div className="model-options">
      {model.options.map((o, i) =>
        o.key === "thinking" ? (
          <ThinkingControl key={i} value={o.value} values={o.values || ["disabled", "adaptive", "enabled"]} onChange={(v) => setOpt(i, v)} />
        ) : o.type === "toggle" ? (
          <div
            key={i}
            className="mo-toggle"
            onClick={() => setOpt(i, o.value === "true" ? "false" : "true")}
          >
            <span className="mo-label">{o.label}</span>
            <span className={"mo-switch" + (o.value === "true" ? " on" : "")}>
              <span className="mo-knob" />
            </span>
          </div>
        ) : (
          <div key={i} className="mo-group">
            <div className="mo-group-label">{o.label}</div>
            {(o.values || []).map((v) => (
              <div key={v} className={"mo-item" + (v === o.value ? " active" : "")} onClick={() => setOpt(i, v)}>
                <span>{VALUE_LABELS[v] ?? v}</span>
                {v === o.value && <Icon name="check" className="mo-check" />}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

function ModelRow({
  m,
  selected,
  editingId,
  onSelect,
  onEdit,
  onReset,
}: {
  m: ModelDef;
  selected: string;
  editingId: string | null;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onReset: (id: string) => void;
}) {
  const editable = m.options.length > 0;
  const [reset, setReset] = React.useState(false);
  const doReset = () => {
    onReset(m.id);
    setReset(true);
    setTimeout(() => setReset(false), 1000);
  };
  return (
    <div
      className={"model-item" + (m.id === selected ? " active" : "") + (m.id === editingId ? " editing" : "")}
      onClick={() => onSelect(m.id)}
    >
      <span className="model-item-name">{m.name}</span>
      {optionSummary(m.options) && <span className="model-item-sum">{optionSummary(m.options)}</span>}
      {editable && (
        <span className="model-item-actions" onClick={(e) => e.stopPropagation()}>
          <button className={"mia-btn" + (reset ? " ok" : "")} title="Reset options" onClick={doReset}>
            <Icon name={reset ? "check" : "reset"} />
          </button>
          <button className="mia-btn" title="Edit options" onClick={() => onEdit(m.id)}>
            <Icon name="edit" />
          </button>
        </span>
      )}
      {m.id === selected && <Icon name="check" className="model-item-check" />}
    </div>
  );
}

function HeadReset({ onReset }: { onReset: () => void }) {
  const [ok, setOk] = React.useState(false);
  return (
    <button
      className={"mp-reset" + (ok ? " ok" : "")}
      title="Reset to defaults"
      onClick={() => {
        onReset();
        setOk(true);
        setTimeout(() => setOk(false), 1000);
      }}
    >
      <Icon name={ok ? "check" : "reset"} />
    </button>
  );
}

function ModelPicker({
  models,
  modelList,
  selected,
  onSelect,
  onSaveOptions,
  onResetOptions,
}: {
  models: string[];
  modelList: ModelDef[];
  selected: string;
  onSelect: (m: string) => void;
  onSaveOptions: (modelId: string, options: ModelOption[]) => void;
  onResetOptions: (modelId: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  useOutsideClose(open, () => {
    setOpen(false);
    setEditingId(null);
    setQuery("");
  });

  // modelList is already the server-filtered set (enabled + default). Fall back to
  // raw ids only if the extension hasn't sent a modelList yet.
  const list: ModelDef[] = React.useMemo(() => {
    if (modelList.length) return modelList;
    return models.map((id) => ({ id, name: id, kind: "openai" as const, options: [] }));
  }, [modelList, models]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
  }, [list, query]);
  const isLocal = (m: ModelDef) => m.kind === "llamacpp" || m.kind === "ollama";
  const llamacppLocal = filtered.filter((m) => m.kind === "llamacpp");
  const ollamaLocal = filtered.filter((m) => m.kind === "ollama");
  // Non-local models grouped by the provider that serves them.
  const byProvider = React.useMemo(() => {
    const groups = new Map<string, ModelDef[]>();
    for (const m of filtered) {
      if (isLocal(m)) continue;
      const key = m.providerName || "Other";
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(m);
    }
    return [...groups.entries()];
  }, [filtered]);

  const editing = editingId ? list.find((m) => m.id === editingId) || null : null;
  const selectedModel = list.find((m) => m.id === selected);
  const selLabel = selected === "auto" ? "Auto" : selectedModel?.name || selected || "no model";
  const summary = selectedModel ? optionSummary(selectedModel.options) : "";

  const triggerRef = React.useRef<HTMLSpanElement>(null);
  const pickerRef = React.useRef<HTMLDivElement>(null);
  // Anchor the fixed picker to the trigger; flips below when no room above.
  const { style: pickerStyle, maxH } = useAnchoredMenu(open, triggerRef, pickerRef, [list.length, !!editing]);

  const pick = (id: string) => {
    onSelect(id);
    setOpen(false);
    setEditingId(null);
    setQuery("");
  };

  return (
    <span
      ref={triggerRef}
      className="model-select"
      onClick={(e) => {
        e.stopPropagation();
        setOpen((o) => !o);
      }}
    >
      <span className="label">{selLabel}</span>
      {summary && <span className="model-summary">{summary}</span>}
      <Icon name="chevD" className="cd" />
      {open && createPortal(
        <div ref={pickerRef} className="model-picker" style={{ ...pickerStyle, "--mp-max-h": `${maxH}px` } as React.CSSProperties} onClick={(e) => e.stopPropagation()}>
          {editing ? (
            <div className="model-picker-view">
              <div className="mp-head">
                <button className="mp-back" title="Back" onClick={() => setEditingId(null)}>
                  <Icon name="chevR" className="mp-back-icon" /> Back
                </button>
                <span className="mp-head-title">{editing.name}</span>
                <HeadReset onReset={() => onResetOptions(editing.id)} />
              </div>
              <div className="mp-body">
                <ModelOptions model={editing} onChange={(opts) => onSaveOptions(editing.id, opts)} />
              </div>
            </div>
          ) : (
            <div className="model-picker-view">
              <div className="mp-search">
                <Icon name="search" className="mp-search-icon" />
                <input
                  autoFocus
                  value={query}
                  placeholder="Search models"
                  onChange={(e) => setQuery(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
              <div className="mp-body">
                {/* Auto (judge-picked model) hidden for now — bring back later.
                <div className={"model-item auto" + (selected === "auto" ? " active" : "")} onClick={() => pick("auto")}>
                  <Icon name="infinity" className="model-item-ico" />
                  <span className="model-item-name">Auto</span>
                  <span className="model-item-sum">picks a model for you</span>
                  {selected === "auto" && <Icon name="check" className="model-item-check" />}
                </div>
                */}
                {filtered.length === 0 && <div className="model-item dim">No matches</div>}
                {byProvider.map(([provName, list]) => (
                  <React.Fragment key={provName}>
                    <div className="mp-group-label">{provName}</div>
                    {list.map((m) => (
                      <ModelRow key={m.id} m={m} selected={selected} editingId={editingId} onSelect={pick} onEdit={setEditingId} onReset={onResetOptions} />
                    ))}
                  </React.Fragment>
                ))}
                {llamacppLocal.length > 0 && <div className="mp-group-label">Local · llama.cpp</div>}
                {llamacppLocal.map((m) => (
                  <ModelRow key={m.id} m={m} selected={selected} editingId={editingId} onSelect={pick} onEdit={setEditingId} onReset={onResetOptions} />
                ))}
                {ollamaLocal.length > 0 && <div className="mp-group-label">Local · Ollama</div>}
                {ollamaLocal.map((m) => (
                  <ModelRow key={m.id} m={m} selected={selected} editingId={editingId} onSelect={pick} onEdit={setEditingId} onReset={onResetOptions} />
                ))}
                <div
                  className="model-item add-models"
                  onClick={() => {
                    post({ type: "openSettings", section: "models" });
                    setOpen(false);
                  }}
                >
                  <Icon name="plus" className="model-item-ico" />
                  <span className="model-item-name">Add models</span>
                </div>
              </div>
            </div>
          )}
        </div>,
        document.body
      )}
    </span>
  );
}

export function Composer({
  mode,
  onMode,
  models,
  modelList,
  selectedModel,
  onSelectModel,
  onSaveModelOptions,
  onResetModelOptions,
  isRunning,
  isFirst,
  focusKey,
  onSubmit,
  onCancel,
  initialText,
  initialAttachments,
  editing,
  onCancelEdit,
  submitWithCtrlEnter,
  draft,
  usedTokens,
  queuedCount,
  onRunNextQueued,
}: {
  mode: Mode;
  onMode: (m: Mode) => void;
  models: string[];
  modelList: ModelDef[];
  selectedModel: string;
  onSelectModel: (m: string) => void;
  onSaveModelOptions: (modelId: string, options: ModelOption[]) => void;
  onResetModelOptions: (modelId: string) => void;
  isRunning: boolean;
  isFirst?: boolean;
  focusKey?: string;
  onSubmit: (text: string, attachments: Attachment[]) => void;
  onCancel: () => void;
  /** Edit mode: seed the editor with an existing message + attachments. */
  initialText?: string;
  initialAttachments?: Attachment[];
  /** When true, renders as an inline edit composer (Save/Cancel affordances). */
  editing?: boolean;
  onCancelEdit?: () => void;
  /** When true, Ctrl+Enter submits and plain Enter inserts a newline. */
  submitWithCtrlEnter?: boolean;
  /** Restored (unsent) message: replaces the editor content when set. */
  draft?: { text: string; attachments?: Attachment[]; mentions?: MentionItem[] } | null;
  /** Tokens consumed by the conversation so far (drives the context ring). */
  usedTokens?: number;
  /** Queued messages count; Enter on an empty editor fires the next one now. */
  queuedCount?: number;
  onRunNextQueued?: () => void;
}) {
  const [attachments, setAttachments] = React.useState<Attachment[]>(initialAttachments ?? []);
  const [dragOver, setDragOver] = React.useState(false);
  const [empty, setEmpty] = React.useState(true); // drives the placeholder
  const edRef = React.useRef<HTMLDivElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  // @-mention popup state
  const [mentionOpen, setMentionOpen] = React.useState(false);
  const [mentionItems, setMentionItems] = React.useState<MentionItem[]>([]);
  const [mentionIndex, setMentionIndex] = React.useState(0);
  // null = top-level category menu; set = drilled into one category.
  const [mentionCat, setMentionCat] = React.useState<MentionCategory | null>(null);
  const mentionCatRef = React.useRef<MentionCategory | null>(null);
  const [mentionQuery, setMentionQuery] = React.useState("");
  const mentionQueryRef = React.useRef("");
  const mentionIndexRef = React.useRef(0);
  const reqRef = React.useRef(0);
  // Saved Range marking the typed "@query" (so we can replace it on pick).
  const queryRangeRef = React.useRef<Range | null>(null);
  // True while a Ctrl+Shift+V paste is in flight (paste as plain text, no link pills).
  const plainPasteRef = React.useRef(false);
  // Paste held back while the host checks if it matches project code.
  const pastePendingRef = React.useRef<{ id: number; text: string } | null>(null);
  // Set after detectMention is defined (insert fns are declared before it).
  const detectMentionRef = React.useRef<(() => void) | null>(null);

  // ---- Undo/redo -----------------------------------------------------------
  // Native contenteditable undo is unreliable inside VS Code webviews (the
  // host intercepts/eats parts of the stack), so we keep our own history of
  // {innerHTML, caret} snapshots and fully own Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z.
  const histRef = React.useRef<{ stack: { html: string; caret: number }[]; idx: number; lastPush: number }>({
    stack: [{ html: "", caret: 0 }],
    idx: 0,
    lastPush: 0,
  });

  /** Caret position as a plain-text offset from the editor start (-1 = none). */
  const caretOffset = (): number => {
    const ed = edRef.current;
    const sel = window.getSelection();
    if (!ed || !sel || !sel.rangeCount || !ed.contains(sel.anchorNode)) return -1;
    const r = sel.getRangeAt(0).cloneRange();
    const probe = document.createRange();
    probe.selectNodeContents(ed);
    probe.setEnd(r.endContainer, r.endOffset);
    return probe.toString().length;
  };

  const setCaretAt = (offset: number) => {
    const ed = edRef.current;
    const sel = window.getSelection();
    if (!ed || !sel) return;
    const range = document.createRange();
    let placed = false;
    if (offset >= 0) {
      let remaining = offset;
      const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const len = node.textContent?.length ?? 0;
        if (remaining <= len) {
          const pill = node.parentElement?.closest(".mention");
          if (pill) range.setStartAfter(pill);
          else range.setStart(node, remaining);
          range.collapse(true);
          placed = true;
          break;
        }
        remaining -= len;
      }
    }
    if (!placed) {
      range.selectNodeContents(ed);
      range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
    ed.focus();
  };

  /** Record the current editor state. Rapid keystrokes coalesce into one entry. */
  const pushHistory = (discrete = false) => {
    const ed = edRef.current;
    if (!ed) return;
    const h = histRef.current;
    const snap = { html: ed.innerHTML, caret: caretOffset() };
    const top = h.stack[h.idx];
    if (top && top.html === snap.html) {
      top.caret = snap.caret;
      return;
    }
    const now = Date.now();
    h.stack.splice(h.idx + 1); // drop redo branch
    if (!discrete && now - h.lastPush < 400 && h.idx > 0) {
      h.stack[h.idx] = snap; // coalesce fast typing
    } else {
      h.stack.push(snap);
      if (h.stack.length > 200) h.stack.shift();
      h.idx = h.stack.length - 1;
    }
    h.lastPush = discrete ? 0 : now; // discrete ops end the coalescing run
  };

  const applySnapshot = (snap: { html: string; caret: number }) => {
    const ed = edRef.current;
    if (!ed) return;
    ed.innerHTML = snap.html;
    setCaretAt(snap.caret);
    refreshEmpty();
  };

  const undoEdit = () => {
    const h = histRef.current;
    if (h.idx > 0) applySnapshot(h.stack[--h.idx]);
  };

  const redoEdit = () => {
    const h = histRef.current;
    if (h.idx < h.stack.length - 1) applySnapshot(h.stack[++h.idx]);
  };

  const setCat = (c: MentionCategory | null) => {
    mentionCatRef.current = c;
    setMentionCat(c);
  };

  const setIndex = (i: number) => {
    mentionIndexRef.current = i;
    setMentionIndex(i);
  };

  const refreshEmpty = React.useCallback(() => {
    const ed = edRef.current;
    setEmpty(!ed || (ed.textContent || "").trim() === "" && ed.querySelectorAll(".mention").length === 0);
  }, []);

  // Auto-focus the editor on tab switch / new chat.
  React.useEffect(() => {
    if (!isRunning) edRef.current?.focus();
  }, [focusKey]);

  /**
   * Fill the editor with message text, turning each <attached type=".."
   * title=".." content=".." /> tag back into a pill. The tag itself IS the
   * stored/sent representation, so edits always restore full mention objects.
   */
  const seedEditor = (ed: HTMLDivElement, text: string) => {
    ed.innerHTML = "";
    const appendText = (s: string) => {
      const lines = s.split("\n");
      lines.forEach((line, i) => {
        if (i > 0) ed.appendChild(document.createElement("br"));
        if (line) ed.appendChild(document.createTextNode(line));
      });
    };
    const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&amp;/g, "&");
    const re = /<attached\s+([^>]*?)\/?>/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      appendText(text.slice(last, m.index));
      const attrs: Record<string, string> = {};
      for (const a of m[1].matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = unesc(a[2]);
      ed.appendChild(makeMentionEl({
        kind: (attrs.type || "file") as MentionItem["kind"],
        name: attrs.title || attrs.content || "",
        path: attrs.content || "",
      }));
      ed.appendChild(document.createTextNode("\u00a0"));
      last = re.lastIndex;
      if (text[last] === " ") last++; // the space we added after the pill
    }
    appendText(text.slice(last));
  };

  // Seed the editor once with existing text when opened in edit mode.
  React.useEffect(() => {
    const ed = edRef.current;
    if (!ed || initialText == null) return;
    seedEditor(ed, initialText);
    pushHistory(true);
    refreshEmpty();
    // Place caret at end + focus.
    ed.focus();
    const range = document.createRange();
    range.selectNodeContents(ed);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A reverted message arrives as a draft: load it into the editor as if unsent.
  React.useEffect(() => {
    if (!draft) return;
    const ed = edRef.current;
    if (!ed) return;
    seedEditor(ed, draft.text);
    pushHistory(true);
    setAttachments(draft.attachments ?? []);
    refreshEmpty();
    ed.focus();
    const range = document.createRange();
    range.selectNodeContents(ed);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const queryFiles = React.useCallback((q: string) => {
    const id = ++mentionReqId;
    reqRef.current = id;
    post({ type: "searchFiles", query: q, requestId: id });
  }, []);

  const queryMentions = React.useCallback((cat: MentionCategory, q: string) => {
    const id = ++mentionReqId;
    reqRef.current = id;
    post({ type: "searchMentions", kind: cat, query: q, requestId: id });
  }, []);

  /** Categories filtered by the typed @query (top-level menu). */
  const filteredCats = React.useMemo(() => {
    const q = mentionQuery.toLowerCase();
    if (!q) return MENTION_CATEGORIES;
    return MENTION_CATEGORIES.filter((c) => c.label.toLowerCase().includes(q));
  }, [mentionQuery]);

  const addFiles = React.useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files);
    const results = await Promise.all(arr.map(fileToAttachment));
    const valid = results.filter((a): a is Attachment => a !== null);
    if (valid.length) {
      setAttachments((prev) => [...prev, ...valid]);
    }
  }, []);

  // Build an inline, non-editable mention pill element:
  // [kind/file icon | ×-on-hover] @name
  const makeMentionEl = (m: MentionItem): HTMLElement => {
    const span = document.createElement("span");
    span.className = "mention";
    span.contentEditable = "false";
    span.dataset.path = m.path;
    span.dataset.kind = m.kind;
    span.dataset.name = m.name;
    if (m.detail) span.dataset.detail = m.detail;
    span.title = m.detail || m.path;

    const icon = document.createElement("span");
    icon.className = "mention-icon";
    icon.innerHTML = KIND_SVG[m.kind] || KIND_SVG.file;
    if (m.kind === "file" || m.kind === "code") applyFileIconTo(icon, m.path);
    span.appendChild(icon);

    const x = document.createElement("span");
    x.className = "mention-x";
    x.innerHTML = X_SVG;
    x.title = "Remove";
    span.appendChild(x);

    const label = document.createElement("span");
    label.className = "mention-label";
    label.textContent = m.name;
    span.appendChild(label);
    return span;
  };

  // Move the caret to the end of the editor if the selection isn't inside it.
  const ensureCaretInEditor = () => {
    const ed = edRef.current;
    if (!ed) return;
    ed.focus();
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !ed.contains(sel.anchorNode)) {
      const range = document.createRange();
      range.selectNodeContents(ed);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  };

  const escapeHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // Manual Range-based insertion at the caret; afterwards the caret always
  // sits right AFTER the last inserted node.
  const insertFragManually = (frag: DocumentFragment) => {
    const ed = edRef.current;
    const sel = window.getSelection();
    if (!ed || !sel || !sel.rangeCount) return;
    let range = sel.getRangeAt(0);
    // Selection escaped the editor (popup click etc.): fall back to the end.
    if (!ed.contains(range.startContainer)) {
      range = document.createRange();
      range.selectNodeContents(ed);
      range.collapse(false);
    }
    range.deleteContents();
    const last = frag.lastChild;
    range.insertNode(frag);
    if (last) {
      const after = document.createRange();
      after.setStartAfter(last);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    }
    ed.focus();
  };

  // All programmatic insertions land in our own undo history as one discrete
  // step, so Ctrl+Z/Ctrl+Y behave exactly like a normal textarea.
  const insertNodesAtCaret = (nodes: Node[]) => {
    const ed = edRef.current;
    if (!ed) return;
    ensureCaretInEditor();
    const frag = document.createDocumentFragment();
    for (const n of nodes) frag.appendChild(n);
    insertFragManually(frag);
    pushHistory(true);
    refreshEmpty();
    detectMentionRef.current?.();
  };

  // Plain text insertion (paste, @ button): undo-friendly, keeps newlines.
  const insertTextAtCaret = (text: string) => {
    const ed = edRef.current;
    if (!ed) return;
    ensureCaretInEditor();
    const frag = document.createDocumentFragment();
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (i > 0) frag.appendChild(document.createElement("br"));
      if (line) frag.appendChild(document.createTextNode(line));
    });
    insertFragManually(frag);
    pushHistory(true);
    refreshEmpty();
    detectMentionRef.current?.();
  };

  const insertMention = (m: MentionItem) => {
    insertNodesAtCaret([makeMentionEl(m), document.createTextNode("\u00a0")]);
  };

  // Make the whole webview a valid drop target. VS Code only routes drag events
  // INTO a webview while the user holds Shift (otherwise the editor's own drop
  // overlay captures pointer events and opens the file in an editor group).
  React.useEffect(() => {
    const handleDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      const dt = e.dataTransfer;
      if (!dt) return;
      if (dt.files.length) {
        addFiles(dt.files);
      }
      const raws = [
        dt.getData("text/uri-list"),
        dt.getData("application/vnd.code.uri-list"),
        dt.getData("codeeditors"),
        dt.getData("resourceurls"),
        dt.getData("text/plain"),
      ].filter(Boolean);
      const paths = parseDroppedPaths(raws);
      if (paths.length) {
        const nodes: Node[] = [];
        for (const p of paths) {
          const name = p.split(/[\\/]/).pop() || p;
          nodes.push(makeMentionEl({ path: p, name, kind: "file" }));
          nodes.push(document.createTextNode("\u00a0"));
        }
        insertNodesAtCaret(nodes);
      } else if (!dt.files.length) {
        const plain = dt.getData("text/plain");
        if (plain) insertNodesAtCaret([document.createTextNode(plain)]);
      }
    };
    const over = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      setDragOver(true);
    };
    const leave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragOver(false);
    };
    // Capture phase so we win before VS Code's own webview handlers.
    window.addEventListener("dragover", over, true);
    window.addEventListener("drop", handleDrop, true);
    window.addEventListener("dragleave", leave, true);
    return () => {
      window.removeEventListener("dragover", over, true);
      window.removeEventListener("drop", handleDrop, true);
      window.removeEventListener("dragleave", leave, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Receive attachments + file-search results from the extension.
  React.useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.type === "attachmentsPicked" && Array.isArray(msg.attachments)) {
        setAttachments((prev) => [...prev, ...msg.attachments]);
      } else if (msg?.type === "fileSearchResults" && msg.requestId === reqRef.current) {
        setMentionItems(msg.items || []);
        setIndex(0);
      } else if (msg?.type === "mentionSearchResults" && msg.requestId === reqRef.current) {
        setMentionItems(msg.items || []);
        setIndex(0);
      } else if (msg?.type === "insertMention" && msg.mention && !editing) {
        // Ctrl+L from the editor: insert a @code/@file pill at the caret.
        insertMention(msg.mention as MentionItem);
      } else if (msg?.type === "pasteResolved" && pastePendingRef.current && msg.requestId === pastePendingRef.current.id) {
        // Host checked the pasted text against project files.
        const pending = pastePendingRef.current;
        pastePendingRef.current = null;
        if (msg.mention) insertMention(msg.mention as MentionItem);
        else insertTextAtCaret(pending.text);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const removeAttachment = (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id));

  // Detect an active "@query" right before the caret (within the current text node).
  const detectMention = React.useCallback(() => {
    const close = () => {
      setMentionOpen(false);
      setCat(null);
    };
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) {
      close();
      return;
    }
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) {
      close();
      return;
    }
    const text = node.textContent || "";
    const caret = range.startOffset;
    const upto = text.slice(0, caret);
    const at = upto.lastIndexOf("@");
    if (at === -1) {
      close();
      return;
    }
    const frag = upto.slice(at + 1);
    const prevChar = at > 0 ? upto[at - 1] : "";
    // Inside a category, allow spaces in the query (e.g. commit messages).
    if ((at !== 0 && !/\s/.test(prevChar)) || (mentionCatRef.current === null && /\s/.test(frag))) {
      close();
      return;
    }
    // Save the range covering "@frag" so we can replace it on selection.
    const r = document.createRange();
    r.setStart(node, at);
    r.setEnd(node, caret);
    queryRangeRef.current = r;
    setMentionOpen(true);
    mentionQueryRef.current = frag;
    setMentionQuery(frag);
    // Pasting/typing a URL after @ becomes a Link mention.
    if (/^https?:\/\//.test(frag)) {
      setCat("link");
      queryMentions("link", frag);
      return;
    }
    const cat = mentionCatRef.current;
    if (cat) queryMentions(cat, frag);
    else queryFiles(frag); // top level: quick file results above the categories
  }, [queryFiles, queryMentions]);
  detectMentionRef.current = detectMention;

  const pickMention = React.useCallback((m: MentionItem) => {
    const ed = edRef.current;
    const qr = queryRangeRef.current;
    if (!ed) return;
    if (qr) {
      // Select the typed "@query"; insertHTML then replaces the selection in
      // one undoable step (native undo stack stays intact).
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(qr);
    }
    insertMention(m);
    setMentionOpen(false);
    setCat(null);
    queryRangeRef.current = null;
  }, []);

  /** Drill into a category from the top-level @ menu (leafs insert directly). */
  const pickCategory = React.useCallback((cat: MentionCategory) => {
    setCat(cat);
    setMentionItems([]);
    setIndex(0);
    queryMentions(cat, mentionQueryRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryMentions]);

  React.useEffect(() => {
    edRef.current?.focus();
  }, []);

  // Serialize editor content to a plain string. Mention pills become full
  // <attached type=".." title=".." content=".." /> tags — the message text
  // itself carries the complete mention data and is sent to the AI as-is.
  const serialize = (): string => {
    const ed = edRef.current;
    if (!ed) return "";
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
    let out = "";
    const walk = (n: Node) => {
      n.childNodes.forEach((c) => {
        if (c.nodeType === Node.TEXT_NODE) {
          out += (c.textContent || "").replace(/\u00a0/g, " ");
        } else if (c instanceof HTMLElement) {
          if (c.classList.contains("mention")) {
            out += `<attached type="${esc(c.dataset.kind || "file")}" title="${esc(c.dataset.name || "")}" content="${esc(c.dataset.path || "")}" />`;
          } else if (c.tagName === "BR") {
            out += "\n";
          } else {
            walk(c);
            if (c.tagName === "DIV") out += "\n";
          }
        }
      });
    };
    walk(ed);
    return out.trim();
  };

  const clear = () => {
    if (edRef.current) {
      edRef.current.innerHTML = "";
      edRef.current.focus();
    }
    histRef.current = { stack: [{ html: "", caret: 0 }], idx: 0, lastPush: 0 };
    refreshEmpty();
  };

  // Send (or queue, when a run is in flight). Never stops the run — stopping is
  // only possible via an explicit click on the stop button.
  const submit = () => {
    const text = serialize();
    if (!text && attachments.length === 0) {
      // Empty editor + queued messages: fire the next queued one immediately
      // (replaces the current run if one is in flight).
      if ((queuedCount ?? 0) > 0) onRunNextQueued?.();
      return;
    }
    if (!editing) clear();
    const sent = attachments;
    if (!editing) setAttachments([]);
    setMentionOpen(false);
    setCat(null);
    onSubmit(text, sent);
  };

  const hasContent = !empty || attachments.length > 0;
  const canSend = hasContent;
  // While running with an empty editor the button is a Stop button; as soon as
  // there's content it becomes Send (which queues behind the current run).
  const showStop = !editing && isRunning && !hasContent;

  return (
    <div className="chat-input">
      <div
        className={"composer" + (dragOver ? " drag-over" : "")}
      >
        {dragOver && (
          <div className="drop-hint">
            <AtSign size={13} /> Drop to mention &nbsp;·&nbsp; hold <kbd>Shift</kbd> if it opens the file instead
          </div>
        )}
        {attachments.length > 0 && (
          <div className="attach-chips">
            {attachments.map((a) => (
              <div className="attach-chip" key={a.id} title={a.name}>
                {a.kind === "image" ? (
                  <img className="attach-thumb" src={a.data} alt="" />
                ) : (
                  <div className="attach-file">
                    <Icon name="file" size={16} />
                  </div>
                )}
                <button className="attach-remove" onClick={() => removeAttachment(a.id)} aria-label="Remove">
                  <Icon name="close" size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
        {mentionOpen && (
          <div className="mention-popup" onMouseDown={(e) => e.preventDefault()}>
            {mentionCat === null ? (
              <>
                {/* Cursor layout: quick file results on top, divider, then categories. */}
                {mentionItems.slice(0, 3).map((m, i) => (
                  <div
                    key={m.kind + m.path}
                    className={"mention-item" + (i === mentionIndex ? " active" : "")}
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => pickMention(m)}
                  >
                    <Icon name={KIND_ICON[m.kind] || "file"} size={14} />
                    <span className="mi-name">{m.name}</span>
                    <span className="mi-path">{(m.detail ?? m.path).replace(/\/[^/]*$/, "") || "."}</span>
                  </div>
                ))}
                {mentionItems.length > 0 && filteredCats.length > 0 && <div className="mention-divider" />}
                {filteredCats.map((c, i) => {
                  const idx = Math.min(3, mentionItems.length) + i;
                  return (
                    <div
                      key={c.id}
                      className={"mention-item cat" + (idx === mentionIndex ? " active" : "")}
                      onMouseEnter={() => setIndex(idx)}
                      onClick={() => pickCategory(c.id)}
                    >
                      <Icon name={c.icon} size={14} />
                      <span className="mi-name">{c.label}</span>
                      {!c.leaf && <ChevronRight size={12} className="mi-chev" />}
                    </div>
                  );
                })}
              </>
            ) : (
              <>
                <div className="mention-head">
                  <AtSign size={11} /> {MENTION_CATEGORIES.find((c) => c.id === mentionCat)?.label ?? mentionCat}
                </div>
                {mentionItems.length === 0 ? (
                  <div className="mention-empty">{mentionCat === "link" ? "Type or paste a URL after @" : "No matches"}</div>
                ) : (
                  mentionItems.map((m, i) => (
                    <div
                      key={m.kind + m.path}
                      className={"mention-item" + (i === mentionIndex ? " active" : "")}
                      onMouseEnter={() => setIndex(i)}
                      onClick={() => pickMention(m)}
                    >
                      <Icon name={KIND_ICON[m.kind] || "file"} size={14} />
                      <span className="mi-name">{m.name}</span>
                      <span className="mi-path">{m.detail ?? m.path}</span>
                    </div>
                  ))
                )}
              </>
            )}
          </div>
        )}
        <div
          ref={edRef}
          className={"editor" + (empty ? " empty" : "")}
          contentEditable
          role="textbox"
          aria-multiline="true"
          data-placeholder={isFirst ? "Plan, Build, / for skills, @ for context" : "Add a follow-up"}
          suppressContentEditableWarning
          onDragOver={(e) => e.preventDefault()}
          onClick={(e) => {
            const t = e.target as HTMLElement;
            const el = t.closest(".mention") as HTMLElement | null;
            if (!el) return;
            e.preventDefault();
            if (t.closest(".mention-x")) {
              // Remove the pill (and the nbsp spacer that follows it).
              const next = el.nextSibling;
              if (next?.nodeType === Node.TEXT_NODE && next.textContent === "\u00a0") next.remove();
              el.remove();
              pushHistory(true);
              refreshEmpty();
              return;
            }
            if (el.dataset.path) {
              post({ type: "openMention", kind: (el.dataset.kind as MentionItem["kind"]) || "file", path: el.dataset.path });
            }
          }}
          onInput={() => {
            pushHistory();
            refreshEmpty();
            detectMention();
          }}
          onPaste={(e) => {
            const plain = plainPasteRef.current;
            plainPasteRef.current = false;
            const dt = e.clipboardData;
            if (!dt) return; // let the browser handle it natively
            const files = Array.from(dt.items || [])
              .filter((it) => it.kind === "file")
              .map((it) => it.getAsFile())
              .filter((f): f is File => !!f);
            if (files.length) {
              e.preventDefault();
              addFiles(files);
              return;
            }
            const text = dt.getData("text/plain");
            if (!text) return; // nothing we can do better than the browser
            // Always paste as plain text (strip rich HTML), via insertText so
            // native undo/redo works like a textarea.
            e.preventDefault();
            // Pasting a bare URL auto-becomes a @Link mention (Cursor behavior);
            // Ctrl+Shift+V skips this and pastes the raw text.
            const t = text.trim();
            if (!plain && /^https?:\/\/\S+$/.test(t) && !t.includes("\n")) {
              insertNodesAtCaret([
                makeMentionEl({ kind: "link", path: t, name: t.replace(/^https?:\/\//, "").replace(/\/$/, "") }),
                document.createTextNode("\u00a0"),
              ]);
              return;
            }
            // Code copied from a project file → @code mention (Cursor behavior).
            // Ask the host to locate the text; insert on reply (fast round-trip).
            if (!plain && t.includes("\n")) {
              const id = ++mentionReqId;
              pastePendingRef.current = { id, text };
              post({ type: "resolvePastedCode", text: t, requestId: id });
              return;
            }
            insertTextAtCaret(text);
          }}
          onKeyDown={(e) => {
            // Own the undo/redo chords (native contenteditable undo is broken
            // inside VS Code webviews).
            if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "z") {
              e.preventDefault();
              e.stopPropagation();
              if (e.shiftKey) redoEdit();
              else undoEdit();
              return;
            }
            if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "y") {
              e.preventDefault();
              e.stopPropagation();
              redoEdit();
              return;
            }
            // Ctrl+Shift+V → paste without formatting (no link pills).
            // VS Code may swallow this chord before the webview gets a paste
            // event, so read the clipboard ourselves as a fallback.
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "v") {
              e.preventDefault();
              e.stopPropagation();
              navigator.clipboard
                .readText()
                .then((text) => {
                  if (text) insertTextAtCaret(text);
                })
                .catch(() => {
                  // Clipboard API blocked: fall back to the paste event path.
                  plainPasteRef.current = true;
                  document.execCommand("paste");
                });
              return;
            }
            if (mentionOpen) {
              // Top-level: quick file hits (max 3) then category rows.
              const quick = mentionCat === null ? Math.min(3, mentionItems.length) : 0;
              const count = mentionCat === null ? quick + filteredCats.length : mentionItems.length;
              if (count) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setIndex((mentionIndexRef.current + 1) % count);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setIndex((mentionIndexRef.current - 1 + count) % count);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  const i = mentionIndexRef.current;
                  if (mentionCat === null) {
                    if (i < quick) pickMention(mentionItems[i]);
                    else pickCategory(filteredCats[i - quick].id);
                  } else {
                    pickMention(mentionItems[i]);
                  }
                  return;
                }
              }
              if (e.key === "Escape" || (e.key === "Backspace" && mentionCat !== null && !mentionQuery)) {
                e.preventDefault();
                if (mentionCat !== null) {
                  // Back out to the category menu.
                  setCat(null);
                  setMentionItems([]);
                  setIndex(0);
                  if (mentionQueryRef.current) queryFiles(mentionQueryRef.current);
                } else {
                  setMentionOpen(false);
                }
                return;
              }
            }
            if (e.key === "Enter" && (submitWithCtrlEnter ? e.ctrlKey || e.metaKey : !e.shiftKey)) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape" && editing) {
              e.preventDefault();
              onCancelEdit?.();
            }
          }}
        />
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*,text/*,.md,.json,.ts,.tsx,.js,.jsx,.py,.css,.html,.yaml,.yml,.toml,.csv,.log"
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files?.length) {
              addFiles(e.target.files);
            }
            e.target.value = "";
          }}
        />
        <div className="composer-bar">
          <ModePicker mode={mode} onMode={onMode} />
          <ModelPicker models={models} modelList={modelList} selected={selectedModel} onSelect={onSelectModel} onSaveOptions={onSaveModelOptions} onResetOptions={onResetModelOptions} />
          {(() => {
            const sel = modelList.find((m) => m.id === selectedModel);
            return <ContextPicker model={sel} onSave={onSaveModelOptions} />;
          })()}
          <div className="right">
            {!editing && (() => {
              const sel = modelList.find((m) => m.id === selectedModel);
              const total = parseContextSize(sel?.options.find((o) => o.key === "max_context")?.value) || 128_000;
              return <ContextRing used={usedTokens ?? 0} total={total} />;
            })()}
            <button
              className="attach-btn"
              title="Attach images or files"
              onClick={() => fileRef.current?.click()}
            >
              <Icon name="paperclip" size={15} />
            </button>
            {editing && (
              <button className="attach-btn" title="Cancel edit (Esc)" onClick={() => onCancelEdit?.()}>
                <Icon name="close" size={15} />
              </button>
            )}
            <button
              className={"send-btn" + (showStop ? " stop" : canSend ? "" : " disabled")}
              title={showStop ? "Stop" : editing ? "Resend" : isRunning ? "Queue message" : "Send"}
              onClick={showStop ? onCancel : submit}
            >
              {showStop ? (
                <Square size={10} fill="currentColor" strokeWidth={0} />
              ) : (
                <ArrowUp size={16} strokeWidth={2.25} />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as React from "react";
import { Trash2 } from "lucide-react";
import { Icon } from "../../shared/icons";
import type { ConversationSummary } from "../types";

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  return d + "d ago";
}

export function History({
  list,
  activeId,
  onSelect,
  onDelete,
  onClose,
}: {
  list: ConversationSummary[];
  activeId?: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = query
    ? list.filter((c) => c.title.toLowerCase().includes(query.toLowerCase()))
    : list;

  return (
    <div className="history-overlay" onClick={onClose}>
      <div className="history-popup" onClick={(e) => e.stopPropagation()}>
        {/* Search */}
        <div className="history-search">
          <Icon name="search" size={14} />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search previous chats…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
        </div>
        {/* List */}
        <div className="history-list">
          {filtered.length === 0 ? (
            <div className="history-empty">
              {list.length === 0 ? "No conversations yet." : "No results."}
            </div>
          ) : (
            filtered.map((c) => (
              <div
                key={c.id}
                className={"history-item" + (c.id === activeId ? " active" : "")}
                onClick={() => onSelect(c.id)}
              >
                <div className="hi-text">
                  <div className="hi-title">{c.title}</div>
                  <div className="hi-time">{timeAgo(c.updatedAt)}</div>
                </div>
                <button
                  className="hi-del"
                  title="Delete conversation"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(c.id);
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

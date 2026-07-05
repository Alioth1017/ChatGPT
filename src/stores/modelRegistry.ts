/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

// Backend-owned model registry: fetches the full provider-grouped model list
// once at activation (and on config/OAuth changes), so UIs like the settings
// panel are just views over already-loaded data — no per-page fetch/wait.
import { listModels } from "../agent/provider";
import * as oauth from "../agent/oauth";
import { FeatureStore, providerEnabled, type ModelDef } from "./featureStore";
import type { SettingsManager } from "./settingsManager";
import { setEmbedModel, setRemoteEmbedModel, EMBED_MODELS } from "../agent/semanticIndex";

export interface AllModels {
  models: string[];
  modelList: ModelDef[];
}

let cache: AllModels | null = null;
let deps: { featureStore: FeatureStore; settingsManager: SettingsManager } | null = null;
let inflight: Promise<AllModels> | null = null;
const listeners = new Set<(d: AllModels) => void>();

export function getAllModels(): AllModels | null {
  return cache;
}

export function onAllModels(cb: (d: AllModels) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Call once at activation. Prefetches and keeps the list fresh. */
export function initModelRegistry(featureStore: FeatureStore, settingsManager: SettingsManager) {
  deps = { featureStore, settingsManager };
  featureStore.onDidChange(() => void refreshAllModels());
  oauth.onOAuthStatus(() => void refreshAllModels());
  void refreshAllModels();
}

/**
 * Configure semanticIndex for the given embed model id: a built-in local model
 * id (e.g. "minilm") or a provider model id (e.g. "text-embedding-3-small"),
 * resolved to its provider baseUrl + key via the registry cache.
 */
export async function applyEmbedModel(id: string): Promise<void> {
  if (!id || EMBED_MODELS.some((m) => m.id === id)) {
    setEmbedModel(id || "minilm");
    return;
  }
  if (!deps) return;
  const def = (cache?.modelList ?? []).find((m) => m.id === id);
  const provider = def && deps.featureStore.get().providers.find((p) => p.id === def.providerId);
  if (!provider) {
    setEmbedModel("minilm"); // provider gone → fall back to local
    return;
  }
  const key = (await deps.settingsManager.getProviderKey(provider.id)) || "";
  setRemoteEmbedModel({ id, baseUrl: provider.baseUrl, apiKey: key });
}

/** Fetch models from every ENABLED provider, grouped by provider. Coalesced. */
export function refreshAllModels(): Promise<AllModels> {
  if (inflight) return inflight;
  inflight = doFetch().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doFetch(): Promise<AllModels> {
  if (!deps) return { models: [], modelList: [] };
  const { featureStore, settingsManager } = deps;
  const features = featureStore.get();
  const enabled = features.providers.filter(providerEnabled);
  const list: ModelDef[] = [];
  const seen = new Set<string>();

  for (const p of enabled) {
    const key = (await settingsManager.getProviderKey(p.id)) || "";
    const anthropic = p.kind === "anthropic";
    if (!key && anthropic) continue;
    try {
      const fetched = await listModels(p.baseUrl, key, anthropic);
      for (const m of fetched) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        list.push({ id: m.id, name: featureStore.nameFor(m.id, p.kind), kind: p.kind, options: featureStore.optionsFor(m.id, p.kind), providerId: p.id, providerName: p.name });
      }
    } catch {
      // Skip providers that fail to list (bad key, offline, etc.).
    }
  }

  // OAuth account models (Claude Code / Codex / Antigravity) — grouped by account.
  for (const kind of ["claude-code", "codex", "antigravity"] as oauth.OAuthKind[]) {
    if (!oauth.isConnected(kind)) continue;
    const label = oauth.OAUTH_LABEL[kind];
    const k = kind === "claude-code" ? "anthropic" : kind === "codex" ? "openai" : "google";
    let ids: string[] = [];
    try { ids = await oauth.listOAuthModels(kind); } catch { ids = []; }
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      list.push({ id, name: featureStore.nameFor(id, kind), kind: k as ModelDef["kind"], options: featureStore.optionsFor(id, kind), providerId: `oauth:${kind}`, providerName: label });
    }
  }

  cache = { models: list.map((m) => m.id), modelList: list };
  listeners.forEach((fn) => fn(cache!));
  // Re-resolve a remote embedding model now that provider info is loaded.
  const em = features.embedModel;
  if (em && !EMBED_MODELS.some((m) => m.id === em)) void applyEmbedModel(em);
  return cache;
}

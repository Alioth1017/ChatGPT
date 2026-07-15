/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as vscode from 'vscode';
import { SettingsManager } from './stores/settingsManager';
import { SidebarProvider } from './ui/sidebarProvider';
import { registerInlineReview } from './ui/inlineReview';
import { SettingsPanel } from './ui/settingsPanel';
import { FeatureStore } from './stores/featureStore';
import { setToolTimeoutOverrides } from './agent/tools/shared';
import { mcpManager } from './integrations/mcpClient';
import { setIndexStorageDir } from './agent/semanticIndex';
import { setDocsStorageDir, setDocSourcesProvider } from './agent/docsIndex';
import { initIndexWatch } from './agent/indexWatch';
import { initLlamacpp, checkInstalled, loadModel, disposeLlamacpp } from './agent/llamacpp';
import { initOAuth } from './agent/oauth';
import { initUsage } from './stores/usageStore';
import { initModelRegistry, applyEmbedModel } from './stores/modelRegistry';
import { initRuntimeDeps } from './runtimeDeps';

export function activate(context: vscode.ExtensionContext) {
  console.log('OpenCursor is now active!');

  // Heavy native deps (onnxruntime, sharp, transformers) are not shipped in the
  // VSIX; they are downloaded to globalStorage on first use.
  initRuntimeDeps(context.globalStorageUri.fsPath);

  const settingsManager = new SettingsManager(context);
  const featureStore = new FeatureStore(context);
  const syncToolTimeouts = () => setToolTimeoutOverrides(featureStore.get().toolTimeoutsSec);
  syncToolTimeouts();
  context.subscriptions.push(featureStore.onDidChange(syncToolTimeouts));
  initOAuth(context);
  initUsage(context);
  // Prefetch the provider-grouped model list so every UI (settings, pickers)
  // renders instantly from the backend cache.
  initModelRegistry(featureStore, settingsManager);

  // Local semantic index: vectors in globalStorage; warm disk + incremental sync.
  setIndexStorageDir(context.globalStorageUri.fsPath);
  setDocsStorageDir(context.globalStorageUri.fsPath);
  setDocSourcesProvider(() => featureStore.get().docSources ?? []);
  applyEmbedModel(featureStore.get().embedModel || "minilm")
    .then(() => initIndexWatch(context, featureStore))
    .catch(() => initIndexWatch(context, featureStore));

  // Connect any enabled MCP servers in the background.
  mcpManager.sync(featureStore.get().mcpServers).catch(() => {});

  // llama.cpp local models: detect install, then auto-load flagged models.
  initLlamacpp(context);
  checkInstalled().then(() => {
    const f = featureStore.get();
    for (const m of f.llamacppModels) {
      if (m.autoLoad) loadModel(m, f.llamacppConfig).catch(() => {});
    }
  });

  // Create the shared output channel while the extension host is alive and
  // dispose it with the extension (avoids "DisposableStore already disposed" leaks).
  context.subscriptions.push(SidebarProvider.log);

  const sidebarProvider = new SidebarProvider(context, settingsManager, featureStore);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider, {
      // Keep the chat webview (and any in-flight agent run's UI state) alive when
      // hidden/collapsed or switched away, so reopening never resets to a blank chat.
      webviewOptions: { retainContextWhenHidden: true },
    })

  );

  // Virtual-doc provider serving the "before" side of agent-edit diffs.
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("ocursor-original", {
      provideTextDocumentContent(uri) {
        return sidebarProvider._originalDocs.get(uri.path) ?? "";
      },
    })
  );

  // Inline (in-editor) Keep/Undo CodeLenses + changed-line decorations (no git needed).
  registerInlineReview(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('ocursor.openSettings', (section?: string) => {
      SettingsPanel.createOrShow(context, settingsManager, featureStore, section);
    })
  );

  // Ctrl+L: add the current selection (or file) to chat as a mention.
  context.subscriptions.push(
    vscode.commands.registerCommand('ocursor.addToChat', () => sidebarProvider.addSelectionToChat())
  );

  context.subscriptions.push({ dispose: () => mcpManager.disposeAll() });
  context.subscriptions.push({ dispose: () => disposeLlamacpp() });
}

export function deactivate() {
  mcpManager.disposeAll();
  disposeLlamacpp();
}

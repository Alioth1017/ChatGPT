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
import { ModelSelect } from "../../shared/ModelSelect";
import { FeatureConfig, ModelDef, RuleInfo, SkillInfo, SubagentDef, uid } from "../features";

export function RulesPanel({
  features,
  setFeatures,
  rules,
  skills,
  models,
  modelList = [],
}: {
  features: FeatureConfig;
  setFeatures: (f: Partial<FeatureConfig>) => void;
  rules: RuleInfo[];
  skills: SkillInfo[];
  models: string[];
  modelList?: ModelDef[];
}) {
  // Prefer the provider-grouped list; fall back to raw ids.
  const selectModels = modelList.length ? modelList : models.map((id) => ({ id, name: id }));
  const updateSub = (i: number, patch: Partial<SubagentDef>) => {
    const next = features.subagents.map((s, idx) => (idx === i ? { ...s, ...patch } : s));
    setFeatures({ subagents: next });
  };
  const removeSub = (i: number) => setFeatures({ subagents: features.subagents.filter((_, idx) => idx !== i) });
  const addSub = () =>
    setFeatures({
      subagents: [
        ...features.subagents,
        { id: uid("sub"), name: "explorer", description: "Explores the codebase", prompt: "", readonly: true },
      ],
    });

  return (
    <>
      <h1 className="page-title" style={{ marginBottom: 4 }}>Rules, Skills, Subagents</h1>
      <p className="panel-hint" style={{ marginBottom: 24 }}>Provide domain-specific knowledge and workflows for the agent</p>

      <div className="rss-section-head">
        <span className="rss-title">Rules <span className="rss-help" title="Rules live in .cursor/rules/*.md and AGENTS.md. Always-apply rules are injected every turn.">?</span></span>
        <button className="btn-ghost sm" onClick={() => vscode.postMessage({ type: "createRule" })}>
          <Icon name="plus" size={12} /> New
        </button>
      </div>
      <p className="panel-hint">Use Rules to guide agent behavior, like enforcing best practices or coding standards. Rules can be applied always, by file path, or manually.</p>
      {rules.length === 0 ? (
        <div className="rss-empty">
          <div className="rss-empty-title">No Rules Yet</div>
          <div className="rss-empty-sub">Create rules to guide agent behavior</div>
          <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "createRule" })}>New Rule</button>
        </div>
      ) : (
        <div className="rss-list">
          {rules.map((r) => (
            <div
              className="rss-row"
              key={r.file}
              title={r.path ? "Open " + r.file : undefined}
              onClick={() => r.path && vscode.postMessage({ type: "openWorkspaceFile", path: r.path })}
            >
              <div className="lr-text">
                <div className="lr-title">{r.description || r.file}</div>
                {r.description && <div className="lr-desc">{r.file}{r.globs ? ` · ${r.globs}` : ""}</div>}
              </div>
              <span className={"badge-tag " + (r.alwaysApply ? "always" : "glob")}>{r.alwaysApply ? "always" : r.globs ? "glob" : "manual"}</span>
              {r.path && (
                <button
                  className="icon-btn rss-del"
                  title="Delete rule"
                  onClick={(e) => { e.stopPropagation(); vscode.postMessage({ type: "deleteRule", path: r.path, name: r.file }); }}
                >
                  <Icon name="trash" size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="rss-section-head" style={{ marginTop: 28 }}>
        <span className="rss-title">Skills <span className="rss-help" title="Skills live in .cursor/skills/*/SKILL.md. The agent reads them when a task matches.">?</span></span>
        <button className="btn-ghost sm" onClick={() => vscode.postMessage({ type: "createSkill" })}>
          <Icon name="plus" size={12} /> New
        </button>
      </div>
      <p className="panel-hint">Skills are specialized capabilities that help the agent accomplish specific tasks. Skills will be invoked by the agent when relevant.</p>
      {skills.length === 0 ? (
        <div className="rss-empty">
          <div className="rss-empty-title">No Skills Yet</div>
          <div className="rss-empty-sub">Create skills for specialized capabilities</div>
          <button className="btn-secondary" onClick={() => vscode.postMessage({ type: "createSkill" })}>New Skill</button>
        </div>
      ) : (
        <div className="rss-list">
          {skills.map((s) => (
            <div
              className="rss-row"
              key={s.path}
              title={"Open " + s.name}
              onClick={() => vscode.postMessage({ type: "openWorkspaceFile", path: s.path })}
            >
              <div className="lr-text">
                <div className="lr-title">{s.name}</div>
                <div className="lr-desc rss-clamp">{s.description}</div>
              </div>
              <button
                className="icon-btn rss-del"
                title="Delete skill"
                onClick={(e) => { e.stopPropagation(); vscode.postMessage({ type: "deleteSkill", path: s.path, name: s.name }); }}
              >
                <Icon name="trash" size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="rss-section-head" style={{ marginTop: 28 }}>
        <span className="rss-title">Subagents <span className="rss-help" title="The agent can launch subagents for focused subtasks via the Task tool. Use a fast/cheap model for subagents.">?</span></span>
        <button className="btn-ghost sm" onClick={addSub}>
          <Icon name="plus" size={12} /> New
        </button>
      </div>
      <p className="panel-hint">Create specialized agents for complex tasks. Subagents can be invoked by the agent to handle focused work in parallel.</p>
      <div className="row stacked" style={{ borderBottom: "none", paddingTop: 4 }}>
        <div className="row-text">
          <div className="row-title">Subagent Model</div>
          <div className="row-desc">Default model for all subagents. Per-subagent overrides below take precedence; empty = inherit the chat model.</div>
        </div>
        <ModelSelect
          models={selectModels}
          value={features.subagentModel}
          onChange={(id) => setFeatures({ subagentModel: id })}
          customItems={[{ value: "", label: "Inherit chat model", desc: "use whatever the chat uses" }]}
        />
      </div>
      {features.subagents.length === 0 ? (
        <div className="rss-empty">
          <div className="rss-empty-title">No Subagents Yet</div>
          <div className="rss-empty-sub">Create specialized agents to handle focused tasks</div>
          <button className="btn-secondary" onClick={addSub}>New Subagent</button>
        </div>
      ) : (
        features.subagents.map((sub, i) => (
          <div className="feature-card" key={sub.id}>
            <div className="fc-head">
              <input className="fc-title-input" value={sub.name} onChange={(e) => updateSub(i, { name: e.target.value })} placeholder="name" />
              <label className="fc-inline">
                <input type="checkbox" checked={sub.readonly} onChange={(e) => updateSub(i, { readonly: e.target.checked })} /> read-only
              </label>
              <button className="icon-btn" onClick={() => removeSub(i)} title="Remove">
                <Icon name="trash" size={14} />
              </button>
            </div>
            <div className="fc-body">
              <label className="fc-field">
                <span>Description</span>
                <input value={sub.description} onChange={(e) => updateSub(i, { description: e.target.value })} placeholder="When to use this subagent" />
              </label>
              <label className="fc-field">
                <span>System Prompt</span>
                <textarea rows={3} value={sub.prompt} onChange={(e) => updateSub(i, { prompt: e.target.value })} placeholder="Instructions for this subagent" />
              </label>
              <label className="fc-field">
                <span>Model</span>
                <ModelSelect
                  models={selectModels}
                  value={sub.model ?? ""}
                  onChange={(id) => updateSub(i, { model: id })}
                  customItems={[{ value: "", label: "Use subagent / chat model", desc: "inherit the default" }]}
                />
              </label>
            </div>
          </div>
        ))
      )}
    </>
  );
}

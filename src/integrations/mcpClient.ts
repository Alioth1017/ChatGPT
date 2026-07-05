/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { getWorkspaceRoot } from "../context/workspaceUtils";

export interface McpServerConfig {
  name: string;
  /** "stdio" launches a command; "sse"/"http" connects to a URL. */
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  enabled: boolean;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: object;
}

interface JsonRpcResponse {
  id?: number;
  result?: any;
  error?: { code: number; message: string };
  method?: string;
  params?: any;
}

/** Minimal MCP client over stdio (JSON-RPC 2.0). SSE/http is best-effort. */
export class McpConnection {
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private buf = "";
  public tools: McpToolDef[] = [];
  public connected = false;
  public lastError?: string;

  constructor(public readonly config: McpServerConfig) {}

  async connect(timeoutMs = 15000): Promise<void> {
    if (this.config.transport !== "stdio") {
      // SSE/http transport: not spawned; mark connected without tools for now.
      this.lastError = "only stdio transport is supported";
      throw new Error(this.lastError);
    }
    if (!this.config.command) {
      throw new Error("stdio MCP server requires a command");
    }

    // On Windows, npm-shipped launchers (npx/npm/pnpm/yarn) are .cmd shims that
    // are not directly spawnable, so run through a shell. The shell also resolves
    // commands via PATHEXT instead of failing with ENOENT.
    // Node deprecated args+shell:true (DEP0190), so pre-join into one quoted string.
    const useShell = process.platform === "win32";
    const args = this.config.args ?? [];
    const cmd = useShell
      ? [this.config.command, ...args].map((a) => (/[\s"^&|<>]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(" ")
      : this.config.command;
    const proc = spawn(cmd, useShell ? [] : args, {
      cwd: getWorkspaceRoot(),
      env: { ...process.env, ...(this.config.env ?? {}) },
      shell: useShell,
    });
    this.proc = proc;

    // Keep the last stderr lines so a startup failure surfaces a real reason
    // instead of just "MCP server closed".
    let stderrTail = "";
    proc.stdout.on("data", (d) => this._onData(d.toString()));
    proc.stderr.on("data", (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-2000);
    });
    proc.on("error", (e) => {
      this.lastError = e.message;
      this.connected = false;
    });
    proc.on("close", (code) => {
      this.connected = false;
      if (code) this.lastError = `${this.config.command} exited (code ${code})${stderrTail ? `: ${stderrTail.trim().split("\n").pop()}` : ""}`;
      const reason = this.lastError || "MCP server closed";
      for (const { reject } of this.pending.values()) {
        reject(new Error(reason));
      }
      this.pending.clear();
    });

    const withTimeout = <T>(p: Promise<T>): Promise<T> =>
      Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("MCP timeout")), timeoutMs))]);

    await withTimeout(
      this._request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "ocursor", version: "1.0.0" },
      })
    );
    this._notify("notifications/initialized", {});

    const toolList = await withTimeout(this._request("tools/list", {}));
    this.tools = (toolList?.tools ?? []).map((t: any) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    this.connected = true;
  }

  async callTool(name: string, args: any): Promise<string> {
    const res = await this._request("tools/call", { name, arguments: args ?? {} });
    const content = res?.content;
    if (Array.isArray(content)) {
      return content
        .map((c: any) => (c.type === "text" ? c.text : JSON.stringify(c)))
        .join("\n");
    }
    return JSON.stringify(res ?? {});
  }

  /** List resources exposed by this server (resources/list). */
  async listResources(): Promise<{ uri: string; name?: string; description?: string; mimeType?: string }[]> {
    const res = await this._request("resources/list", {});
    return (res?.resources ?? []).map((r: any) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
    }));
  }

  /** Read a resource (resources/read); returns its text contents joined. */
  async readResource(uri: string): Promise<string> {
    const res = await this._request("resources/read", { uri });
    const contents = res?.contents;
    if (Array.isArray(contents)) {
      return contents
        .map((c: any) => (typeof c.text === "string" ? c.text : c.blob !== undefined ? `[binary ${c.mimeType ?? ""}]` : JSON.stringify(c)))
        .join("\n");
    }
    return JSON.stringify(res ?? {});
  }

  dispose() {
    this.proc?.kill();
    this.connected = false;
  }

  private _onData(chunk: string) {
    this.buf += chunk;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t) {
        continue;
      }
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(t);
      } catch {
        continue;
      }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(msg.error.message));
        } else {
          p.resolve(msg.result);
        }
      }
    }
  }

  private _request(method: string, params: any): Promise<any> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc?.stdin.write(payload);
    });
  }

  private _notify(method: string, params: any) {
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.proc?.stdin.write(payload);
  }
}

/** Manages all configured MCP connections. */
export class McpManager {
  private connections = new Map<string, McpConnection>();

  async sync(configs: McpServerConfig[]): Promise<void> {
    // Dispose connections no longer present or disabled.
    for (const [name, conn] of this.connections) {
      const cfg = configs.find((c) => c.name === name);
      if (!cfg || !cfg.enabled) {
        conn.dispose();
        this.connections.delete(name);
      }
    }
    // Connect new enabled servers.
    for (const cfg of configs) {
      if (!cfg.enabled || this.connections.has(cfg.name)) {
        continue;
      }
      const conn = new McpConnection(cfg);
      this.connections.set(cfg.name, conn);
      try {
        await conn.connect();
      } catch (e) {
        conn.lastError = e instanceof Error ? e.message : String(e);
      }
    }
  }

  /** Returns all tools across connected servers, namespaced as `mcp__<server>__<tool>`. */
  listTools(): { qualifiedName: string; server: string; tool: McpToolDef }[] {
    const out: { qualifiedName: string; server: string; tool: McpToolDef }[] = [];
    for (const [name, conn] of this.connections) {
      if (!conn.connected) {
        continue;
      }
      for (const tool of conn.tools) {
        out.push({ qualifiedName: `mcp__${name}__${tool.name}`, server: name, tool });
      }
    }
    return out;
  }

  async callTool(qualifiedName: string, args: any): Promise<string> {
    const m = qualifiedName.match(/^mcp__(.+?)__(.+)$/);
    if (!m) {
      return `error: invalid MCP tool name ${qualifiedName}`;
    }
    const conn = this.connections.get(m[1]);
    if (!conn || !conn.connected) {
      return `error: MCP server ${m[1]} not connected`;
    }
    try {
      return await conn.callTool(m[2], args);
    } catch (e) {
      return `error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /** List resources across all connected servers, namespaced by server. */
  async listResources(): Promise<{ server: string; uri: string; name?: string; description?: string; mimeType?: string }[]> {
    const out: { server: string; uri: string; name?: string; description?: string; mimeType?: string }[] = [];
    for (const [name, conn] of this.connections) {
      if (!conn.connected) continue;
      try {
        for (const r of await conn.listResources()) out.push({ server: name, ...r });
      } catch {
        /* server may not support resources */
      }
    }
    return out;
  }

  async readResource(server: string, uri: string): Promise<string> {
    const conn = this.connections.get(server);
    if (!conn || !conn.connected) return `error: MCP server ${server} not connected`;
    try {
      return await conn.readResource(uri);
    } catch (e) {
      return `error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  status(): { name: string; connected: boolean; toolCount: number; tools: string[]; error?: string }[] {
    const out: { name: string; connected: boolean; toolCount: number; tools: string[]; error?: string }[] = [];
    for (const [name, conn] of this.connections) {
      out.push({ name, connected: conn.connected, toolCount: conn.tools.length, tools: conn.tools.map((t) => t.name), error: conn.lastError });
    }
    return out;
  }

  disposeAll() {
    for (const conn of this.connections.values()) {
      conn.dispose();
    }
    this.connections.clear();
  }
}

export const mcpManager = new McpManager();

/** A server entry from the official MCP registry (registry.modelcontextprotocol.io). */
export interface RegistryServer {
  name: string;
  title?: string;
  description?: string;
  version?: string;
  packages?: {
    registryType?: string;
    identifier?: string;
    version?: string;
    runtimeHint?: string;
    transport?: { type?: string };
    runtimeArguments?: { type?: string; name?: string; value?: string }[];
    packageArguments?: { type?: string; name?: string; value?: string }[];
    environmentVariables?: { name?: string; description?: string; isRequired?: boolean; isSecret?: boolean }[];
  }[];
}

/**
 * Search the official MCP registry. Runs in the extension host (not the webview)
 * so it isn't blocked by the webview CSP. Empty query returns a default listing.
 */
export async function searchMcpRegistry(query: string, limit = 30): Promise<RegistryServer[]> {
  const url = `https://registry.modelcontextprotocol.io/v0.1/servers?limit=${limit}${query.trim() ? `&search=${encodeURIComponent(query.trim())}` : ""}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`registry ${r.status}`);
  const data = (await r.json()) as { servers?: { server: RegistryServer }[] };
  return (data.servers ?? []).map((s) => s.server);
}

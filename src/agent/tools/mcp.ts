/*
 * Copyright (c) 2026 Pawan Osman <https://github.com/PawanOsman>
 *
 * This file is part of OpenCursor — AI coding agent chat inside VS Code.
 * https://github.com/PawanOsman/OpenCursor
 *
 * Licensed under the MIT License. See LICENSE file in the project root.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { safePath } from "../../context/workspaceUtils";
import { mcpManager } from "../../integrations/mcpClient";
import { defineTool } from "./types";

// ---- CallMcpTool ----
export const callMcpToolTool = defineTool("CallMcpTool", true, async (input) => {
  const server = String(input?.server ?? "").trim();
  const toolName = String(input?.toolName ?? "").trim();
  if (!server || !toolName) return { output: "error: CallMcpTool requires 'server' and 'toolName'" };
  const out = await mcpManager.callTool(`mcp__${server}__${toolName}`, input?.arguments ?? {});
  return { output: out };
});

// ---- FetchMcpResource ----
export const fetchMcpResourceTool = defineTool("FetchMcpResource", true, async (input) => {
  const server = String(input?.server ?? "").trim();
  const uri = String(input?.uri ?? "").trim();
  if (!server || !uri) return { output: "error: FetchMcpResource requires 'server' and 'uri'" };

  const content = await mcpManager.readResource(server, uri);
  if (content.startsWith("error:")) return { output: content };

  const downloadPath = input?.downloadPath ? String(input.downloadPath) : "";
  if (downloadPath) {
    const dest = safePath(downloadPath);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, content, "utf8");
    return { output: `Saved resource ${uri} to ${downloadPath}` };
  }
  return { output: content };
});

// ---- ListMcpResources ----
export const listMcpResourcesTool = defineTool("ListMcpResources", false, async (input) => {
  const filter = input?.server ? String(input.server) : "";
  const resources = (await mcpManager.listResources()).filter((r) => !filter || r.server === filter);
  if (resources.length === 0) return { output: "No MCP resources available." };
  const lines = resources.map(
    (r) => `${r.server}\t${r.uri}${r.name ? `\t${r.name}` : ""}${r.mimeType ? `\t(${r.mimeType})` : ""}`
  );
  return { output: lines.join("\n") };
});

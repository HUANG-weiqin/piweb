#!/usr/bin/env node
// Pi Web 的 MCP 转接程序：Claude Code 通过 stdio 启动它，它再以浏览器同等身份连接本机 Pi Web。
// stdout 专用于 MCP 协议帧，日志只能写 stderr。
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PiWebBridge } from "./piweb-bridge.js";
import { resolvePiWebUrl } from "./piweb-session.js";
import { piWebInstructions, registerPiWebTools } from "./tools.js";

const bridge = new PiWebBridge({
  baseUrl: resolvePiWebUrl(process.env.PIWEB_URL),
  defaultCwd: process.env.PIWEB_CWD?.trim() || process.cwd(),
  // 本文件位于 <repo>/dist-server/mcp/，启动服务用的就是同一仓库。
  repoRoot: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
});
const server = new McpServer(
  { name: "piweb", version: "0.1.0" },
  { instructions: piWebInstructions(bridge.defaultCwd) },
);
registerPiWebTools(server, bridge);
await server.connect(new StdioServerTransport());
console.error(`piweb-mcp ready (default cwd: ${bridge.defaultCwd})`);

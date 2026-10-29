#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { LocalCore, type Core } from "./core.js";
import { registerTools } from "./mcp-tools.js";
import { RemoteCore } from "./remote.js";
import { PORT, startServer } from "./server.js";

const local = new LocalCore();
let core: Core = local;
let studio: string | undefined;

const mcpFactory = () => {
  const mcp = new McpServer({ name: "vids-mcp", version: "0.1.0" });
  registerTools(mcp, core, studio);
  return mcp;
};

const role = await startServer(local, mcpFactory);
core = role === "client" ? new RemoteCore() : local;
studio = role === "none" ? undefined : `http://127.0.0.1:${PORT}`;

// Connect STDIO transport if not explicitly running in server-only daemon mode
if (process.env.VIDS_MCP_SERVER_ONLY !== "1") {
  const stdioServer = mcpFactory();
  await stdioServer.connect(new StdioServerTransport());
}

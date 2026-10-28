// Quick check that uses no Vids quota: lists the tools and calls the read-only ones.
// node scripts/smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: process.env }));
const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 })).content[0].text);

const { tools } = await client.listTools();
console.log("TOOLS", tools.length, tools.map((t) => t.name).join(" "));
console.log("TECHNIQUES", (await call("vids_techniques")).length);
console.log("CHARACTERS", JSON.stringify(await call("vids_characters")));
const status = await call("vids_status");
console.log("STATUS", JSON.stringify({ vids: status.vids, avatars: status.avatars?.length, jobs: status.jobs?.length, studio: status.studio }));
await client.close();
process.exit(0);

// Calls one vids_* tool and waits for its jobs: node scripts/one.mjs <tool> '<args json>'
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [tool, argsJson] = process.argv.slice(2);
const client = new Client({ name: "one", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: process.env }));
const call = async (name, args = {}) => JSON.parse((await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 })).content[0].text);
let out = await call(tool, JSON.parse(argsJson ?? "{}"));
console.log("REPLY", JSON.stringify(out).slice(0, 600));
const ids = out.jobs?.map((j) => j.id) ?? (out.task_id ? [out.task_id] : []);
while (ids.length) {
  out = await call("vids_wait", { job_ids: ids, timeout_seconds: 40 });
  console.log(new Date().toISOString().slice(11, 19), JSON.stringify(out.jobs?.map((j) => `${j.status} ${j.progress ?? ""}`) ?? out.tasks?.map((t) => t.status)));
  if (out.finished) { console.log("RESULT", JSON.stringify(out, null, 1)); break; }
}
await client.close();
process.exit(0);

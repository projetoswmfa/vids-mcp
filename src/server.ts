import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CACHE_DIR as CAPTIONS_DIR } from "./captions.js";
import { HOME_DIR } from "./chrome.js";
import { OUTPUT_ROOT, shapes, type Core } from "./core.js";
import { getOpenApiSpec } from "./openapi.js";

export const PORT = Number(process.env.VIDS_MCP_PORT ?? 8788);
export const TOKEN_FILE = join(HOME_DIR, "token");
const UPLOAD_DIR = join(HOME_DIR, "uploads");
const STUDIO_HTML = fileURLToPath(new URL("../studio/index.html", import.meta.url));
const MAX_UPLOAD = 200 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".gif": "image/gif",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4",
};

const json = (res: ServerResponse, code: number, data: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
};

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        fail(new Error("Body too large."));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

const inside = (file: string, dir: string) => resolve(file).startsWith(resolve(dir) + sep);

// The remote MCP endpoint lives at /mcp/<VIDS_MCP_PATH_SECRET>. claude.ai custom connectors cannot send a
// Bearer token, so the unguessable path is the credential. Without a secret (or with a short one) the remote
// MCP stays off and only local clients can use /sse.
const SECRET_FILE = join(HOME_DIR, "path-secret");
let loadedSecret = (process.env.VIDS_MCP_PATH_SECRET ?? "").trim();
if (!loadedSecret && existsSync(SECRET_FILE)) {
  try {
    loadedSecret = readFileSync(SECRET_FILE, "utf8").trim();
  } catch {}
}
if (!loadedSecret) {
  loadedSecret = randomBytes(24).toString("base64url");
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    writeFileSync(SECRET_FILE, loadedSecret, { mode: 0o600 });
  } catch {}
}
const PATH_SECRET = loadedSecret;
const MIN_SECRET = 32;
const REMOTE_MCP = /^[A-Za-z0-9_-]+$/.test(PATH_SECRET) && PATH_SECRET.length >= MIN_SECRET;

function secretMatches(given: string): boolean {
  if (!REMOTE_MCP) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(PATH_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

// A request is local when it reached the loopback listener directly, not through a reverse proxy or tunnel.
function isLocal(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  const loopbackHost = host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`;
  const proxied = Boolean(req.headers["x-forwarded-for"] || req.headers["x-forwarded-host"] || req.headers["cf-connecting-ip"] || req.headers["x-real-ip"]);
  return loopbackHost && !proxied;
}

// OAuth discovery and registration paths claude.ai probes. Answering 404 (not 401) tells it the server has no
// OAuth, so it connects without a login step instead of failing on dynamic client registration.
const OAUTH_PROBE = /^\/(\.well-known\/.*|register|authorize|token|oauth\/.*)$/;

function sendMedia(req: IncomingMessage, res: ServerResponse, file: string) {
  if (!(inside(file, OUTPUT_ROOT) || inside(file, UPLOAD_DIR) || inside(file, CAPTIONS_DIR)) || !existsSync(file)) return json(res, 404, { error: "Not found." });
  const { size } = statSync(file);
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size });
  createReadStream(file).pipe(res);
}

export type ServerRole = "owner" | "client" | "none";

// Serves the Studio panel, a JSON API on localhost and remote SSE for Claude and ChatGPT.
export async function startServer(core: Core, mcpFactory?: () => McpServer): Promise<ServerRole> {
  mkdirSync(UPLOAD_DIR, { recursive: true });
  mkdirSync(HOME_DIR, { recursive: true });

  let token = process.env.VIDS_MCP_TOKEN ?? process.env.VIDS_MCP_API_KEY;
  if (!token && existsSync(TOKEN_FILE)) {
    try {
      token = readFileSync(TOKEN_FILE, "utf8").trim();
    } catch {}
  }
  if (!token) {
    token = randomBytes(24).toString("hex");
    try {
      writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
    } catch {}
  }

  const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, "vids-mcp.welldevs.com.br"]);

  if (process.env.VIDS_MCP_ALLOWED_HOSTS) {
    for (const h of process.env.VIDS_MCP_ALLOWED_HOSTS.split(",")) {
      const clean = h.trim();
      if (clean) {
        allowedHosts.add(clean);
        allowedHosts.add(`${clean}:${PORT}`);
      }
    }
  }

  const sseTransports = new Map<string, SSEServerTransport>();
  const httpTransports = new Map<string, StreamableHTTPServerTransport>();

  if (process.env.VIDS_MCP_PATH_SECRET && !REMOTE_MCP) {
    console.error(`vids-mcp: VIDS_MCP_PATH_SECRET ignored, it needs ${MIN_SECRET}+ characters of A-Z, a-z, 0-9, _ or -. Remote MCP is off.`);
  } else if (!REMOTE_MCP) {
    console.error("vids-mcp: remote MCP is off. Set VIDS_MCP_PATH_SECRET to serve it at /mcp/<secret>.");
  }

  // Legacy SSE (GET opens the stream, POST to `messagesPath` carries the messages).
  const openSse = async (res: ServerResponse, messagesPath: string) => {
    const transport = new SSEServerTransport(messagesPath, res);
    sseTransports.set(transport.sessionId, transport);
    transport.onclose = () => {
      sseTransports.delete(transport.sessionId);
    };
    if (mcpFactory) await mcpFactory().connect(transport);
  };
  const postSse = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const sessionId = url.searchParams.get("sessionId");
    const transport = sessionId ? sseTransports.get(sessionId) : undefined;
    if (!transport) return json(res, 404, { error: "Session not found." });
    await transport.handlePostMessage(req, res);
  };

  // Streamable HTTP, the transport claude.ai tries first.
  const handleStreamable = async (req: IncomingMessage, res: ServerResponse) => {
    if (!mcpFactory) return json(res, 503, { error: "MCP is not available on this server." });
    const sid = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sid) ? sid[0] : sid;
    let transport = sessionId ? httpTransports.get(sessionId) : undefined;
    if (!transport) {
      if (sessionId || req.method !== "POST") {
        return json(res, 404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found." }, id: null });
      }
      const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          httpTransports.set(id, created);
        },
      });
      created.onclose = () => {
        if (created.sessionId) httpTransports.delete(created.sessionId);
      };
      await mcpFactory().connect(created);
      transport = created;
    }
    await transport.handleRequest(req, res);
  };

  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? "";
      const hostWithoutPort = host.split(":")[0];
      const isAllowedHost =
        allowedHosts.has(host) ||
        allowedHosts.has(hostWithoutPort) ||
        process.env.VIDS_MCP_ALLOW_ANY_HOST === "1" ||
        host.endsWith(".welldevs.com.br") ||
        host.endsWith(".wmfadev.lat");

      if (!isAllowedHost) return json(res, 403, { error: "Bad host." });

      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS, HEAD");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-flow-token, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
      if (req.method === "OPTIONS") {
        res.writeHead(204).end();
        return;
      }

      const proto = req.headers["x-forwarded-proto"] ?? "https";
      const origin = `${proto}://${req.headers.host}`;
      const url = new URL(req.url ?? "/", origin);

      // Health check (supports GET and HEAD)
      if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/api/health") {
        return json(res, 200, { name: "vids-mcp", status: "ok" });
      }
      if (url.pathname === "/favicon.ico") return void res.writeHead(204).end();

      // OpenAPI 3.1 Specification for ChatGPT Actions
      if (req.method === "GET" && url.pathname === "/openapi.json") {
        return json(res, 200, getOpenApiSpec(origin));
      }

      if (OAUTH_PROBE.test(url.pathname)) return json(res, 404, { error: "Not found." });

      const local = isLocal(req);

      // Remote MCP at /mcp/<secret>: Streamable HTTP on the base path, legacy SSE under /sse and /messages.
      const remote = url.pathname.match(/^\/mcp\/([^/]+)(\/sse|\/messages)?$/);
      if (remote) {
        if (!secretMatches(remote[1])) return json(res, 404, { error: "Not found." });
        const base = `/mcp/${PATH_SECRET}`;
        if (!remote[2]) return void (await handleStreamable(req, res));
        if (remote[2] === "/sse" && req.method === "GET") return void (await openSse(res, `${base}/messages`));
        if (remote[2] === "/messages" && req.method === "POST") return void (await postSse(req, res, url));
        return json(res, 405, { error: "Method not allowed." });
      }

      // Unprefixed MCP endpoints only for clients on this machine.
      if (url.pathname === "/sse" || url.pathname === "/messages") {
        if (!local) return json(res, 404, { error: "Not found." });
        if (url.pathname === "/sse" && req.method === "GET") return void (await openSse(res, "/messages"));
        if (url.pathname === "/messages" && req.method === "POST") return void (await postSse(req, res, url));
        return json(res, 405, { error: "Method not allowed." });
      }

      // The Studio page embeds the API token, so it is served on the loopback listener only.
      if (req.method === "GET" && url.pathname === "/") {
        if (!local) return json(res, 404, { error: "Not found." });
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(readFileSync(STUDIO_HTML, "utf8").replace("__FLOW_TOKEN__", token!));
      }

      const bearer = req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7).trim()
        : undefined;
      const given = req.headers["x-flow-token"] ?? url.searchParams.get("token") ?? bearer;

      if (process.env.VIDS_MCP_NO_AUTH !== "1" && given !== token) {
        return json(res, 401, { error: "Missing or wrong token." });
      }

      if (req.method === "GET" && url.pathname === "/media") return sendMedia(req, res, url.searchParams.get("path") ?? "");

      if (req.method === "POST" && url.pathname === "/api/upload") {
        const name = basename(url.searchParams.get("name") ?? "upload").replace(/[^\w.-]+/g, "_");
        const path = join(UPLOAD_DIR, `${randomBytes(4).toString("hex")}-${name}`);
        writeFileSync(path, await readBody(req, MAX_UPLOAD));
        return json(res, 200, { path });
      }

      const method = url.pathname.match(/^\/api\/(\w+)$/)?.[1] as keyof Core | undefined;
      if (req.method === "POST" && method && typeof core[method] === "function") {
        const raw = (await readBody(req, 1024 * 1024)).toString() || "{}";
        const shape = (shapes as Record<string, z.ZodRawShape>)[method];
        const args = shape ? z.object(shape).parse(JSON.parse(raw)) : undefined;
        return json(res, 200, await (core[method] as (a: unknown) => Promise<unknown>)(args));
      }
      json(res, 404, { error: "Not found." });
    } catch (err) {
      const message = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : err instanceof Error ? err.message : String(err);
      json(res, 400, { error: message });
    }
  });

  const listening = await new Promise<boolean>((ok) => {
    server.once("error", () => ok(false));
    server.listen(PORT, "127.0.0.1", () => ok(true));
  });
  if (listening) {
    try {
      writeFileSync(TOKEN_FILE, token!, { mode: 0o600 });
    } catch {}
    return "owner";
  }

  for (let attempt = 0; attempt < 8; attempt++) {
    const other = (await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(3000) }).then(
      (r) => r.json(),
      () => null,
    )) as { name?: string } | null;
    if (other?.name === "vids-mcp") return "client";
    if (other) return "none";
    await new Promise((r) => setTimeout(r, 1500));
  }
  return "client";
}

import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { isAllowedOrigin } from "./origin";
import { RunnerClient } from "./runnerClient";
import type { BrowserClientMessage } from "./runnerProtocol";

export const DEFAULT_PORT = 4177;

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const isProduction = process.argv.includes("--production") || process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? DEFAULT_PORT);
const host = process.env.HOST ?? "127.0.0.1";

let vite: ViteDevServer | null = null;
let nextClientId = 1;
const clientIdPrefix = `web-${process.pid}-${Math.random().toString(36).slice(2)}`;
const runnerClient = new RunnerClient();

const server = createServer(async (req, res) => {
  if (!req.url || req.url.startsWith("/rpc")) {
    res.writeHead(404);
    res.end();
    return;
  }

  if (vite) {
    vite.middlewares(req, res, () => undefined);
    return;
  }

  await serveStatic(req.url, res);
});

if (!isProduction) {
  vite = await createViteServer({
    root,
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa"
  });
}

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
  if (pathname !== "/rpc") {
    if (!vite) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    }
    return;
  }

  if (!isAllowedOrigin(req.headers.origin, host, port)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (upgradedSocket) => {
    wss.emit("connection", upgradedSocket, req);
  });
});

wss.on("connection", (socket) => {
  const clientId = `${clientIdPrefix}-${nextClientId++}`;
  runnerClient.attachBrowserSocket(clientId, socket);

  socket.on("message", (raw) => {
    const parsed = parseClientMessage(raw.toString(), socket);
    if (!parsed) {
      return;
    }

    runnerClient.sendBrowserMessage(clientId, parsed);
  });

  socket.on("close", () => runnerClient.detachBrowserSocket(clientId));
});

server.listen(port, host, () => {
  console.log(`Pi agent web listening on http://${host}:${port}`);
});

function parseClientMessage(raw: string, socket: WebSocket): BrowserClientMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    socket.send(JSON.stringify({ source: "bridge", type: "error", message: `Invalid client message: ${String(error)}` }));
    return null;
  }

  if (!isClientMessage(value)) {
    socket.send(JSON.stringify({ source: "bridge", type: "error", message: "Invalid client message shape." }));
    return null;
  }

  return value;
}

function isClientMessage(value: unknown): value is BrowserClientMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "disconnect") {
    return true;
  }

  if (value.type === "command") {
    return typeof value.command === "string" && (value.payload === undefined || isRecord(value.payload));
  }

  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function serveStatic(url: string, res: ServerResponse) {
  const pathname = new URL(url, "http://localhost").pathname;
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = join(root, "dist/client", requestedPath);

  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "content-type": contentType(filePath) });
    res.end(data);
  } catch {
    const data = await readFile(join(root, "dist/client/index.html"));
    res.writeHead(200, { "content-type": "text/html" });
    res.end(data);
  }
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case ".js":
      return "text/javascript";
    case ".css":
      return "text/css";
    case ".html":
      return "text/html";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

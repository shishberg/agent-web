import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { isAllowedOrigin } from "./origin";
import { createPiRpcCommand, PiProcess, type PiProcessEvent, type PiSessionConfig } from "./piProcess";

export const DEFAULT_PORT = 4177;

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const isProduction = process.argv.includes("--production") || process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? DEFAULT_PORT);
const host = process.env.HOST ?? "127.0.0.1";

const vite = isProduction
  ? null
  : await createViteServer({
      root,
      server: { middlewareMode: true },
      appType: "spa"
    });

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

const wss = new WebSocketServer({
  server,
  path: "/rpc",
  verifyClient: ({ origin }: { origin?: string; req: IncomingMessage }) => isAllowedOrigin(origin, host, port)
});
wss.on("connection", (socket) => {
  const pi = new PiProcess();

  const send = (message: unknown) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  };

  pi.on("pi-event", (event: PiProcessEvent) => send({ source: "pi", ...event }));

  socket.on("message", (raw) => {
    const parsed = parseClientMessage(raw.toString(), socket);
    if (!parsed) {
      return;
    }

    if (parsed.type === "connect") {
      pi.start(parsed.config ?? {});
      return;
    }

    if (parsed.type === "disconnect") {
      pi.stop();
      return;
    }

    if (parsed.type === "command") {
      pi.send(createPiRpcCommand(parsed.command, parsed.payload));
    }
  });

  socket.on("close", () => pi.stop());
  send({ source: "bridge", type: "ready" });
});

server.listen(port, host, () => {
  console.log(`Pi agent web listening on http://${host}:${port}`);
});

type ClientMessage =
  | { type: "connect"; config?: PiSessionConfig }
  | { type: "disconnect" }
  | { type: "command"; command: string; payload?: Record<string, unknown> };

function parseClientMessage(raw: string, socket: WebSocket): ClientMessage | null {
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

function isClientMessage(value: unknown): value is ClientMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "connect") {
    return value.config === undefined || isPiSessionConfig(value.config);
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

function isPiSessionConfig(value: unknown): value is PiSessionConfig {
  if (!isRecord(value)) {
    return false;
  }

  return (
    optionalString(value.provider) &&
    optionalString(value.model) &&
    optionalBoolean(value.noSession) &&
    optionalString(value.sessionDir) &&
    optionalString(value.extraArgs)
  );
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
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

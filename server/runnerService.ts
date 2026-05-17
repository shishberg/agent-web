import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { PiRunnerCoreOptions } from "./runnerCore";
import { RunnerHub } from "./runnerHub";
import {
  isRunnerInputEnvelope,
  RUNNER_PROTOCOL_VERSION,
  type RunnerOutputEnvelope
} from "./runnerProtocol";

export const DEFAULT_RUNNER_PORT = 4178;

export type RunnerServiceOptions = {
  cwd: string;
  host?: string;
  port?: number;
  sessionDir?: string;
} & Pick<PiRunnerCoreOptions, "createPiProcess" | "listSessions" | "openSession">;

export function createRunnerService(options: RunnerServiceOptions) {
  const host = options.host ?? process.env.RUNNER_HOST ?? "127.0.0.1";
  let port = options.port ?? Number(process.env.RUNNER_PORT ?? DEFAULT_RUNNER_PORT);
  const clients = new Set<WebSocket>();
  const hub = new RunnerHub({
    cwd: options.cwd,
    sessionDir: options.sessionDir,
    createPiProcess: options.createPiProcess,
    listSessions: options.listSessions,
    openSession: options.openSession,
    send: (message) => sendToWebClients(message)
  });

  const server = createServer((req, res) => {
    if (healthPath(req)) {
      writeJson(res, 200, {
        ok: true,
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        clients: clients.size
      });
      return;
    }

    writeJson(res, 404, { ok: false, error: "not_found" });
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
    if (pathname !== "/runner") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (socket) => {
    const clientIds = new Set<string>();
    clients.add(socket);
    sendJson(socket, { type: "hello", protocolVersion: RUNNER_PROTOCOL_VERSION });

    socket.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch (error) {
        sendJson(socket, { type: "error", message: `Invalid runner message: ${String(error)}` });
        return;
      }

      if (!isRunnerInputEnvelope(parsed)) {
        sendJson(socket, { type: "error", message: "Invalid runner message shape." });
        return;
      }

      if (parsed.type === "hello" && parsed.protocolVersion !== RUNNER_PROTOCOL_VERSION) {
        sendJson(socket, {
          type: "error",
          message: `Runner protocol mismatch: expected ${RUNNER_PROTOCOL_VERSION}.`
        });
        socket.close();
        return;
      }

      if (parsed.type === "client_command") {
        clientIds.add(parsed.clientId);
      }

      if (parsed.type === "client_disconnected") {
        clientIds.delete(parsed.clientId);
      }

      void hub.handleEnvelope(parsed);
    });

    socket.on("close", () => {
      clients.delete(socket);
      for (const clientId of clientIds) {
        void hub.handleEnvelope({ type: "client_disconnected", clientId });
      }
      clientIds.clear();
    });
  });

  function sendToWebClients(message: RunnerOutputEnvelope): void {
    for (const client of clients) {
      sendJson(client, message);
    }
  }

  return {
    host,
    get port() {
      return port;
    },
    listen: () =>
      new Promise<void>((resolve) => {
        server.listen(port, host, () => {
          port = (server.address() as AddressInfo).port;
          console.log(
            JSON.stringify({
              service: "runner",
              event: "listening",
              url: `ws://${host}:${port}/runner`,
              health: `http://${host}:${port}/health`,
              protocolVersion: RUNNER_PROTOCOL_VERSION
            })
          );
          resolve();
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        hub.dispose();
        wss.close(() => server.close(() => resolve()));
      })
  };
}

function healthPath(req: IncomingMessage): boolean {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname === "/health";
}

function sendJson(socket: WebSocket, message: unknown): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

const isCliEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCliEntry) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const service = createRunnerService({
    cwd: root,
    sessionDir: process.env.PI_CODING_AGENT_SESSION_DIR
  });
  await service.listen();
}

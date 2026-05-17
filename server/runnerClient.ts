import { WebSocket } from "ws";
import {
  isRunnerOutputEnvelope,
  RUNNER_PROTOCOL_VERSION,
  type BrowserClientMessage,
  type RunnerInputEnvelope,
  type RunnerOutputEnvelope
} from "./runnerProtocol";

export type RunnerClientOptions = {
  url?: string;
  createWebSocket?: (url: string) => RunnerSocket;
};

type BrowserSocket = Pick<WebSocket, "readyState" | "send" | "OPEN">;
type RunnerSocket = {
  readonly OPEN: number;
  readyState: number;
  send(raw: string): void;
  close(): void;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (raw: { toString(): string }) => void): unknown;
  on(event: "error", listener: () => void): unknown;
  on(event: "close", listener: () => void): unknown;
};

export class RunnerClient {
  private readonly url: string;
  private readonly createWebSocket: (url: string) => RunnerSocket;
  private readonly browserSockets = new Map<string, BrowserSocket>();
  private runnerSocket: RunnerSocket | null = null;
  private readonly pendingMessages: RunnerInputEnvelope[] = [];
  private usable = false;
  private connecting = false;
  private disposed = false;
  private suppressNextCloseUnavailable = false;

  constructor(options: RunnerClientOptions = {}) {
    this.url = options.url ?? process.env.RUNNER_URL ?? runnerUrlFromEnv();
    this.createWebSocket = options.createWebSocket ?? ((url) => new WebSocket(url));
  }

  attachBrowserSocket(clientId: string, socket: BrowserSocket): void {
    this.browserSockets.set(clientId, socket);
    if (this.usable) {
      this.sendToBrowser(clientId, { source: "bridge", type: "ready" });
      return;
    }

    this.connect();
  }

  detachBrowserSocket(clientId: string): void {
    this.browserSockets.delete(clientId);
    this.removePendingMessagesForClient(clientId);
    this.sendToRunner({ type: "client_disconnected", clientId });
  }

  sendBrowserMessage(clientId: string, message: BrowserClientMessage): void {
    if (message.type === "disconnect") {
      this.detachBrowserSocket(clientId);
      return;
    }

    const envelope: RunnerInputEnvelope = {
      type: "client_command",
      clientId,
      command: message.command,
      payload: message.payload
    };

    if (!this.usable) {
      if (this.connecting) {
        this.pendingMessages.push(envelope);
        return;
      }

      this.pendingMessages.push(envelope);
      this.sendUnavailable(clientId);
      this.connect();
      return;
    }

    this.sendToRunner(envelope);
  }

  dispose(): void {
    this.disposed = true;
    this.runnerSocket?.close();
    this.runnerSocket = null;
    this.pendingMessages.length = 0;
    this.browserSockets.clear();
  }

  private connect(): void {
    if (this.disposed || this.connecting || this.usable) {
      return;
    }

    this.connecting = true;
    const socket = this.createWebSocket(this.url);
    this.runnerSocket = socket;

    socket.on("open", () => {
      if (this.runnerSocket !== socket) {
        return;
      }
      this.sendToRunner({ type: "hello", protocolVersion: RUNNER_PROTOCOL_VERSION });
    });

    socket.on("message", (raw) => {
      if (this.runnerSocket !== socket) {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!isRunnerOutputEnvelope(parsed)) {
        return;
      }

      this.handleRunnerEnvelope(parsed);
    });

    socket.on("error", () => {
      if (this.runnerSocket !== socket) {
        return;
      }
      this.connecting = false;
      this.usable = false;
      this.pendingMessages.length = 0;
      this.sendUnavailableToAll();
    });

    socket.on("close", () => {
      if (this.runnerSocket !== socket) {
        return;
      }
      const suppressUnavailable = this.suppressNextCloseUnavailable;
      this.suppressNextCloseUnavailable = false;
      this.connecting = false;
      this.usable = false;
      this.runnerSocket = null;
      this.pendingMessages.length = 0;
      if (!this.disposed && !suppressUnavailable) {
        this.sendUnavailableToAll();
      }
    });
  }

  private handleRunnerEnvelope(envelope: RunnerOutputEnvelope): void {
    if (envelope.type === "hello") {
      this.connecting = false;
      if (envelope.protocolVersion !== RUNNER_PROTOCOL_VERSION) {
        this.usable = false;
        this.sendProtocolMismatchToAll();
        this.suppressNextCloseUnavailable = true;
        this.runnerSocket?.close();
        return;
      }

      this.usable = true;
      for (const clientId of this.browserSockets.keys()) {
        this.sendToBrowser(clientId, { source: "bridge", type: "ready" });
      }
      this.flushPendingMessages();
      return;
    }

    if (envelope.type === "client_event") {
      this.sendToBrowser(envelope.clientId, envelope.message);
      return;
    }

    if (envelope.type === "broadcast") {
      for (const clientId of envelope.clientIds) {
        this.sendToBrowser(clientId, envelope.message);
      }
      return;
    }

    if (envelope.type === "error") {
      if (envelope.clientId) {
        this.sendToBrowser(envelope.clientId, { source: "bridge", type: "error", message: envelope.message });
      } else {
        this.sendBridgeErrorToAll(envelope.message);
      }
    }
  }

  private sendToRunner(message: RunnerInputEnvelope): void {
    const socket = this.runnerSocket;
    if (socket && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  private flushPendingMessages(): void {
    const pending = this.pendingMessages.splice(0);
    for (const message of pending) {
      this.sendToRunner(message);
    }
  }

  private removePendingMessagesForClient(clientId: string): void {
    for (let index = this.pendingMessages.length - 1; index >= 0; index -= 1) {
      const message = this.pendingMessages[index];
      if ("clientId" in message && message.clientId === clientId) {
        this.pendingMessages.splice(index, 1);
      }
    }
  }

  private sendUnavailableToAll(): void {
    for (const clientId of this.browserSockets.keys()) {
      this.sendUnavailable(clientId);
    }
  }

  private sendUnavailable(clientId: string): void {
    this.sendToBrowser(clientId, {
      source: "bridge",
      type: "error",
      message: "Runner service is unavailable."
    });
  }

  private sendProtocolMismatchToAll(): void {
    this.sendBridgeErrorToAll(`Runner protocol mismatch: expected ${RUNNER_PROTOCOL_VERSION}.`);
  }

  private sendBridgeErrorToAll(message: string): void {
    for (const clientId of this.browserSockets.keys()) {
      this.sendToBrowser(clientId, { source: "bridge", type: "error", message });
    }
  }

  private sendToBrowser(clientId: string, message: unknown): void {
    const socket = this.browserSockets.get(clientId);
    if (socket && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }
}

function runnerUrlFromEnv(): string {
  const host = process.env.RUNNER_HOST ?? "127.0.0.1";
  const port = process.env.RUNNER_PORT ?? "4178";
  return `ws://${host}:${port}/runner`;
}

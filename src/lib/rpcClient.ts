import type { PiEvent, PiResponse } from "./sessionState";

export type BridgeStatus = "idle" | "connecting" | "connected" | "starting" | "running" | "exited" | "error";

export type PiSessionSummary = {
  id: string;
  path: string;
  cwd?: string;
  title: string;
  status?: string;
  created?: string;
  modified?: string;
  messageCount?: number;
  firstMessage?: string;
};

type PiBridgeEnvelope = {
  sessionPath?: string;
};

export type BridgeMessage =
  | { source: "bridge"; type: "ready" | "error"; message?: string }
  | { source: "bridge"; type: "sessions"; sessions: PiSessionSummary[] }
  | { source: "bridge"; type: "session_cancelled"; command: string; message: string }
  | ({ source: "pi"; type: "status"; status: "starting" | "running" | "exited"; code?: number | null; signal?: string | null } & PiBridgeEnvelope)
  | ({ source: "pi"; type: "event"; event: PiEvent } & PiBridgeEnvelope)
  | ({ source: "pi"; type: "response"; response: PiResponse } & PiBridgeEnvelope)
  | ({ source: "pi"; type: "stderr"; data: string } & PiBridgeEnvelope)
  | ({ source: "pi"; type: "spawn_error" | "framing_error" | "write_error"; message: string } & PiBridgeEnvelope);

export type RpcClientHandlers = {
  onMessage: (message: BridgeMessage) => void;
  onOpen: () => void;
  onClose: () => void;
  onError: (message: string) => void;
};

export class RpcClient {
  private socket: WebSocket | null = null;
  private readonly pending: Record<string, unknown>[] = [];

  constructor(private readonly handlers: RpcClientHandlers) {}

  connect(): void {
    if (this.socket?.readyState === WebSocket.CONNECTING || this.socket?.readyState === WebSocket.OPEN) {
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    this.socket = new WebSocket(`${protocol}://${window.location.host}/rpc`);

    this.socket.addEventListener("open", () => {
      this.handlers.onOpen();
      this.flushPending();
    });
    this.socket.addEventListener("message", (event) => {
      this.handlers.onMessage(JSON.parse(event.data) as BridgeMessage);
    });
    this.socket.addEventListener("close", () => this.handlers.onClose());
    this.socket.addEventListener("error", () => this.handlers.onError("WebSocket connection failed."));
  }

  disconnect(): void {
    if (this.socket) {
      this.pending.length = 0;
      if (this.socket.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: "disconnect" }));
      }
      this.socket.close();
      this.socket = null;
    }
  }

  command(command: string, payload: Record<string, unknown> = {}): void {
    this.connect();
    this.sendRaw({ type: "command", command, payload });
  }

  private sendRaw(message: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
      return;
    }

    this.pending.push(message);
  }

  private flushPending(): void {
    const queued = this.pending.splice(0);
    for (const message of queued) {
      this.sendRaw(message);
    }
  }
}

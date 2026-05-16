import type { PiEvent, PiResponse } from "./sessionState";

export type BridgeStatus = "idle" | "connecting" | "connected" | "starting" | "running" | "exited" | "error";

export type PiConnectionConfig = {
  provider: string;
  model: string;
  noSession: boolean;
  sessionDir: string;
  extraArgs: string;
};

export type BridgeMessage =
  | { source: "bridge"; type: "ready" | "error"; message?: string }
  | { source: "pi"; type: "status"; status: "starting" | "running" | "exited"; code?: number | null; signal?: string | null }
  | { source: "pi"; type: "event"; event: PiEvent }
  | { source: "pi"; type: "response"; response: PiResponse }
  | { source: "pi"; type: "stderr"; data: string }
  | { source: "pi"; type: "spawn_error" | "framing_error" | "write_error"; message: string };

export type RpcClientHandlers = {
  onMessage: (message: BridgeMessage) => void;
  onOpen: () => void;
  onClose: () => void;
  onError: (message: string) => void;
};

export class RpcClient {
  private socket: WebSocket | null = null;

  constructor(private readonly handlers: RpcClientHandlers) {}

  connect(config: PiConnectionConfig): void {
    this.disconnect();
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    this.socket = new WebSocket(`${protocol}://${window.location.host}/rpc`);

    this.socket.addEventListener("open", () => {
      this.handlers.onOpen();
      this.sendRaw({ type: "connect", config });
    });
    this.socket.addEventListener("message", (event) => {
      this.handlers.onMessage(JSON.parse(event.data) as BridgeMessage);
    });
    this.socket.addEventListener("close", () => this.handlers.onClose());
    this.socket.addEventListener("error", () => this.handlers.onError("WebSocket connection failed."));
  }

  disconnect(): void {
    if (this.socket) {
      this.sendRaw({ type: "disconnect" });
      this.socket.close();
      this.socket = null;
    }
  }

  command(command: string, payload: Record<string, unknown> = {}): void {
    this.sendRaw({ type: "command", command, payload });
  }

  private sendRaw(message: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}

import { createPiRpcCommand, PiProcess, type PiProcessEvent, type PiSessionConfig } from "./piProcess";
import { listPiSessions, type PiSessionSummary } from "./piSessions";

export type ClientMessage = { type: "command"; command: string; payload?: Record<string, unknown> } | { type: "disconnect" };

export type PiProcessLike = {
  on(event: "pi-event", listener: (event: PiProcessEvent) => void): unknown;
  start(config: PiSessionConfig): void;
  send(value: Record<string, unknown>): void;
  stop(): void;
};

export type PiSessionBridgeOptions = {
  cwd: string;
  sessionDir?: string;
  createPiProcess?: () => PiProcessLike;
  listSessions?: (cwd: string, sessionDir?: string) => Promise<PiSessionSummary[]>;
  send: (message: unknown) => void;
};

export class PiSessionBridge {
  private readonly createPiProcess: () => PiProcessLike;
  private readonly listSessions: (cwd: string, sessionDir?: string) => Promise<PiSessionSummary[]>;
  private pi: PiProcessLike | null = null;
  private sessionVersion = 0;

  constructor(private readonly options: PiSessionBridgeOptions) {
    this.createPiProcess = options.createPiProcess ?? (() => new PiProcess());
    this.listSessions = options.listSessions ?? listPiSessions;
  }

  async handleClientMessage(message: ClientMessage): Promise<void> {
    if (message.type === "disconnect") {
      this.dispose();
      return;
    }

    if (message.command === "list_sessions") {
      await this.refreshSessions();
      return;
    }

    if (message.command === "open_session") {
      const sessionPath = stringPayload(message.payload, "path");
      if (!sessionPath) {
        this.sendBridgeError("open_session requires a session path.");
        return;
      }

      this.openSession(sessionPath);
      return;
    }

    if (message.command === "new_session") {
      const version = this.beginSessionVersion();
      this.ensurePi();
      this.sendPiCommand("new_session", message.payload, `session-${version}-new`);
      return;
    }

    this.ensurePi();
    this.sendPiCommand(message.command, message.payload);
  }

  dispose(): void {
    this.pi?.stop();
    this.pi = null;
  }

  private ensurePi(config: PiSessionConfig = {}): PiProcessLike {
    if (this.pi) {
      return this.pi;
    }

    const pi = this.createPiProcess();
    pi.on("pi-event", (event) => void this.handlePiEvent(event));
    pi.start({ ...config, sessionDir: this.options.sessionDir });
    this.pi = pi;
    return pi;
  }

  private openSession(session: string): void {
    const version = this.beginSessionVersion();
    if (!this.pi) {
      this.ensurePi({ session });
      this.hydrateActiveSession(version);
      return;
    }

    this.sendPiCommand("switch_session", { sessionPath: session }, `session-${version}-switch`);
  }

  private hydrateActiveSession(version = this.beginSessionVersion()): void {
    this.sendPiCommand("get_messages", {}, `hydrate-${version}-messages`);
    this.sendPiCommand("get_state", {}, `hydrate-${version}-state`);
  }

  private async handlePiEvent(event: PiProcessEvent): Promise<void> {
    if (event.type === "response" && isRecord(event.response)) {
      if (this.isStaleBridgeResponse(event.response)) {
        return;
      }

      this.options.send({ source: "pi", ...event });
      await this.handlePiResponse(event.response);
      return;
    }

    this.options.send({ source: "pi", ...event });

    if (event.type === "status" && event.status === "exited") {
      this.pi = null;
      return;
    }

    if (event.type === "event" && isRecord(event.event) && event.event.type === "agent_end") {
      this.hydrateActiveSession();
      await this.refreshSessions();
      return;
    }

  }

  private async handlePiResponse(response: Record<string, unknown>): Promise<void> {
    if (response.success === false) {
      return;
    }

    const command = typeof response.command === "string" ? response.command : "";
    if (command !== "new_session" && command !== "switch_session" && command !== "set_session_name") {
      return;
    }

    if (isCancelledSessionReplacement(response)) {
      this.options.send({
        source: "bridge",
        type: "session_cancelled",
        command,
        message: command === "new_session" ? "New session cancelled." : "Session switch cancelled."
      });
    }

    this.hydrateActiveSession(currentBridgeVersion(response) ?? this.sessionVersion);
    await this.refreshSessions();
  }

  private sendPiCommand(command: string, payload: Record<string, unknown> = {}, id?: string): void {
    const rpcCommand = createPiRpcCommand(command, payload);
    if (id) {
      rpcCommand.id = id;
    }
    this.pi?.send(rpcCommand);
  }

  private beginSessionVersion(): number {
    this.sessionVersion += 1;
    return this.sessionVersion;
  }

  private isStaleBridgeResponse(response: Record<string, unknown>): boolean {
    const version = currentBridgeVersion(response);
    return version !== null && version !== this.sessionVersion;
  }

  private async refreshSessions(): Promise<void> {
    try {
      const sessions = await this.listSessions(this.options.cwd, this.options.sessionDir);
      this.options.send({ source: "bridge", type: "sessions", sessions });
    } catch (error) {
      this.sendBridgeError(error instanceof Error ? error.message : String(error));
    }
  }

  private sendBridgeError(message: string): void {
    this.options.send({ source: "bridge", type: "error", message });
  }
}

function stringPayload(payload: Record<string, unknown> | undefined, key: string): string {
  const value = payload?.[key];
  return typeof value === "string" ? value : "";
}

function currentBridgeVersion(response: Record<string, unknown>): number | null {
  const id = typeof response.id === "string" ? response.id : "";
  const match = /^(?:hydrate|session)-(\d+)-/.exec(id);
  return match ? Number(match[1]) : null;
}

function isCancelledSessionReplacement(response: Record<string, unknown>): boolean {
  const data = response.data;
  return isRecord(data) && data.cancelled === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

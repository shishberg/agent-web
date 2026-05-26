import { dirname } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createPiRpcCommand, PiProcess, type PiProcessEvent, type PiSessionConfig } from "./piProcess";
import { listPiSessions, type PiSessionSummary } from "./piSessions";

export type ClientMessage = { type: "command"; command: string; payload?: Record<string, unknown> } | { type: "disconnect" };

export type PiProcessLike = {
  on(event: "pi-event", listener: (event: PiProcessEvent) => void): unknown;
  start(config: PiSessionConfig): void;
  send(value: Record<string, unknown>): void;
  stop(): void;
};

export type RunnerOutputMetadata = {
  topic?: "sessions";
  runnerKey?: string;
  sessionPath?: string;
};

type PersistedSessionContext = {
  messages: unknown[];
  model: unknown;
  thinkingLevel?: string;
};

type PiRunner = {
  key: string;
  pi: PiProcessLike;
  activeTurn: boolean;
  sessionVersion: number;
  sessionPath?: string;
};

type RunnerTarget = {
  key: string;
  config: PiSessionConfig;
  sessionPath?: string;
};

export type PersistedSessionReader = {
  buildSessionContext(): PersistedSessionContext;
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getCwd(): string;
  getSessionName(): string | undefined;
  getHeader(): unknown;
};

export type DisconnectBehavior = "stopRunners" | "detach";

export type PiRunnerCoreOptions = {
  cwd: string;
  sessionDir?: string;
  createPiProcess?: () => PiProcessLike;
  listSessions?: (cwd: string, sessionDir?: string) => Promise<PiSessionSummary[]>;
  openSession?: (path: string, sessionDir?: string) => PersistedSessionReader;
  send: (message: unknown, metadata?: RunnerOutputMetadata) => void;
  disconnectBehavior?: DisconnectBehavior;
};

export class PiRunnerCore {
  private readonly createPiProcess: () => PiProcessLike;
  private readonly listSessions: (cwd: string, sessionDir?: string) => Promise<PiSessionSummary[]>;
  private readonly openPersistedSession: (path: string, sessionDir?: string) => PersistedSessionReader;
  private readonly disconnectBehavior: DisconnectBehavior;
  private readonly runners = new Map<string, PiRunner>();
  private persistedSessionVersion = 0;

  constructor(private readonly options: PiRunnerCoreOptions) {
    this.createPiProcess = options.createPiProcess ?? (() => new PiProcess());
    this.listSessions = options.listSessions ?? listPiSessions;
    this.openPersistedSession = options.openSession ?? ((path, sessionDir) => SessionManager.open(path, sessionDir));
    this.disconnectBehavior = options.disconnectBehavior ?? "stopRunners";
  }

  async handleClientMessage(message: ClientMessage): Promise<void> {
    if (message.type === "disconnect") {
      this.disconnect();
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
      const runner = this.ensureRunner(this.runnerTarget(message.payload));
      const version = this.beginRunnerSessionVersion(runner);
      this.sendPiCommand(runner, "new_session", commandPayload(message.payload), `session-${version}-new`);
      return;
    }

    if (message.command === "prompt") {
      const target = this.runnerTarget(message.payload);
      const existingRunner = this.runners.get(target.key);
      const runner = existingRunner ?? this.ensureRunner(target);
      const activeTurn = runner.activeTurn;
      runner.activeTurn = true;
      this.sendPiCommand(runner, message.command, promptPayload(message.payload, activeTurn));
      return;
    }

    const target = this.runnerTarget(message.payload);
    const runner = this.ensureRunner(target);
    this.sendPiCommand(runner, message.command, commandPayload(message.payload));
  }

  disconnect(): void {
    if (this.disconnectBehavior === "detach") {
      return;
    }

    this.dispose();
  }

  stopRunner(key: string): void {
    const runner = this.runners.get(key);
    if (!runner) {
      return;
    }

    runner.pi.stop();
    this.deleteRunnerAliases(runner);
  }

  dispose(): void {
    for (const runner of new Set(this.runners.values())) {
      runner.pi.stop();
    }
    this.runners.clear();
  }

  private ensureRunner(target: RunnerTarget): PiRunner {
    const existingRunner = this.runners.get(target.key);
    if (existingRunner) {
      return existingRunner;
    }

    const pi = this.createPiProcess();
    const runner: PiRunner = { key: target.key, pi, activeTurn: false, sessionVersion: 0, sessionPath: target.sessionPath };
    pi.on("pi-event", (event) => void this.handlePiEvent(runner, event));
    pi.start({ ...target.config, sessionDir: this.options.sessionDir ?? target.config.sessionDir });
    this.runners.set(target.key, runner);
    return runner;
  }

  private openSession(session: string): void {
    const version = this.beginPersistedSessionVersion();
    try {
      const persistedSession = this.openPersistedSession(session, this.options.sessionDir);
      const context = persistedSession.buildSessionContext();
      this.sendPersistedSessionHydration(version, persistedSession, context);
    } catch (error) {
      this.sendBridgeError(error instanceof Error ? error.message : String(error));
    }
  }

  private hydrateRunnerSession(runner: PiRunner, version = this.beginRunnerSessionVersion(runner)): void {
    this.sendPiCommand(runner, "get_messages", {}, `hydrate-${version}-messages`);
    this.sendPiCommand(runner, "get_state", {}, `hydrate-${version}-state`);
  }

  private async handlePiEvent(runner: PiRunner, event: PiProcessEvent): Promise<void> {
    if (!this.isRunnerRegistered(runner)) {
      return;
    }

    if (event.type === "response" && isRecord(event.response)) {
      if (this.isStaleRunnerResponse(runner, event.response)) {
        return;
      }

      if (!this.aliasRunnerSessionPath(runner, sessionPathFromPiPayload(event.response))) {
        return;
      }
      this.sendWithMetadata(piBridgeMessage(runner.sessionPath, event), runner);
      await this.handlePiResponse(runner, event.response);
      return;
    }

    if (event.type === "event" && isRecord(event.event)) {
      if (!this.aliasRunnerSessionPath(runner, sessionPathFromPiPayload(event.event))) {
        return;
      }
    }

    this.sendWithMetadata(piBridgeMessage(runner.sessionPath, event), runner);

    if (event.type === "spawn_error" || event.type === "framing_error" || event.type === "write_error") {
      runner.activeTurn = false;
    }

    if (event.type === "status" && event.status === "exited") {
      runner.activeTurn = false;
      if (this.runners.get(runner.key)?.pi === runner.pi) {
        this.deleteRunnerAliases(runner);
      }
      return;
    }

    if (event.type === "event" && isRecord(event.event)) {
      if (event.event.type === "turn_end") {
        runner.activeTurn = false;
      }

      if (event.event.type === "agent_end") {
        runner.activeTurn = false;
        this.hydrateRunnerSession(runner);
        await this.refreshSessions();
        return;
      }
    }
  }

  private async handlePiResponse(runner: PiRunner, response: Record<string, unknown>): Promise<void> {
    if (response.success === false) {
      if (response.command === "prompt") {
        runner.activeTurn = false;
      }
      return;
    }

    const command = typeof response.command === "string" ? response.command : "";
    if (command !== "new_session" && command !== "switch_session" && command !== "set_session_name") {
      return;
    }

    if (isCancelledSessionReplacement(response)) {
      this.sendWithMetadata(
        {
          source: "bridge",
          type: "session_cancelled",
          command,
          message: command === "new_session" ? "New session cancelled." : "Session switch cancelled."
        },
        runner
      );
    }

    this.hydrateRunnerSession(runner, currentBridgeVersion(response) ?? runner.sessionVersion);
    await this.refreshSessions();
  }

  private sendPiCommand(runner: PiRunner, command: string, payload: Record<string, unknown> = {}, id?: string): void {
    const rpcCommand = createPiRpcCommand(command, payload);
    if (id) {
      rpcCommand.id = id;
    }
    runner.pi.send(rpcCommand);
  }

  private aliasRunnerSessionPath(runner: PiRunner, sessionPath: string): boolean {
    if (!sessionPath) {
      return true;
    }

    const aliasKey = pathRunnerKey(sessionPath);
    const existingRunner = this.runners.get(aliasKey);
    if (existingRunner && existingRunner !== runner) {
      this.stopCollidingRunner(runner, sessionPath);
      return false;
    }

    runner.sessionPath = sessionPath;
    if (runner.key.startsWith("path:")) {
      runner.key = aliasKey;
    }
    this.deleteRunnerPathAliases(runner, sessionPath);
    this.runners.set(aliasKey, runner);
    return true;
  }

  private stopCollidingRunner(runner: PiRunner, sessionPath: string): void {
    this.sendWithMetadata(
      {
        source: "bridge",
        type: "error",
        message: `Session path is already active: ${sessionPath}.`
      },
      runner
    );
    runner.activeTurn = false;
    runner.pi.stop();
    this.deleteRunnerAliases(runner);
  }

  private deleteRunnerPathAliases(runner: PiRunner, keepSessionPath: string): void {
    const keepKey = pathRunnerKey(keepSessionPath);
    for (const [key, candidate] of this.runners) {
      if (candidate === runner && key.startsWith("path:") && key !== keepKey) {
        this.runners.delete(key);
      }
    }
  }

  private deleteRunnerAliases(runner: PiRunner): void {
    for (const [key, candidate] of this.runners) {
      if (candidate === runner) {
        this.runners.delete(key);
      }
    }
  }

  private isRunnerRegistered(runner: PiRunner): boolean {
    for (const candidate of this.runners.values()) {
      if (candidate === runner) {
        return true;
      }
    }
    return false;
  }

  private sendWithMetadata(message: unknown, runner: PiRunner): void {
    this.options.send(message, { runnerKey: runner.key, sessionPath: runner.sessionPath });
  }

  private runnerTarget(payload: Record<string, unknown> | undefined): RunnerTarget {
    const sessionPath = stringPayload(payload, "sessionPath") || stringPayload(payload, "path");
    if (!sessionPath) {
      return { key: stringPayload(payload, "internalRunnerKey") || defaultRunnerKey(), config: {} };
    }

    return {
      key: pathRunnerKey(sessionPath),
      config: { session: sessionPath, sessionDir: dirname(sessionPath) },
      sessionPath
    };
  }

  private sendPersistedSessionHydration(
    version: number,
    session: PersistedSessionReader,
    context: PersistedSessionContext
  ): void {
    const model = hydratedModel(context.model);
    this.options.send({
      source: "pi",
      ...sessionPathEnvelope(session.getSessionFile()),
      type: "response",
      response: {
        id: `hydrate-${version}-messages`,
        type: "response",
        command: "get_messages",
        success: true,
        data: { messages: context.messages }
      }
    });

    this.options.send({
      source: "pi",
      ...sessionPathEnvelope(session.getSessionFile()),
      type: "response",
      response: {
        id: `hydrate-${version}-state`,
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId: session.getSessionId(),
          sessionFile: session.getSessionFile(),
          cwd: session.getCwd(),
          sessionName: session.getSessionName(),
          provider: model.provider,
          model: model.value,
          thinking: context.thinkingLevel,
          thinkingLevel: context.thinkingLevel,
          header: session.getHeader()
        }
      }
    });
  }

  private beginPersistedSessionVersion(): number {
    this.persistedSessionVersion += 1;
    return this.persistedSessionVersion;
  }

  private beginRunnerSessionVersion(runner: PiRunner): number {
    runner.sessionVersion += 1;
    return runner.sessionVersion;
  }

  private isStaleRunnerResponse(runner: PiRunner, response: Record<string, unknown>): boolean {
    const version = currentBridgeVersion(response);
    return version !== null && version !== runner.sessionVersion;
  }

  private async refreshSessions(): Promise<void> {
    try {
      const sessions = await this.listSessions(this.options.cwd, this.options.sessionDir);
      this.options.send({ source: "bridge", type: "sessions", sessions }, { topic: "sessions" });
    } catch (error) {
      this.options.send(
        { source: "bridge", type: "error", message: error instanceof Error ? error.message : String(error) },
        { topic: "sessions" }
      );
    }
  }

  private sendBridgeError(message: string): void {
    this.options.send({ source: "bridge", type: "error", message });
  }
}

function piBridgeMessage(sessionPath: string | undefined, event: PiProcessEvent): Record<string, unknown> {
  return { source: "pi", ...sessionPathEnvelope(sessionPath), ...event };
}

function sessionPathEnvelope(sessionPath: string | undefined): Record<string, string> {
  return sessionPath ? { sessionPath } : {};
}

function stringPayload(payload: Record<string, unknown> | undefined, key: string): string {
  const value = payload?.[key];
  return typeof value === "string" ? value : "";
}

function commandPayload(payload: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!payload) {
    return {};
  }

  const { sessionPath: _sessionPath, path: _path, queueMode: _queueMode, internalRunnerKey: _internalRunnerKey, ...rest } = payload;
  return rest;
}

function promptPayload(payload: Record<string, unknown> | undefined, activeTurn: boolean): Record<string, unknown> {
  const piPayload = commandPayload(payload);
  if (!activeTurn) {
    return piPayload;
  }

  return {
    ...piPayload,
    streamingBehavior: promptStreamingBehavior(payload)
  };
}

function promptStreamingBehavior(payload: Record<string, unknown> | undefined): "steer" | "followUp" {
  const queueMode = stringPayload(payload, "queueMode");
  return queueMode === "follow_up" || queueMode === "followUp" ? "followUp" : "steer";
}

function defaultRunnerKey(): string {
  return "default";
}

function pathRunnerKey(sessionPath: string): string {
  return `path:${sessionPath}`;
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

function sessionPathFromPiPayload(payload: Record<string, unknown>): string {
  const data = payload.data;
  const direct = stringValue(payload.sessionFile) || stringValue(payload.sessionPath);
  if (direct) {
    return direct;
  }

  if (!isRecord(data)) {
    return "";
  }

  const nestedSession = data.session;
  return (
    stringValue(data.sessionFile) ||
    stringValue(data.sessionPath) ||
    (isRecord(nestedSession) ? stringValue(nestedSession.sessionFile) || stringValue(nestedSession.sessionPath) : "")
  );
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function hydratedModel(model: unknown): { provider: unknown; value: unknown } {
  if (!isRecord(model)) {
    return { provider: undefined, value: model };
  }

  const provider = model.provider;
  const modelId = model.modelId;
  if (model.id !== undefined || typeof modelId !== "string") {
    return { provider, value: model };
  }

  return { provider, value: { ...model, id: modelId } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

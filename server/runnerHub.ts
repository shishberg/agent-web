import { PiRunnerCore, type PiRunnerCoreOptions, type RunnerOutputMetadata } from "./runnerCore";
import type {
  RunnerClientCommandEnvelope,
  RunnerInputEnvelope,
  RunnerOutputEnvelope
} from "./runnerProtocol";

type RunnerHubOptions = Omit<PiRunnerCoreOptions, "send" | "disconnectBehavior"> & {
  send: (message: RunnerOutputEnvelope) => void;
};

type ExtensionRoute = {
  runnerKey?: string;
  sessionPath?: string;
};

export class RunnerHub {
  private readonly core: PiRunnerCore;
  private readonly sessionListSubscribers = new Set<string>();
  private readonly sessionSubscribers = new Map<string, Set<string>>();
  private readonly extensionRequests = new Map<string, ExtensionRoute>();
  private directClientId: string | null = null;

  constructor(private readonly options: RunnerHubOptions) {
    this.core = new PiRunnerCore({
      ...options,
      disconnectBehavior: "detach",
      send: (message, metadata) => this.routeCoreMessage(message, metadata)
    });
  }

  async handleEnvelope(envelope: RunnerInputEnvelope): Promise<void> {
    if (envelope.type === "hello") {
      return;
    }

    if (envelope.type === "client_disconnected") {
      this.removeClient(envelope.clientId);
      return;
    }

    await this.handleClientCommand(envelope);
  }

  dispose(): void {
    this.core.dispose();
  }

  private async handleClientCommand(envelope: RunnerClientCommandEnvelope): Promise<void> {
    if (envelope.command === "list_sessions") {
      this.sessionListSubscribers.add(envelope.clientId);
      await this.core.handleClientMessage({ type: "command", command: envelope.command, payload: envelope.payload });
      return;
    }

    if (envelope.command === "open_session") {
      await this.withDirectClient(envelope.clientId, () =>
        this.core.handleClientMessage({ type: "command", command: envelope.command, payload: envelope.payload })
      );
      return;
    }

    if (envelope.command === "prompt" || envelope.command === "new_session") {
      this.subscribeClientToCommandTarget(envelope);
      await this.core.handleClientMessage({
        type: "command",
        command: envelope.command,
        payload: this.liveCommandPayload(envelope)
      });
      return;
    }

    if (envelope.command === "extension_ui_response") {
      const payload = this.extensionResponsePayload(envelope.payload);
      if (!payload) {
        this.options.send({
          type: "error",
          clientId: envelope.clientId,
          message: unknownExtensionRequestMessage(envelope.payload)
        });
        return;
      }

      await this.core.handleClientMessage({
        type: "command",
        command: envelope.command,
        payload
      });
      return;
    }

    await this.core.handleClientMessage({
      type: "command",
      command: envelope.command,
      payload: this.liveCommandPayload(envelope)
    });
  }

  private routeCoreMessage(message: unknown, metadata?: RunnerOutputMetadata): void {
    this.rememberExtensionRequest(message, metadata);

    if (isBridgeSessionsMessage(message) || metadata?.topic === "sessions") {
      this.options.send({
        type: "broadcast",
        topic: "sessions",
        clientIds: [...this.sessionListSubscribers],
        message
      });
      return;
    }

    if (this.directClientId) {
      this.options.send({ type: "client_event", clientId: this.directClientId, message });
      return;
    }

    const clientIds = this.clientsForMetadata(metadata);
    for (const clientId of clientIds) {
      this.options.send({ type: "client_event", clientId, message });
    }
  }

  private rememberExtensionRequest(message: unknown, metadata?: RunnerOutputMetadata): void {
    if (!isRecord(message) || message.type !== "event" || !isRecord(message.event)) {
      return;
    }

    if (message.event.type !== "extension_ui_request") {
      return;
    }

    const id = typeof message.event.id === "string" ? message.event.id : "";
    if (!id) {
      return;
    }

    this.extensionRequests.set(id, { runnerKey: metadata?.runnerKey, sessionPath: metadata?.sessionPath });
  }

  private extensionResponsePayload(payload: Record<string, unknown> | undefined): Record<string, unknown> | null {
    const id = stringPayload(payload, "id");
    if (!payload || !id) {
      return null;
    }

    const route = this.extensionRequests.get(id);
    if (!route || !this.extensionResponseMatchesRoute(payload, route)) {
      return null;
    }
    this.extensionRequests.delete(id);

    if (route.sessionPath) {
      return { ...withoutInternalRouteFields(payload), sessionPath: route.sessionPath };
    }

    if (route.runnerKey) {
      return { ...withoutInternalRouteFields(payload), internalRunnerKey: route.runnerKey };
    }

    return null;
  }

  private extensionResponseMatchesRoute(payload: Record<string, unknown>, route: ExtensionRoute): boolean {
    const sessionPath = stringPayload(payload, "sessionPath");
    if (!sessionPath) {
      return true;
    }

    return route.sessionPath ? sessionPath === route.sessionPath : Boolean(route.runnerKey);
  }

  private clientsForMetadata(metadata: RunnerOutputMetadata | undefined): string[] {
    const clientIds = new Set<string>();
    if (metadata?.runnerKey) {
      for (const clientId of this.sessionSubscribers.get(metadata.runnerKey) ?? []) {
        clientIds.add(clientId);
      }
    }

    if (metadata?.sessionPath) {
      for (const clientId of this.sessionSubscribers.get(sessionPathRunnerKey(metadata.sessionPath)) ?? []) {
        clientIds.add(clientId);
      }
    }

    return [...clientIds];
  }

  private subscribeClientToCommandTarget(envelope: RunnerClientCommandEnvelope): void {
    this.addSessionSubscriber(this.commandTargetKey(envelope), envelope.clientId);
  }

  private liveCommandPayload(envelope: RunnerClientCommandEnvelope): Record<string, unknown> | undefined {
    const payload = envelope.payload;
    if (hasSessionPath(payload)) {
      return payload;
    }

    return { ...payload, internalRunnerKey: this.clientDefaultRunnerKey(envelope.clientId) };
  }

  private commandTargetKey(envelope: RunnerClientCommandEnvelope): string {
    const sessionPath = stringPayload(envelope.payload, "sessionPath") || stringPayload(envelope.payload, "path");
    return sessionPath ? sessionPathRunnerKey(sessionPath) : this.clientDefaultRunnerKey(envelope.clientId);
  }

  private clientDefaultRunnerKey(clientId: string): string {
    return `default:${clientId}`;
  }

  private addSessionSubscriber(key: string, clientId: string): void {
    const subscribers = this.sessionSubscribers.get(key) ?? new Set<string>();
    subscribers.add(clientId);
    this.sessionSubscribers.set(key, subscribers);
  }

  private removeClient(clientId: string): void {
    this.sessionListSubscribers.delete(clientId);
    for (const [key, subscribers] of this.sessionSubscribers) {
      subscribers.delete(clientId);
      if (subscribers.size === 0) {
        this.sessionSubscribers.delete(key);
      }
    }
  }

  private async withDirectClient(clientId: string, run: () => Promise<void>): Promise<void> {
    const previousClientId = this.directClientId;
    this.directClientId = clientId;
    try {
      await run();
    } finally {
      this.directClientId = previousClientId;
    }
  }
}

function isBridgeSessionsMessage(message: unknown): boolean {
  return isRecord(message) && message.source === "bridge" && message.type === "sessions";
}

function stringPayload(payload: Record<string, unknown> | undefined, key: string): string {
  const value = payload?.[key];
  return typeof value === "string" ? value : "";
}

function sessionPathRunnerKey(sessionPath: string): string {
  return `path:${sessionPath}`;
}

function hasSessionPath(payload: Record<string, unknown> | undefined): boolean {
  return Boolean(stringPayload(payload, "sessionPath") || stringPayload(payload, "path"));
}

function withoutInternalRouteFields(payload: Record<string, unknown>): Record<string, unknown> {
  const { sessionPath: _sessionPath, path: _path, internalRunnerKey: _internalRunnerKey, ...rest } = payload;
  return rest;
}

function unknownExtensionRequestMessage(payload: Record<string, unknown> | undefined): string {
  const id = stringPayload(payload, "id");
  return id ? `Unknown extension UI request: ${id}.` : "Unknown extension UI request.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

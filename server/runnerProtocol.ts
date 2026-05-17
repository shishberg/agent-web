export const RUNNER_PROTOCOL_VERSION = 1;

export type BrowserCommandMessage = {
  type: "command";
  command: string;
  payload?: Record<string, unknown>;
};

export type BrowserDisconnectMessage = { type: "disconnect" };

export type BrowserClientMessage = BrowserCommandMessage | BrowserDisconnectMessage;

export type RunnerHelloEnvelope = {
  type: "hello";
  protocolVersion: number;
};

export type RunnerClientCommandEnvelope = {
  type: "client_command";
  clientId: string;
  command: string;
  payload?: Record<string, unknown>;
};

export type RunnerClientDisconnectedEnvelope = {
  type: "client_disconnected";
  clientId: string;
};

export type RunnerInputEnvelope = RunnerHelloEnvelope | RunnerClientCommandEnvelope | RunnerClientDisconnectedEnvelope;

export type RunnerClientEventEnvelope = {
  type: "client_event";
  clientId: string;
  message: unknown;
};

export type RunnerBroadcastEnvelope = {
  type: "broadcast";
  topic: "sessions" | "session";
  clientIds: string[];
  message: unknown;
};

export type RunnerStatusEnvelope = {
  type: "status";
  status: "ready";
};

export type RunnerErrorEnvelope = {
  type: "error";
  clientId?: string;
  message: string;
};

export type RunnerOutputEnvelope =
  | RunnerHelloEnvelope
  | RunnerClientEventEnvelope
  | RunnerBroadcastEnvelope
  | RunnerStatusEnvelope
  | RunnerErrorEnvelope;

export function isRunnerInputEnvelope(value: unknown): value is RunnerInputEnvelope {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "hello") {
    return typeof value.protocolVersion === "number";
  }

  if (value.type === "client_disconnected") {
    return typeof value.clientId === "string";
  }

  if (value.type === "client_command") {
    return (
      typeof value.clientId === "string" &&
      typeof value.command === "string" &&
      (value.payload === undefined || isRecord(value.payload))
    );
  }

  return false;
}

export function isRunnerOutputEnvelope(value: unknown): value is RunnerOutputEnvelope {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  if (value.type === "hello") {
    return typeof value.protocolVersion === "number";
  }

  if (value.type === "status") {
    return value.status === "ready";
  }

  if (value.type === "client_event") {
    return typeof value.clientId === "string" && "message" in value;
  }

  if (value.type === "broadcast") {
    return (
      (value.topic === "sessions" || value.topic === "session") &&
      Array.isArray(value.clientIds) &&
      value.clientIds.every((clientId) => typeof clientId === "string") &&
      "message" in value
    );
  }

  if (value.type === "error") {
    return typeof value.message === "string" && (value.clientId === undefined || typeof value.clientId === "string");
  }

  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

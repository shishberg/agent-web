import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { RunnerHub } from "../server/runnerHub";
import { type PiProcessLike } from "../server/runnerCore";

class FakePiProcess extends EventEmitter implements PiProcessLike {
  readonly starts: unknown[] = [];
  readonly sent: Record<string, unknown>[] = [];

  start(config: unknown): void {
    this.starts.push(config);
  }

  send(value: Record<string, unknown>): void {
    this.sent.push(value);
  }

  stop(): void {}
}

describe("RunnerHub", () => {
  it("subscribes session-list clients and broadcasts refreshed sessions", async () => {
    const sent: unknown[] = [];
    const listSessions = vi.fn().mockResolvedValue([
      { id: "s1", path: "/tmp/pi/s1.jsonl", title: "Existing session", modified: "2026-05-16T00:00:00.000Z" }
    ]);
    const hub = new RunnerHub({
      cwd: "/repo",
      sessionDir: "/tmp/pi",
      listSessions,
      send: (message) => sent.push(message)
    });

    await hub.handleEnvelope({ type: "client_command", clientId: "c1", command: "list_sessions" });

    expect(sent).toContainEqual({
      type: "broadcast",
      topic: "sessions",
      clientIds: ["c1"],
      message: {
        source: "bridge",
        type: "sessions",
        sessions: [{ id: "s1", path: "/tmp/pi/s1.jsonl", title: "Existing session", modified: "2026-05-16T00:00:00.000Z" }]
      }
    });
  });

  it("broadcasts session-list errors only to session-list subscribers", async () => {
    const sent: unknown[] = [];
    const listSessions = vi.fn().mockRejectedValue(new Error("cannot list sessions"));
    const hub = new RunnerHub({
      cwd: "/repo",
      sessionDir: "/tmp/pi",
      listSessions,
      send: (message) => sent.push(message)
    });

    await hub.handleEnvelope({ type: "client_command", clientId: "c1", command: "list_sessions" });

    expect(sent).toContainEqual({
      type: "broadcast",
      topic: "sessions",
      clientIds: ["c1"],
      message: { source: "bridge", type: "error", message: "cannot list sessions" }
    });
  });

  it("hydrates open_session only to the requesting client without subscribing to live events", async () => {
    const process = new FakePiProcess();
    const sent: unknown[] = [];
    const hub = new RunnerHub({
      cwd: "/repo",
      sessionDir: "/tmp/pi",
      createPiProcess: () => process,
      openSession: (path) => ({
        buildSessionContext: () => ({ messages: [{ role: "user", content: "saved" }], model: "model" }),
        getSessionId: () => "s1",
        getSessionFile: () => path,
        getCwd: () => "/repo",
        getSessionName: () => "Saved session",
        getHeader: () => ({ type: "session" })
      }),
      send: (message) => sent.push(message)
    });

    await hub.handleEnvelope({
      type: "client_command",
      clientId: "viewer",
      command: "open_session",
      payload: { path: "/tmp/pi/s1.jsonl" }
    });
    await hub.handleEnvelope({
      type: "client_command",
      clientId: "worker",
      command: "prompt",
      payload: { message: "live", sessionPath: "/tmp/pi/s1.jsonl" }
    });
    sent.length = 0;

    process.emit("pi-event", { type: "event", event: { type: "message_start", role: "assistant" } });

    expect(process.starts).toEqual([{ session: "/tmp/pi/s1.jsonl", sessionDir: "/tmp/pi" }]);
    expect(sent).toEqual([
      {
        type: "client_event",
        clientId: "worker",
        message: {
          source: "pi",
          sessionPath: "/tmp/pi/s1.jsonl",
          type: "event",
          event: { type: "message_start", role: "assistant" }
        }
      }
    ]);
  });

  it("routes live events only to clients subscribed to that session", async () => {
    const firstProcess = new FakePiProcess();
    const secondProcess = new FakePiProcess();
    const processes = [firstProcess, secondProcess];
    const sent: unknown[] = [];
    const hub = new RunnerHub({
      cwd: "/repo",
      sessionDir: "/tmp/pi",
      createPiProcess: () => processes.shift() ?? new FakePiProcess(),
      send: (message) => sent.push(message)
    });

    await hub.handleEnvelope({
      type: "client_command",
      clientId: "c1",
      command: "prompt",
      payload: { message: "first", sessionPath: "/tmp/pi/s1.jsonl" }
    });
    await hub.handleEnvelope({
      type: "client_command",
      clientId: "c2",
      command: "prompt",
      payload: { message: "second", sessionPath: "/tmp/pi/s2.jsonl" }
    });
    sent.length = 0;

    firstProcess.emit("pi-event", { type: "event", event: { type: "message_start", role: "assistant" } });

    expect(sent).toEqual([
      {
        type: "client_event",
        clientId: "c1",
        message: {
          source: "pi",
          sessionPath: "/tmp/pi/s1.jsonl",
          type: "event",
          event: { type: "message_start", role: "assistant" }
        }
      }
    ]);
  });

  it("isolates no-path live work per browser client until Pi reports a saved path", async () => {
    const firstProcess = new FakePiProcess();
    const secondProcess = new FakePiProcess();
    const processes = [firstProcess, secondProcess];
    const sent: unknown[] = [];
    const hub = new RunnerHub({
      cwd: "/repo",
      sessionDir: "/tmp/pi",
      createPiProcess: () => processes.shift() ?? new FakePiProcess(),
      send: (message) => sent.push(message)
    });

    await hub.handleEnvelope({ type: "client_command", clientId: "c1", command: "new_session" });
    await hub.handleEnvelope({ type: "client_command", clientId: "c2", command: "new_session" });
    sent.length = 0;

    firstProcess.emit("pi-event", { type: "event", event: { type: "message_start", role: "assistant" } });

    expect(firstProcess.sent).toEqual([{ type: "new_session", id: "session-1-new" }]);
    expect(secondProcess.sent).toEqual([{ type: "new_session", id: "session-1-new" }]);
    expect(sent).toEqual([
      {
        type: "client_event",
        clientId: "c1",
        message: {
          source: "pi",
          type: "event",
          event: { type: "message_start", role: "assistant" }
        }
      }
    ]);
  });

  it("routes extension UI responses without a session path by request id", async () => {
    const process = new FakePiProcess();
    const sent: unknown[] = [];
    const hub = new RunnerHub({
      cwd: "/repo",
      sessionDir: "/tmp/pi",
      createPiProcess: () => process,
      send: (message) => sent.push(message)
    });

    await hub.handleEnvelope({
      type: "client_command",
      clientId: "c1",
      command: "prompt",
      payload: { message: "saved hello", sessionPath: "/tmp/pi/s1.jsonl" }
    });
    process.emit("pi-event", {
      type: "event",
      event: { type: "extension_ui_request", id: "ext-1", method: "set_editor_text" }
    });
    process.sent.length = 0;

    await hub.handleEnvelope({
      type: "client_command",
      clientId: "c1",
      command: "extension_ui_response",
      payload: { id: "ext-1", value: "accepted" }
    });

    expect(process.sent).toEqual([{ type: "extension_ui_response", id: "ext-1", value: "accepted" }]);
    expect(sent).toContainEqual({
      type: "client_event",
      clientId: "c1",
      message: {
        source: "pi",
        sessionPath: "/tmp/pi/s1.jsonl",
        type: "event",
        event: { type: "extension_ui_request", id: "ext-1", method: "set_editor_text" }
      }
    });
  });

  it("rejects duplicate extension UI responses after consuming their request route", async () => {
    const process = new FakePiProcess();
    const sent: unknown[] = [];
    const hub = new RunnerHub({
      cwd: "/repo",
      sessionDir: "/tmp/pi",
      createPiProcess: () => process,
      send: (message) => sent.push(message)
    });

    await hub.handleEnvelope({
      type: "client_command",
      clientId: "c1",
      command: "prompt",
      payload: { message: "saved hello", sessionPath: "/tmp/pi/s1.jsonl" }
    });
    process.emit("pi-event", {
      type: "event",
      event: { type: "extension_ui_request", id: "ext-1", method: "confirm" }
    });
    process.sent.length = 0;

    await hub.handleEnvelope({
      type: "client_command",
      clientId: "c1",
      command: "extension_ui_response",
      payload: { id: "ext-1", confirmed: true }
    });
    await hub.handleEnvelope({
      type: "client_command",
      clientId: "c1",
      command: "extension_ui_response",
      payload: { id: "ext-1", confirmed: true }
    });

    expect(process.sent).toEqual([{ type: "extension_ui_response", id: "ext-1", confirmed: true }]);
    expect(sent).toContainEqual({
      type: "error",
      clientId: "c1",
      message: "Unknown extension UI request: ext-1."
    });
  });

  it("rejects duplicate extension UI responses even when they carry a session path", async () => {
    const process = new FakePiProcess();
    const sent: unknown[] = [];
    const hub = new RunnerHub({
      cwd: "/repo",
      sessionDir: "/tmp/pi",
      createPiProcess: () => process,
      send: (message) => sent.push(message)
    });

    await hub.handleEnvelope({
      type: "client_command",
      clientId: "c1",
      command: "prompt",
      payload: { message: "saved hello", sessionPath: "/tmp/pi/s1.jsonl" }
    });
    process.emit("pi-event", {
      type: "event",
      event: { type: "extension_ui_request", id: "ext-1", method: "confirm" }
    });
    process.sent.length = 0;

    await hub.handleEnvelope({
      type: "client_command",
      clientId: "c1",
      command: "extension_ui_response",
      payload: { id: "ext-1", confirmed: true, sessionPath: "/tmp/pi/s1.jsonl" }
    });
    await hub.handleEnvelope({
      type: "client_command",
      clientId: "c1",
      command: "extension_ui_response",
      payload: { id: "ext-1", confirmed: true, sessionPath: "/tmp/pi/s1.jsonl" }
    });

    expect(process.sent).toEqual([{ type: "extension_ui_response", id: "ext-1", confirmed: true }]);
    expect(sent).toContainEqual({
      type: "error",
      clientId: "c1",
      message: "Unknown extension UI request: ext-1."
    });
  });

  it("rejects stale extension UI responses that have no route", async () => {
    const process = new FakePiProcess();
    const sent: unknown[] = [];
    const hub = new RunnerHub({
      cwd: "/repo",
      sessionDir: "/tmp/pi",
      createPiProcess: () => process,
      send: (message) => sent.push(message)
    });

    await hub.handleEnvelope({
      type: "client_command",
      clientId: "c1",
      command: "extension_ui_response",
      payload: { id: "stale-ext", value: "accepted" }
    });

    expect(sent).toEqual([
      {
        type: "error",
        clientId: "c1",
        message: "Unknown extension UI request: stale-ext."
      }
    ]);
    expect(process.starts).toEqual([]);
    expect(process.sent).toEqual([]);
  });

  it("rejects stale extension UI responses even when they carry a session path", async () => {
    const process = new FakePiProcess();
    const sent: unknown[] = [];
    const hub = new RunnerHub({
      cwd: "/repo",
      sessionDir: "/tmp/pi",
      createPiProcess: () => process,
      send: (message) => sent.push(message)
    });

    await hub.handleEnvelope({
      type: "client_command",
      clientId: "c1",
      command: "extension_ui_response",
      payload: { id: "stale-ext", value: "accepted", sessionPath: "/tmp/pi/s1.jsonl" }
    });

    expect(sent).toEqual([
      {
        type: "error",
        clientId: "c1",
        message: "Unknown extension UI request: stale-ext."
      }
    ]);
    expect(process.starts).toEqual([]);
    expect(process.sent).toEqual([]);
  });

  it("moves path subscriptions when a path runner reports a different session path", async () => {
    const process = new FakePiProcess();
    const sent: unknown[] = [];
    const hub = new RunnerHub({
      cwd: "/repo",
      sessionDir: "/tmp/pi",
      createPiProcess: () => process,
      send: (message) => sent.push(message)
    });

    await hub.handleEnvelope({
      type: "client_command",
      clientId: "s1-viewer",
      command: "prompt",
      payload: { message: "first", sessionPath: "/tmp/pi/s1.jsonl" }
    });
    process.emit("pi-event", {
      type: "response",
      response: {
        type: "response",
        command: "get_state",
        success: true,
        data: { sessionFile: "/tmp/pi/s2.jsonl" }
      }
    });
    await hub.handleEnvelope({
      type: "client_command",
      clientId: "s2-viewer",
      command: "prompt",
      payload: { message: "second", sessionPath: "/tmp/pi/s2.jsonl" }
    });
    sent.length = 0;

    process.emit("pi-event", { type: "event", event: { type: "message_start", role: "assistant" } });

    expect(sent).toEqual([
      {
        type: "client_event",
        clientId: "s2-viewer",
        message: {
          source: "pi",
          sessionPath: "/tmp/pi/s2.jsonl",
          type: "event",
          event: { type: "message_start", role: "assistant" }
        }
      }
    ]);
  });

  it("routes session cancellation notices to the subscribed live client", async () => {
    const process = new FakePiProcess();
    const sent: unknown[] = [];
    const hub = new RunnerHub({
      cwd: "/repo",
      sessionDir: "/tmp/pi",
      createPiProcess: () => process,
      send: (message) => sent.push(message)
    });

    await hub.handleEnvelope({ type: "client_command", clientId: "c1", command: "new_session" });
    process.emit("pi-event", {
      type: "response",
      response: { id: "session-1-new", type: "response", command: "new_session", success: true, data: { cancelled: true } }
    });

    expect(sent).toContainEqual({
      type: "client_event",
      clientId: "c1",
      message: {
        source: "bridge",
        type: "session_cancelled",
        command: "new_session",
        message: "New session cancelled."
      }
    });
  });

  it("removes subscriptions on disconnect without stopping Pi", async () => {
    const process = new FakePiProcess();
    const sent: unknown[] = [];
    const hub = new RunnerHub({
      cwd: "/repo",
      sessionDir: "/tmp/pi",
      createPiProcess: () => process,
      send: (message) => sent.push(message)
    });

    await hub.handleEnvelope({
      type: "client_command",
      clientId: "c1",
      command: "prompt",
      payload: { message: "saved hello", sessionPath: "/tmp/pi/s1.jsonl" }
    });
    await hub.handleEnvelope({ type: "client_disconnected", clientId: "c1" });
    sent.length = 0;

    process.emit("pi-event", { type: "event", event: { type: "message_start", role: "assistant" } });

    expect(process.starts).toEqual([{ session: "/tmp/pi/s1.jsonl", sessionDir: "/tmp/pi" }]);
    expect(sent).toEqual([]);
  });
});

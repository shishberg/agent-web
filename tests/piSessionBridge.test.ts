import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PiSessionBridge, type PiProcessLike } from "../server/piSessionBridge";

class FakePiProcess extends EventEmitter implements PiProcessLike {
  readonly starts: unknown[] = [];
  readonly sent: Record<string, unknown>[] = [];
  stopped = false;

  start(config: unknown): void {
    this.starts.push(config);
  }

  send(value: Record<string, unknown>): void {
    this.sent.push(value);
  }

  stop(): void {
    this.stopped = true;
  }
}

describe("Pi session bridge", () => {
  let process: FakePiProcess;
  let sent: unknown[];
  let listSessions: ReturnType<typeof vi.fn>;
  let bridge: PiSessionBridge;

  beforeEach(() => {
    process = new FakePiProcess();
    sent = [];
    listSessions = vi.fn().mockResolvedValue([
      { id: "s1", path: "/tmp/pi/s1.jsonl", title: "Existing session", modified: "2026-05-16T00:00:00.000Z" }
    ]);
    bridge = new PiSessionBridge({
      cwd: "/repo",
      sessionDir: "/tmp/pi",
      createPiProcess: () => process,
      listSessions,
      send: (message) => sent.push(message)
    });
  });

  it("lists Pi sessions without starting a Pi runtime", async () => {
    await bridge.handleClientMessage({ type: "command", command: "list_sessions" });

    expect(process.starts).toEqual([]);
    expect(listSessions).toHaveBeenCalledWith("/repo", "/tmp/pi");
    expect(sent).toContainEqual({
      source: "bridge",
      type: "sessions",
      sessions: [{ id: "s1", path: "/tmp/pi/s1.jsonl", title: "Existing session", modified: "2026-05-16T00:00:00.000Z" }]
    });
  });

  it("lazy-starts Pi on the first prompt", async () => {
    await bridge.handleClientMessage({ type: "command", command: "prompt", payload: { message: "hello" } });

    expect(process.starts).toEqual([{ sessionDir: "/tmp/pi" }]);
    expect(process.sent).toEqual([{ type: "prompt", message: "hello" }]);
  });

  it("opens a Pi-owned session and hydrates state from Pi", async () => {
    await bridge.handleClientMessage({
      type: "command",
      command: "open_session",
      payload: { path: "/tmp/pi/s1.jsonl" }
    });

    expect(process.starts).toEqual([{ session: "/tmp/pi/s1.jsonl", sessionDir: "/tmp/pi" }]);
    expect(process.sent).toEqual([
      { type: "get_messages", id: "hydrate-1-messages" },
      { type: "get_state", id: "hydrate-1-state" }
    ]);
  });

  it("requires a path when opening a Pi-owned session", async () => {
    await bridge.handleClientMessage({
      type: "command",
      command: "open_session",
      payload: { id: "s1" }
    });

    expect(sent).toContainEqual({
      source: "bridge",
      type: "error",
      message: "open_session requires a session path."
    });
    expect(process.starts).toEqual([]);
  });

  it("waits for Pi to switch before hydrating an already running runtime", async () => {
    await bridge.handleClientMessage({ type: "command", command: "prompt", payload: { message: "hello" } });
    process.sent.length = 0;

    await bridge.handleClientMessage({
      type: "command",
      command: "open_session",
      payload: { path: "/tmp/pi/s1.jsonl" }
    });

    expect(process.sent).toEqual([{ type: "switch_session", sessionPath: "/tmp/pi/s1.jsonl", id: "session-1-switch" }]);

    process.emit("pi-event", {
      type: "response",
      response: { id: "session-1-switch", type: "response", command: "switch_session", success: true, data: { cancelled: false } }
    });

    await vi.waitFor(() => {
      expect(process.sent).toContainEqual({ type: "get_messages", id: "hydrate-1-messages" });
    });
  });

  it("requires a path when opening after Pi is already running", async () => {
    await bridge.handleClientMessage({ type: "command", command: "prompt", payload: { message: "hello" } });
    process.sent.length = 0;

    await bridge.handleClientMessage({
      type: "command",
      command: "open_session",
      payload: { id: "s1" }
    });

    expect(sent).toContainEqual({
      source: "bridge",
      type: "error",
      message: "open_session requires a session path."
    });
    expect(process.sent).toEqual([]);
  });

  it("rehydrates the active session when Pi cancels a session switch", async () => {
    await bridge.handleClientMessage({ type: "command", command: "prompt", payload: { message: "hello" } });
    process.sent.length = 0;

    await bridge.handleClientMessage({
      type: "command",
      command: "open_session",
      payload: { path: "/tmp/pi/s1.jsonl" }
    });

    process.emit("pi-event", {
      type: "response",
      response: { id: "session-1-switch", type: "response", command: "switch_session", success: true, data: { cancelled: true } }
    });

    await vi.waitFor(() => {
      expect(process.sent).toContainEqual({ type: "get_messages", id: "hydrate-1-messages" });
    });
    expect(sent).toContainEqual({
      source: "bridge",
      type: "session_cancelled",
      command: "switch_session",
      message: "Session switch cancelled."
    });
  });

  it("rehydrates the active session when Pi cancels a new session", async () => {
    await bridge.handleClientMessage({ type: "command", command: "new_session" });

    expect(process.sent).toEqual([{ type: "new_session", id: "session-1-new" }]);

    process.emit("pi-event", {
      type: "response",
      response: { id: "session-1-new", type: "response", command: "new_session", success: true, data: { cancelled: true } }
    });

    await vi.waitFor(() => {
      expect(process.sent).toContainEqual({ type: "get_messages", id: "hydrate-1-messages" });
    });
    expect(sent).toContainEqual({
      source: "bridge",
      type: "session_cancelled",
      command: "new_session",
      message: "New session cancelled."
    });
  });

  it("does not forward stale hydration responses", async () => {
    await bridge.handleClientMessage({
      type: "command",
      command: "open_session",
      payload: { path: "/tmp/pi/s1.jsonl" }
    });
    await bridge.handleClientMessage({
      type: "command",
      command: "open_session",
      payload: { path: "/tmp/pi/s2.jsonl" }
    });

    process.emit("pi-event", {
      type: "response",
      response: {
        id: "hydrate-1-messages",
        type: "response",
        command: "get_messages",
        success: true,
        data: { messages: [{ role: "user", content: "stale" }] }
      }
    });

    expect(sent).not.toContainEqual({
      source: "pi",
      type: "response",
      response: expect.objectContaining({ id: "hydrate-1-messages" })
    });

    process.emit("pi-event", {
      type: "response",
      response: {
        id: "hydrate-2-messages",
        type: "response",
        command: "get_messages",
        success: true,
        data: { messages: [{ role: "user", content: "fresh" }] }
      }
    });

    await vi.waitFor(() => {
      expect(sent).toContainEqual({
        source: "pi",
        type: "response",
        response: expect.objectContaining({ id: "hydrate-2-messages" })
      });
    });
  });

  it("refreshes the Pi session list after a turn finishes", async () => {
    await bridge.handleClientMessage({ type: "command", command: "prompt", payload: { message: "hello" } });

    process.emit("pi-event", { type: "event", event: { type: "agent_end" } });

    await vi.waitFor(() => {
      expect(listSessions).toHaveBeenCalledWith("/repo", "/tmp/pi");
    });
    expect(process.sent).toContainEqual({ type: "get_messages", id: "hydrate-1-messages" });
    expect(process.sent).toContainEqual({ type: "get_state", id: "hydrate-1-state" });
    expect(sent).toContainEqual({
      source: "bridge",
      type: "sessions",
      sessions: [{ id: "s1", path: "/tmp/pi/s1.jsonl", title: "Existing session", modified: "2026-05-16T00:00:00.000Z" }]
    });
  });

  it("stops the runtime on dispose", () => {
    void bridge.handleClientMessage({ type: "command", command: "prompt", payload: { message: "hello" } });

    bridge.dispose();

    expect(process.stopped).toBe(true);
  });

  it("starts a fresh runtime after Pi exits", async () => {
    const processes = [new FakePiProcess(), new FakePiProcess()];
    let nextProcess = 0;
    bridge = new PiSessionBridge({
      cwd: "/repo",
      sessionDir: "/tmp/pi",
      createPiProcess: () => processes[nextProcess++],
      listSessions,
      send: (message) => sent.push(message)
    });

    await bridge.handleClientMessage({ type: "command", command: "prompt", payload: { message: "first" } });
    processes[0].emit("pi-event", { type: "status", status: "exited", code: 0, signal: null });
    await bridge.handleClientMessage({ type: "command", command: "prompt", payload: { message: "second" } });

    expect(processes[0].starts).toEqual([{ sessionDir: "/tmp/pi" }]);
    expect(processes[0].sent).toEqual([{ type: "prompt", message: "first" }]);
    expect(processes[1].starts).toEqual([{ sessionDir: "/tmp/pi" }]);
    expect(processes[1].sent).toEqual([{ type: "prompt", message: "second" }]);
  });
});

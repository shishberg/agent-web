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
  let openSession: ReturnType<typeof vi.fn>;
  let bridge: PiSessionBridge;

  beforeEach(() => {
    process = new FakePiProcess();
    sent = [];
    listSessions = vi.fn().mockResolvedValue([
      { id: "s1", path: "/tmp/pi/s1.jsonl", title: "Existing session", modified: "2026-05-16T00:00:00.000Z" }
    ]);
    openSession = vi.fn().mockReturnValue({
      buildSessionContext: () => ({
        messages: [{ role: "user", content: "saved hello" }],
        model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
        thinkingLevel: "medium"
      }),
      getSessionId: () => "s1",
      getSessionFile: () => "/tmp/pi/s1.jsonl",
      getCwd: () => "/repo",
      getSessionName: () => "Existing session",
      getHeader: () => ({ type: "session", id: "s1", timestamp: "2026-05-16T00:00:00.000Z", cwd: "/repo" })
    });
    bridge = new PiSessionBridge({
      cwd: "/repo",
      sessionDir: "/tmp/pi",
      createPiProcess: () => process,
      listSessions,
      openSession,
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

  it("opens a Pi-owned session from persisted state without starting Pi", async () => {
    await bridge.handleClientMessage({
      type: "command",
      command: "open_session",
      payload: { path: "/tmp/pi/s1.jsonl" }
    });

    expect(openSession).toHaveBeenCalledWith("/tmp/pi/s1.jsonl", "/tmp/pi");
    expect(process.starts).toEqual([]);
    expect(process.sent).toEqual([]);
    expect(sent).toContainEqual({
      source: "pi",
      type: "response",
      response: {
        id: "hydrate-1-messages",
        type: "response",
        command: "get_messages",
        success: true,
        data: { messages: [{ role: "user", content: "saved hello" }] }
      }
    });
    expect(sent).toContainEqual({
      source: "pi",
      type: "response",
      response: {
        id: "hydrate-1-state",
        type: "response",
        command: "get_state",
        success: true,
        data: {
          sessionId: "s1",
          sessionFile: "/tmp/pi/s1.jsonl",
          cwd: "/repo",
          sessionName: "Existing session",
          provider: "anthropic",
          model: { provider: "anthropic", modelId: "claude-sonnet-4-5", id: "claude-sonnet-4-5" },
          thinking: "medium",
          thinkingLevel: "medium",
          header: { type: "session", id: "s1", timestamp: "2026-05-16T00:00:00.000Z", cwd: "/repo" }
        }
      }
    });
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

  it("opens a persisted session without changing an already running runtime", async () => {
    await bridge.handleClientMessage({ type: "command", command: "prompt", payload: { message: "hello" } });
    process.sent.length = 0;

    await bridge.handleClientMessage({
      type: "command",
      command: "open_session",
      payload: { path: "/tmp/pi/s1.jsonl" }
    });

    expect(openSession).toHaveBeenCalledWith("/tmp/pi/s1.jsonl", "/tmp/pi");
    expect(process.starts).toEqual([{ sessionDir: "/tmp/pi" }]);
    expect(process.sent).toEqual([]);
    expect(sent).toContainEqual({
      source: "pi",
      type: "response",
      response: expect.objectContaining({ id: "hydrate-1-messages", command: "get_messages" })
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

  it("does not report a cancellation when opening a saved session while Pi is running", async () => {
    await bridge.handleClientMessage({ type: "command", command: "prompt", payload: { message: "hello" } });
    process.sent.length = 0;

    await bridge.handleClientMessage({
      type: "command",
      command: "open_session",
      payload: { path: "/tmp/pi/s1.jsonl" }
    });

    expect(process.sent).toEqual([]);
    expect(sent).not.toContainEqual(expect.objectContaining({ type: "session_cancelled" }));
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

  it("uses a fresh bridge response id for each saved session open", async () => {
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

    expect(process.starts).toEqual([]);
    expect(process.sent).toEqual([]);
    expect(sent).toContainEqual({
      source: "pi",
      type: "response",
      response: expect.objectContaining({ id: "hydrate-1-messages" })
    });
    expect(sent).toContainEqual({
      source: "pi",
      type: "response",
      response: expect.objectContaining({ id: "hydrate-2-messages" })
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

import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PiRunnerCore, type PiProcessLike } from "../server/runnerCore";

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

describe("Pi runner core", () => {
  let process: FakePiProcess;
  let processes: FakePiProcess[];
  let sent: unknown[];
  let listSessions: ReturnType<typeof vi.fn>;
  let openSession: ReturnType<typeof vi.fn>;
  let core: PiRunnerCore;

  beforeEach(() => {
    process = new FakePiProcess();
    processes = [process];
    sent = [];
    listSessions = vi.fn().mockResolvedValue([
      { id: "s1", path: "/tmp/pi/s1.jsonl", title: "Existing session", modified: "2026-05-16T00:00:00.000Z" }
    ]);
    openSession = vi.fn((path: string) => ({
      buildSessionContext: () => ({
        messages: [{ role: "user", content: path.endsWith("s2.jsonl") ? "saved second" : "saved hello" }],
        model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
        thinkingLevel: "medium"
      }),
      getSessionId: () => (path.endsWith("s2.jsonl") ? "s2" : "s1"),
      getSessionFile: () => path,
      getCwd: () => "/repo",
      getSessionName: () => (path.endsWith("s2.jsonl") ? "Second session" : "Existing session"),
      getHeader: () => ({
        type: "session",
        id: path.endsWith("s2.jsonl") ? "s2" : "s1",
        timestamp: "2026-05-16T00:00:00.000Z",
        cwd: "/repo"
      })
    }));
    core = new PiRunnerCore({
      cwd: "/repo",
      sessionDir: "/tmp/pi",
      createPiProcess: () => {
        const nextProcess = processes.find((candidate) => candidate.starts.length === 0 && candidate.sent.length === 0);
        if (nextProcess) {
          return nextProcess;
        }
        const created = new FakePiProcess();
        processes.push(created);
        return created;
      },
      listSessions,
      openSession,
      send: (message) => sent.push(message)
    });
  });

  it("lists Pi sessions without starting a Pi runtime", async () => {
    await core.handleClientMessage({ type: "command", command: "list_sessions" });

    expect(process.starts).toEqual([]);
    expect(listSessions).toHaveBeenCalledWith("/repo", "/tmp/pi");
    expect(sent).toContainEqual({
      source: "bridge",
      type: "sessions",
      sessions: [{ id: "s1", path: "/tmp/pi/s1.jsonl", title: "Existing session", modified: "2026-05-16T00:00:00.000Z" }]
    });
  });

  it("lazy-starts Pi on the first prompt", async () => {
    await core.handleClientMessage({ type: "command", command: "prompt", payload: { message: "hello" } });

    expect(process.starts).toEqual([{ sessionDir: "/tmp/pi" }]);
    expect(process.sent).toEqual([{ type: "prompt", message: "hello" }]);
  });

  it("starts a path runner when prompting a saved session path", async () => {
    await core.handleClientMessage({
      type: "command",
      command: "prompt",
      payload: { message: "saved hello", sessionPath: "/tmp/pi/s1.jsonl" }
    });

    expect(process.starts).toEqual([{ session: "/tmp/pi/s1.jsonl", sessionDir: "/tmp/pi" }]);
    expect(process.sent).toEqual([{ type: "prompt", message: "saved hello" }]);
  });

  it("tags path runner events with their session path", async () => {
    await core.handleClientMessage({
      type: "command",
      command: "prompt",
      payload: { message: "saved hello", sessionPath: "/tmp/pi/s1.jsonl" }
    });

    process.emit("pi-event", { type: "event", event: { type: "message_start", role: "assistant" } });

    expect(sent).toContainEqual({
      source: "pi",
      sessionPath: "/tmp/pi/s1.jsonl",
      type: "event",
      event: { type: "message_start", role: "assistant" }
    });
  });

  it("uses distinct runners for different saved session paths", async () => {
    await core.handleClientMessage({
      type: "command",
      command: "prompt",
      payload: { message: "first", sessionPath: "/tmp/pi/s1.jsonl" }
    });
    process.emit("pi-event", { type: "event", event: { type: "agent_end" } });

    await core.handleClientMessage({
      type: "command",
      command: "prompt",
      payload: { message: "second", sessionPath: "/tmp/pi/s2.jsonl" }
    });

    expect(processes).toHaveLength(2);
    expect(processes[0].starts).toEqual([{ session: "/tmp/pi/s1.jsonl", sessionDir: "/tmp/pi" }]);
    expect(processes[0].sent).toContainEqual({ type: "prompt", message: "first" });
    expect(processes[0].sent).not.toContainEqual({ type: "prompt", message: "second" });
    expect(processes[1].starts).toEqual([{ session: "/tmp/pi/s2.jsonl", sessionDir: "/tmp/pi" }]);
    expect(processes[1].sent).toEqual([{ type: "prompt", message: "second" }]);
  });

  it("steers a second prompt for the same saved session while a turn is active", async () => {
    await core.handleClientMessage({
      type: "command",
      command: "prompt",
      payload: { message: "first", sessionPath: "/tmp/pi/s1.jsonl" }
    });
    await core.handleClientMessage({
      type: "command",
      command: "prompt",
      payload: { message: "second", sessionPath: "/tmp/pi/s1.jsonl" }
    });

    expect(processes).toHaveLength(1);
    expect(process.sent).toEqual([
      { type: "prompt", message: "first" },
      { type: "prompt", message: "second", streamingBehavior: "steer" }
    ]);
    expect(sent).not.toContainEqual(expect.objectContaining({ source: "bridge", type: "error" }));
  });

  it.each(["follow_up", "followUp"])("maps %s queue mode to Pi prompt streaming behavior", async (queueMode) => {
    await core.handleClientMessage({
      type: "command",
      command: "prompt",
      payload: { message: "first", sessionPath: "/tmp/pi/s1.jsonl" }
    });
    await core.handleClientMessage({
      type: "command",
      command: "prompt",
      payload: { message: "second", sessionPath: "/tmp/pi/s1.jsonl", queueMode }
    });

    expect(processes).toHaveLength(1);
    expect(process.sent).toEqual([
      { type: "prompt", message: "first" },
      { type: "prompt", message: "second", streamingBehavior: "followUp" }
    ]);
  });

  it("accepts another prompt for the same saved session after turn_end", async () => {
    await core.handleClientMessage({
      type: "command",
      command: "prompt",
      payload: { message: "first", sessionPath: "/tmp/pi/s1.jsonl" }
    });
    process.emit("pi-event", { type: "event", event: { type: "turn_end" } });

    await core.handleClientMessage({
      type: "command",
      command: "prompt",
      payload: { message: "second", sessionPath: "/tmp/pi/s1.jsonl" }
    });

    expect(processes).toHaveLength(1);
    expect(process.sent).toEqual([
      { type: "prompt", message: "first" },
      { type: "prompt", message: "second" }
    ]);
  });

  it("routes extension UI responses back to the saved session runner", async () => {
    await core.handleClientMessage({
      type: "command",
      command: "prompt",
      payload: { message: "first", sessionPath: "/tmp/pi/s1.jsonl" }
    });
    process.sent.length = 0;

    await core.handleClientMessage({
      type: "command",
      command: "extension_ui_response",
      payload: { id: "ext-1", value: "yes", sessionPath: "/tmp/pi/s1.jsonl" }
    });

    expect(processes).toHaveLength(1);
    expect(process.sent).toEqual([{ type: "extension_ui_response", id: "ext-1", value: "yes" }]);
  });

  it("opens a saved session without sending to an active path runner", async () => {
    await core.handleClientMessage({
      type: "command",
      command: "prompt",
      payload: { message: "first", sessionPath: "/tmp/pi/s1.jsonl" }
    });
    process.sent.length = 0;

    await core.handleClientMessage({
      type: "command",
      command: "open_session",
      payload: { path: "/tmp/pi/s1.jsonl" }
    });

    expect(openSession).toHaveBeenCalledWith("/tmp/pi/s1.jsonl", "/tmp/pi");
    expect(process.sent).toEqual([]);
  });

  it("opens a Pi-owned session from persisted state without starting Pi", async () => {
    await core.handleClientMessage({
      type: "command",
      command: "open_session",
      payload: { path: "/tmp/pi/s1.jsonl" }
    });

    expect(openSession).toHaveBeenCalledWith("/tmp/pi/s1.jsonl", "/tmp/pi");
    expect(process.starts).toEqual([]);
    expect(process.sent).toEqual([]);
    expect(sent).toContainEqual({
      source: "pi",
      sessionPath: "/tmp/pi/s1.jsonl",
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
      sessionPath: "/tmp/pi/s1.jsonl",
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
    await core.handleClientMessage({
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
    await core.handleClientMessage({ type: "command", command: "prompt", payload: { message: "hello" } });
    process.sent.length = 0;

    await core.handleClientMessage({
      type: "command",
      command: "open_session",
      payload: { path: "/tmp/pi/s1.jsonl" }
    });

    expect(openSession).toHaveBeenCalledWith("/tmp/pi/s1.jsonl", "/tmp/pi");
    expect(process.starts).toEqual([{ sessionDir: "/tmp/pi" }]);
    expect(process.sent).toEqual([]);
    expect(sent).toContainEqual({
      source: "pi",
      sessionPath: "/tmp/pi/s1.jsonl",
      type: "response",
      response: expect.objectContaining({ id: "hydrate-1-messages", command: "get_messages" })
    });
  });

  it("requires a path when opening after Pi is already running", async () => {
    await core.handleClientMessage({ type: "command", command: "prompt", payload: { message: "hello" } });
    process.sent.length = 0;

    await core.handleClientMessage({
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
    await core.handleClientMessage({ type: "command", command: "prompt", payload: { message: "hello" } });
    process.sent.length = 0;

    await core.handleClientMessage({
      type: "command",
      command: "open_session",
      payload: { path: "/tmp/pi/s1.jsonl" }
    });

    expect(process.sent).toEqual([]);
    expect(sent).not.toContainEqual(expect.objectContaining({ type: "session_cancelled" }));
  });

  it("rehydrates the active session when Pi cancels a new session", async () => {
    await core.handleClientMessage({ type: "command", command: "new_session" });

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
    await core.handleClientMessage({
      type: "command",
      command: "open_session",
      payload: { path: "/tmp/pi/s1.jsonl" }
    });
    await core.handleClientMessage({
      type: "command",
      command: "open_session",
      payload: { path: "/tmp/pi/s2.jsonl" }
    });

    expect(process.starts).toEqual([]);
    expect(process.sent).toEqual([]);
    expect(sent).toContainEqual({
      source: "pi",
      sessionPath: "/tmp/pi/s1.jsonl",
      type: "response",
      response: expect.objectContaining({ id: "hydrate-1-messages" })
    });
    expect(sent).toContainEqual({
      source: "pi",
      sessionPath: "/tmp/pi/s2.jsonl",
      type: "response",
      response: expect.objectContaining({ id: "hydrate-2-messages" })
    });
  });

  it("scopes stale hydration filtering to each runner", async () => {
    await core.handleClientMessage({
      type: "command",
      command: "prompt",
      payload: { message: "first", sessionPath: "/tmp/pi/s1.jsonl" }
    });
    process.emit("pi-event", { type: "event", event: { type: "agent_end" } });

    await core.handleClientMessage({
      type: "command",
      command: "prompt",
      payload: { message: "second", sessionPath: "/tmp/pi/s2.jsonl" }
    });
    processes[1].emit("pi-event", { type: "event", event: { type: "agent_end" } });
    sent.length = 0;

    process.emit("pi-event", {
      type: "response",
      response: {
        id: "hydrate-1-messages",
        type: "response",
        command: "get_messages",
        success: true,
        data: { messages: [{ role: "assistant", content: "s1 hydrated late" }] }
      }
    });

    expect(sent).toContainEqual({
      source: "pi",
      sessionPath: "/tmp/pi/s1.jsonl",
      type: "response",
      response: expect.objectContaining({ id: "hydrate-1-messages", command: "get_messages" })
    });
  });

  it("refreshes the Pi session list after a turn finishes", async () => {
    await core.handleClientMessage({ type: "command", command: "prompt", payload: { message: "hello" } });

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

  it("stops all active runners on dispose", async () => {
    await core.handleClientMessage({
      type: "command",
      command: "prompt",
      payload: { message: "first", sessionPath: "/tmp/pi/s1.jsonl" }
    });
    process.emit("pi-event", { type: "event", event: { type: "agent_end" } });
    await core.handleClientMessage({
      type: "command",
      command: "prompt",
      payload: { message: "second", sessionPath: "/tmp/pi/s2.jsonl" }
    });

    core.dispose();

    expect(processes.map((candidate) => candidate.stopped)).toEqual([true, true]);
  });

  it("stops active runners on browser disconnect by default", async () => {
    await core.handleClientMessage({
      type: "command",
      command: "prompt",
      payload: { message: "first", sessionPath: "/tmp/pi/s1.jsonl" }
    });

    await core.handleClientMessage({ type: "disconnect" });

    expect(process.stopped).toBe(true);
  });

  it("can leave active runners alive when browser disconnect only detaches", async () => {
    core = new PiRunnerCore({
      cwd: "/repo",
      sessionDir: "/tmp/pi",
      createPiProcess: () => process,
      listSessions,
      openSession,
      send: (message) => sent.push(message),
      disconnectBehavior: "detach"
    });

    await core.handleClientMessage({
      type: "command",
      command: "prompt",
      payload: { message: "first", sessionPath: "/tmp/pi/s1.jsonl" }
    });

    await core.handleClientMessage({ type: "disconnect" });

    expect(process.stopped).toBe(false);
  });

  it("starts a fresh runtime after Pi exits", async () => {
    const processes = [new FakePiProcess(), new FakePiProcess()];
    let nextProcess = 0;
    core = new PiRunnerCore({
      cwd: "/repo",
      sessionDir: "/tmp/pi",
      createPiProcess: () => processes[nextProcess++],
      listSessions,
      send: (message) => sent.push(message)
    });

    await core.handleClientMessage({ type: "command", command: "prompt", payload: { message: "first" } });
    processes[0].emit("pi-event", { type: "status", status: "exited", code: 0, signal: null });
    await core.handleClientMessage({ type: "command", command: "prompt", payload: { message: "second" } });

    expect(processes[0].starts).toEqual([{ sessionDir: "/tmp/pi" }]);
    expect(processes[0].sent).toEqual([{ type: "prompt", message: "first" }]);
    expect(processes[1].starts).toEqual([{ sessionDir: "/tmp/pi" }]);
    expect(processes[1].sent).toEqual([{ type: "prompt", message: "second" }]);
  });

  it("removes only the runner that exits", async () => {
    await core.handleClientMessage({
      type: "command",
      command: "prompt",
      payload: { message: "first", sessionPath: "/tmp/pi/s1.jsonl" }
    });
    process.emit("pi-event", { type: "event", event: { type: "agent_end" } });
    await core.handleClientMessage({
      type: "command",
      command: "prompt",
      payload: { message: "second", sessionPath: "/tmp/pi/s2.jsonl" }
    });

    process.emit("pi-event", { type: "status", status: "exited", code: 0, signal: null });
    await core.handleClientMessage({
      type: "command",
      command: "follow_up",
      payload: { message: "still second", sessionPath: "/tmp/pi/s2.jsonl" }
    });

    expect(processes).toHaveLength(2);
    expect(processes[1].sent).toEqual([
      { type: "prompt", message: "second" },
      { type: "follow_up", message: "still second" }
    ]);
  });
});

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
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
  it("delegates session listing through the runner core", async () => {
    const process = new FakePiProcess();
    const sent: unknown[] = [];
    const listSessions = vi.fn().mockResolvedValue([
      { id: "s1", path: "/tmp/pi/s1.jsonl", title: "Existing session", modified: "2026-05-16T00:00:00.000Z" }
    ]);
    const bridge = new PiSessionBridge({
      cwd: "/repo",
      sessionDir: "/tmp/pi",
      createPiProcess: () => process,
      listSessions,
      send: (message) => sent.push(message)
    });

    await bridge.handleClientMessage({ type: "command", command: "list_sessions" });

    expect(process.starts).toEqual([]);
    expect(listSessions).toHaveBeenCalledWith("/repo", "/tmp/pi");
    expect(sent).toContainEqual({
      source: "bridge",
      type: "sessions",
      sessions: [{ id: "s1", path: "/tmp/pi/s1.jsonl", title: "Existing session", modified: "2026-05-16T00:00:00.000Z" }]
    });
  });

  it("preserves browser-facing Pi events from delegated runners", async () => {
    const process = new FakePiProcess();
    const sent: unknown[] = [];
    const bridge = new PiSessionBridge({
      cwd: "/repo",
      sessionDir: "/tmp/pi",
      createPiProcess: () => process,
      send: (message) => sent.push(message)
    });

    await bridge.handleClientMessage({ type: "command", command: "prompt", payload: { message: "hello" } });
    process.emit("pi-event", { type: "event", event: { type: "message_start", role: "assistant" } });

    expect(process.starts).toEqual([{ sessionDir: "/tmp/pi" }]);
    expect(process.sent).toEqual([{ type: "prompt", message: "hello" }]);
    expect(sent).toContainEqual({
      source: "pi",
      type: "event",
      event: { type: "message_start", role: "assistant" }
    });
  });
});

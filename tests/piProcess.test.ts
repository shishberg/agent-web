import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn }));

import { buildPiArgs, createPiRpcCommand, PiProcess, type PiProcessEvent } from "../server/piProcess";

describe("Pi process helpers", () => {
  beforeEach(() => {
    spawn.mockReset();
  });

  it("serializes UI commands into Pi RPC command objects", () => {
    expect(createPiRpcCommand("prompt", { message: "hello", type: "not-prompt" })).toEqual({
      type: "prompt",
      message: "hello"
    });
  });

  it("builds Pi RPC startup arguments", () => {
    expect(
      buildPiArgs({
        provider: "anthropic",
        model: "claude",
        noSession: true,
        sessionDir: "/tmp/pi",
        session: "abc123",
        extraArgs: "--debug 'two words'"
      })
    ).toEqual([
      "--mode",
      "rpc",
      "--provider",
      "anthropic",
      "--model",
      "claude",
      "--no-session",
      "--session-dir",
      "/tmp/pi",
      "--session",
      "abc123",
      "--debug",
      "two words"
    ]);
  });

  it("queues commands until the Pi child process has spawned", () => {
    const child = createFakeChild(false);
    spawn.mockReturnValue(child);
    const events: PiProcessEvent[] = [];
    const pi = new PiProcess();
    pi.on("pi-event", (event: PiProcessEvent) => events.push(event));

    pi.start({});
    pi.send({ type: "prompt", message: "hello" });

    expect(child.stdin.write).not.toHaveBeenCalled();
    expect(events).not.toContainEqual({ type: "write_error", message: "Pi process is not running." });

    child.stdin.writable = true;
    child.emit("spawn");

    expect(child.stdin.write).toHaveBeenCalledWith('{"type":"prompt","message":"hello"}\n');
    expect(events).toContainEqual({ type: "status", status: "running" });
  });

  it("drops queued commands when stopped before the Pi child process has spawned", () => {
    const child = createFakeChild(false);
    child.kill = vi.fn();
    spawn.mockReturnValue(child);
    const events: PiProcessEvent[] = [];
    const pi = new PiProcess();
    pi.on("pi-event", (event: PiProcessEvent) => events.push(event));

    pi.start({});
    pi.send({ type: "prompt", message: "hello" });
    pi.stop();

    child.stdin.writable = true;
    child.emit("spawn");

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.stdin.write).not.toHaveBeenCalled();
    expect(events).not.toContainEqual({ type: "status", status: "running" });
  });
});

function createFakeChild(stdinWritable: boolean) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: { writable: boolean; write: ReturnType<typeof vi.fn> };
    kill?: ReturnType<typeof vi.fn>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = { writable: stdinWritable, write: vi.fn() };
  return child;
}

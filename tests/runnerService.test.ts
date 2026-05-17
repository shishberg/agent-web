import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { type PiProcessLike } from "../server/runnerCore";
import { createRunnerService } from "../server/runnerService";
import { RUNNER_PROTOCOL_VERSION } from "../server/runnerProtocol";

class FakePiProcess extends EventEmitter implements PiProcessLike {
  readonly starts: unknown[] = [];
  readonly sent: Record<string, unknown>[] = [];
  stopCount = 0;

  start(config: unknown): void {
    this.starts.push(config);
  }

  send(value: Record<string, unknown>): void {
    this.sent.push(value);
  }

  stop(): void {
    this.stopCount += 1;
  }
}

describe("runner service", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("serves health JSON and sends the runner protocol hello", async () => {
    const service = createRunnerService({ cwd: "/repo", host: "127.0.0.1", port: 0 });
    cleanup.push(service.close);
    await service.listen();

    const health = await fetch(`http://${service.host}:${service.port}/health`);
    const body = await health.json();
    expect(body).toMatchObject({ ok: true, protocolVersion: RUNNER_PROTOCOL_VERSION });

    const hello = await readFirstMessage(`ws://${service.host}:${service.port}/runner`);
    expect(hello).toEqual({ type: "hello", protocolVersion: RUNNER_PROTOCOL_VERSION });
  });

  it("removes browser subscriptions when a runner web socket closes without stopping Pi", async () => {
    const process = new FakePiProcess();
    const service = createRunnerService({
      cwd: "/repo",
      host: "127.0.0.1",
      port: 0,
      createPiProcess: () => process
    });
    cleanup.push(service.close);
    await service.listen();

    const url = `ws://${service.host}:${service.port}/runner`;
    const firstSocket = await connectRunner(url);
    firstSocket.send(
      JSON.stringify({
        type: "client_command",
        clientId: "c1",
        command: "prompt",
        payload: { message: "hello", sessionPath: "/tmp/pi/s1.jsonl" }
      })
    );
    await expect.poll(() => process.sent.length).toBe(1);

    await closeSocket(firstSocket);
    expect(process.stopCount).toBe(0);

    const secondSocket = await connectRunner(url);
    cleanup.push(() => closeSocket(secondSocket));
    process.emit("pi-event", { type: "event", event: { type: "message_start", role: "assistant" } });

    await expectNoMessage(secondSocket);
    expect(process.stopCount).toBe(0);
  });
});

function readFirstMessage(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("message", (raw) => {
      resolve(JSON.parse(raw.toString()));
      ws.close();
    });
    ws.on("error", reject);
  });
}

function connectRunner(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on("error", reject);
    ws.once("message", (raw) => {
      expect(JSON.parse(raw.toString())).toEqual({ type: "hello", protocolVersion: RUNNER_PROTOCOL_VERSION });
      resolve(ws);
    });
  });
}

function closeSocket(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === ws.CLOSED) {
      resolve();
      return;
    }

    ws.once("close", () => resolve());
    ws.close();
  });
}

function expectNoMessage(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      resolve();
    }, 50);
    const onMessage = (raw: Buffer) => {
      clearTimeout(timer);
      reject(new Error(`Unexpected runner message: ${raw.toString()}`));
    };
    ws.once("message", onMessage);
  });
}

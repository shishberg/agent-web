import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { RUNNER_PROTOCOL_VERSION } from "../server/runnerProtocol";
import { RunnerClient } from "../server/runnerClient";

class FakeBrowserSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  readonly sent: unknown[] = [];

  send(raw: string): void {
    this.sent.push(JSON.parse(raw));
  }
}

class FakeRunnerSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = this.OPEN;
  readonly sent: unknown[] = [];

  send(raw: string): void {
    this.sent.push(JSON.parse(raw));
  }

  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
}

describe("RunnerClient", () => {
  const cleanup: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it("reports a bridge error when the runner is unavailable", async () => {
    const client = new RunnerClient({ url: "ws://127.0.0.1:9" });
    cleanup.push(() => client.dispose());
    const socket = new FakeBrowserSocket();

    client.attachBrowserSocket("c1", socket as never);

    await waitFor(() => {
      expect(socket.sent).toContainEqual({
        source: "bridge",
        type: "error",
        message: "Runner service is unavailable."
      });
    });
  });

  it("reports a bridge error on protocol version mismatch", async () => {
    const { url, close } = await startRunnerServer(({ ws }) => {
      ws.send(JSON.stringify({ type: "hello", protocolVersion: RUNNER_PROTOCOL_VERSION + 1 }));
    });
    cleanup.push(close);
    const client = new RunnerClient({ url });
    cleanup.push(() => client.dispose());
    const socket = new FakeBrowserSocket();

    client.attachBrowserSocket("c1", socket as never);

    await waitFor(() => {
      expect(socket.sent).toContainEqual({
        source: "bridge",
        type: "error",
        message: `Runner protocol mismatch: expected ${RUNNER_PROTOCOL_VERSION}.`
      });
    });
    await waitFor(() => {
      expect(socket.sent).not.toContainEqual({
        source: "bridge",
        type: "error",
        message: "Runner service is unavailable."
      });
    });
  });

  it("queues browser commands until the runner handshake succeeds", async () => {
    const runnerMessages: unknown[] = [];
    const { url, close } = await startRunnerServer(({ ws }) => {
      ws.on("message", (raw) => runnerMessages.push(JSON.parse(raw.toString())));
      setTimeout(() => {
        ws.send(JSON.stringify({ type: "hello", protocolVersion: RUNNER_PROTOCOL_VERSION }));
      }, 20);
    });
    cleanup.push(close);
    const client = new RunnerClient({ url });
    cleanup.push(() => client.dispose());
    const socket = new FakeBrowserSocket();

    client.attachBrowserSocket("c1", socket as never);
    client.sendBrowserMessage("c1", { type: "command", command: "list_sessions", payload: {} });

    await waitFor(() => {
      expect(socket.sent).toContainEqual({ source: "bridge", type: "ready" });
      expect(runnerMessages).toContainEqual({
        type: "client_command",
        clientId: "c1",
        command: "list_sessions",
        payload: {}
      });
    });
    expect(socket.sent).not.toContainEqual(expect.objectContaining({ source: "bridge", type: "error" }));
  });

  it("queues the first browser command that starts a new delayed runner handshake", async () => {
    const reservedServer = createServer();
    await new Promise<void>((resolve) => reservedServer.listen(0, "127.0.0.1", resolve));
    const port = (reservedServer.address() as AddressInfo).port;
    await new Promise<void>((resolve) => reservedServer.close(() => resolve()));

    const client = new RunnerClient({ url: `ws://127.0.0.1:${port}` });
    cleanup.push(() => client.dispose());
    const socket = new FakeBrowserSocket();

    client.attachBrowserSocket("c1", socket as never);
    await waitFor(() => {
      expect(socket.sent).toContainEqual({
        source: "bridge",
        type: "error",
        message: "Runner service is unavailable."
      });
    });
    socket.sent.length = 0;

    const runnerMessages: unknown[] = [];
    const { close } = await startRunnerServer(({ ws }) => {
      ws.on("message", (raw) => runnerMessages.push(JSON.parse(raw.toString())));
      setTimeout(() => {
        ws.send(JSON.stringify({ type: "hello", protocolVersion: RUNNER_PROTOCOL_VERSION }));
      }, 20);
    }, port);
    cleanup.push(async () => {
      client.dispose();
      await close();
    });

    client.sendBrowserMessage("c1", { type: "command", command: "prompt", payload: { message: "first" } });

    await waitFor(() => {
      expect(socket.sent).toContainEqual({ source: "bridge", type: "ready" });
      expect(runnerMessages).toContainEqual({
        type: "client_command",
        clientId: "c1",
        command: "prompt",
        payload: { message: "first" }
      });
    });
    expect(socket.sent).toContainEqual({
      source: "bridge",
      type: "error",
      message: "Runner service is unavailable."
    });
  });

  it("keeps a reconnect-triggering command when the old socket closes after retry starts", async () => {
    const runnerSockets: FakeRunnerSocket[] = [];
    const client = new RunnerClient({
      url: "ws://runner",
      createWebSocket: () => {
        const socket = new FakeRunnerSocket();
        runnerSockets.push(socket);
        return socket as never;
      }
    });
    cleanup.push(() => client.dispose());
    const socket = new FakeBrowserSocket();

    client.attachBrowserSocket("c1", socket as never);
    runnerSockets[0].emit("error", new Error("unavailable"));
    socket.sent.length = 0;

    client.sendBrowserMessage("c1", { type: "command", command: "prompt", payload: { message: "first" } });
    runnerSockets[0].emit("close");
    runnerSockets[1].emit("open");
    runnerSockets[1].emit("message", Buffer.from(JSON.stringify({ type: "hello", protocolVersion: RUNNER_PROTOCOL_VERSION })));

    expect(runnerSockets[1].sent).toEqual([
      { type: "hello", protocolVersion: RUNNER_PROTOCOL_VERSION },
      { type: "client_command", clientId: "c1", command: "prompt", payload: { message: "first" } }
    ]);
    expect(socket.sent).toContainEqual({ source: "bridge", type: "ready" });
  });

  it("drops queued commands when the browser disconnects before the runner handshake", async () => {
    const runnerMessages: unknown[] = [];
    const { url, close } = await startRunnerServer(({ ws }) => {
      ws.on("message", (raw) => runnerMessages.push(JSON.parse(raw.toString())));
      setTimeout(() => {
        ws.send(JSON.stringify({ type: "hello", protocolVersion: RUNNER_PROTOCOL_VERSION }));
      }, 20);
    });
    cleanup.push(close);
    const client = new RunnerClient({ url });
    cleanup.push(() => client.dispose());
    const socket = new FakeBrowserSocket();

    client.attachBrowserSocket("c1", socket as never);
    client.sendBrowserMessage("c1", { type: "command", command: "prompt", payload: { message: "gone" } });
    client.detachBrowserSocket("c1");

    await waitFor(() => {
      expect(runnerMessages).toContainEqual({ type: "hello", protocolVersion: RUNNER_PROTOCOL_VERSION });
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runnerMessages).not.toContainEqual({
      type: "client_command",
      clientId: "c1",
      command: "prompt",
      payload: { message: "gone" }
    });
  });
});

async function startRunnerServer(onConnection: (context: { ws: import("ws").WebSocket }) => void, port = 0) {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws) => onConnection({ ws }));

  await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", resolve));
  const assignedPort = (httpServer.address() as AddressInfo).port;

  return {
    url: `ws://127.0.0.1:${assignedPort}`,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close(() => httpServer.close(() => resolve()));
      })
  };
}

async function waitFor(assertion: () => void): Promise<void> {
  const started = Date.now();
  let lastError: unknown;
  while (Date.now() - started < 1000) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

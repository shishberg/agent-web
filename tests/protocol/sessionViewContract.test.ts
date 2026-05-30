/**
 * Session View backend contract tests.
 *
 * Validates that every backend (PiDirect, Verandah, HTTP/RPC) produces
 * SessionView values that satisfy the shared contract assertions.
 *
 * Done conditions:
 * - A backend returning { type: "message", message: ... } in the view fails tests.
 * - A backend returning metadata records in conversation items fails tests.
 */
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectValidSessionView,
  expectNoRawPiRecords,
} from "../helpers/sessionViewContract";
import { piSnapshotToView } from "../../src/protocol/pi-adapter";
import { createEmptySessionView } from "../../src/protocol/types";
import { PiDirectSessionManager } from "../../server/backends/piDirect/piDirectSessionManager";
import { createSessionApiHandler } from "../../server/sessionApiRoutes";
import type {
  PersistedSessionReader,
  PiProcessLike,
} from "../../server/runnerCore";
import type {
  SessionManager,
  SessionManagerCapabilities,
  SessionSnapshot,
  SessionSummary,
} from "../../src/lib/sessionApi";
import webTestSession from "../../src/protocol/fixtures/web-test-session.json";

// ── Helpers: build a valid view ──

function makeValidView(): ReturnType<typeof createEmptySessionView> {
  const view = createEmptySessionView({
    id: "contract-s1",
    title: "Contract test",
    status: "connected",
  });
  view.items = [
    {
      kind: "user",
      id: "u1",
      content: [{ type: "text", text: "Hello" }],
      timestamp: 1000,
    } as const,
    {
      kind: "assistant",
      id: "a1",
      content: [{ type: "text", text: "Hi there" }],
      timestamp: 2000,
    } as const,
  ];
  view.status = "connected";
  view.statusText = "Agent finished";
  return view;
}

// ── Helper self-tests: proving the assertions catch violations ──

describe("expectValidSessionView", () => {
  it("passes for a valid view", () => {
    const view = makeValidView();
    expectValidSessionView(view);
  });

  it("passes for an empty view", () => {
    const view = createEmptySessionView();
    expectValidSessionView(view);
  });



  it("fails when an item lacks an id", () => {
    const view = createEmptySessionView({
      id: "s1",
      title: "Test",
      status: "idle",
    });
    view.items = [{ kind: "user", content: [] }] as unknown as typeof view.items;
    expect(() => expectValidSessionView(view)).toThrow(/item\.id must be truthy/i);
  });

  it("fails when an item has an unrecognised kind", () => {
    const view = createEmptySessionView({
      id: "s1",
      title: "Test",
      status: "idle",
    });
    view.items = [
      { kind: "unknown_kind", id: "x1", content: [] },
    ] as unknown as typeof view.items;
    expect(() => expectValidSessionView(view)).toThrow(
      /item\.kind must be a recognised kind/i,
    );
  });

  it("fails when view.status is not a recognised RunStatus", () => {
    const view = makeValidView();
    (view as Record<string, unknown>).status = "bogus";
    expect(() => expectValidSessionView(view as never)).toThrow(
      /must be a recognised RunStatus/i,
    );
  });

  it("fails when view.extensionDraft is not string or null", () => {
    const view = makeValidView();
    (view as Record<string, unknown>).extensionDraft = 42;
    expect(() => expectValidSessionView(view as never)).toThrow(
      /extensionDraft must be string or null/i,
    );
  });

  it("fails when a user item lacks a content array", () => {
    const view = createEmptySessionView({
      id: "s1",
      title: "Test",
      status: "idle",
    });
    view.items = [
      { kind: "user", id: "u1" },
    ] as unknown as typeof view.items;
    expect(() => expectValidSessionView(view)).toThrow(
      /user item must have a content array/i,
    );
  });

  it("fails when an assistant item lacks a content array", () => {
    const view = createEmptySessionView({
      id: "s1",
      title: "Test",
      status: "idle",
    });
    view.items = [
      { kind: "assistant", id: "a1" },
    ] as unknown as typeof view.items;
    expect(() => expectValidSessionView(view)).toThrow(
      /assistant item must have a content array/i,
    );
  });

  it("fails when a tool item has an invalid status", () => {
    const view = createEmptySessionView({
      id: "s1",
      title: "Test",
      status: "idle",
    });
    view.items = [
      {
        kind: "tool",
        id: "t1",
        toolName: "bash",
        toolLabel: "bash",
        input: {},
        output: "",
        status: "invalid_status",
      },
    ] as unknown as typeof view.items;
    expect(() => expectValidSessionView(view)).toThrow(
      /tool item must have a valid status/i,
    );
  });

  it("fails when metadata records appear in items (backend bug)", () => {
    // Simulates a backend that leaks raw { type: "session" } records
    const view = createEmptySessionView({
      id: "s1",
      title: "Test",
      status: "idle",
    });
    view.items = [
      // Metadata record with `type` instead of `kind`
      { type: "session", id: "s1", title: "Session" },
    ] as unknown as typeof view.items;
    // `item.kind` is undefined (the record has `type` but no `kind`),
    // so toMatch() receives undefined and throws.
    expect(() => expectValidSessionView(view)).toThrow();
  });

  it("fails when raw message wrappers appear in items (backend bug)", () => {
    // Simulates a backend that returns { type: "message", message: {...} }
    const view = createEmptySessionView({
      id: "s1",
      title: "Test",
      status: "idle",
    });
    view.items = [
      {
        type: "message",
        id: "msg-1",
        message: { role: "user", content: "Hello" },
      },
    ] as unknown as typeof view.items;
    // `item.kind` is undefined (the record has `type` but no `kind`),
    // so toMatch() receives undefined and throws.
    expect(() => expectValidSessionView(view)).toThrow();
  });
});

describe("expectNoRawPiRecords", () => {
  it("passes for a valid view", () => {
    const view = makeValidView();
    expectNoRawPiRecords(view);
  });

  it("passes for an empty view", () => {
    const view = createEmptySessionView();
    expectNoRawPiRecords(view);
  });

  it("fails when an item has a raw `type` property (wrapper leak)", () => {
    // Simulates a backend that didn't unwrap { type: "message", message: {...} }
    const view = createEmptySessionView();
    view.items = [
      {
        kind: "user",
        id: "u1",
        content: [{ type: "text", text: "Hello" }],
        type: "message", // RAW PI LEAK
        message: { role: "user", content: "Hello" }, // RAW PI LEAK
      },
    ] as unknown as typeof view.items;
    expect(() => expectNoRawPiRecords(view)).toThrow(
      /item must not have a raw Pi 'type' property/i,
    );
  });

  it("fails when an item has a `message` property (wrapper leak)", () => {
    const view = createEmptySessionView();
    view.items = [
      {
        kind: "user",
        id: "u1",
        content: [{ type: "text", text: "Hello" }],
        message: { role: "user", content: "Hello" },
      },
    ] as unknown as typeof view.items;
    expect(() => expectNoRawPiRecords(view)).toThrow(
      /item must not have a nested 'message' property/i,
    );
  });

  it("fails when an item has a `responseId` property", () => {
    const view = createEmptySessionView();
    view.items = [
      {
        kind: "assistant",
        id: "a1",
        content: [{ type: "text", text: "Hi" }],
        responseId: "resp-1",
      },
    ] as unknown as typeof view.items;
    expect(() => expectNoRawPiRecords(view)).toThrow(
      /item must not have a 'responseId' property/i,
    );
  });

  it("fails when content block type is 'message' (metadata leak)", () => {
    const view = createEmptySessionView();
    view.items = [
      {
        kind: "user",
        id: "u1",
        content: [{ type: "message", message: { role: "user", content: "X" } }],
      },
    ] as unknown as typeof view.items;
    expect(() => expectNoRawPiRecords(view)).toThrow(
      /must not be a 'message' wrapper/,
    );
  });

  it("fails when content block type is 'session' (metadata leak)", () => {
    const view = createEmptySessionView();
    view.items = [
      {
        kind: "assistant",
        id: "a1",
        content: [{ type: "session", id: "s1" }],
      },
    ] as unknown as typeof view.items;
    expect(() => expectNoRawPiRecords(view)).toThrow(
      /must not be a 'session' metadata record/,
    );
  });

  it("fails when a thinking block has a forbidden type (metadata leak)", () => {
    const view = createEmptySessionView();
    view.items = [
      {
        kind: "assistant",
        id: "a1",
        content: [{ type: "text", text: "Answer" }],
        thinking: [{ type: "session", id: "meta-leak" }],
      },
    ] as unknown as typeof view.items;
    expect(() => expectNoRawPiRecords(view)).toThrow(
      /must not be a 'session' metadata record/,
    );
  });

  it("fails when a nested tool_result.content block has a forbidden type", () => {
    const view = createEmptySessionView();
    view.items = [
      {
        kind: "assistant",
        id: "a1",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: [{ type: "model_change", modelId: "leaked" }],
          },
        ],
      },
    ] as unknown as typeof view.items;
    expect(() => expectNoRawPiRecords(view)).toThrow(
      /must not be a 'model_change' metadata record/,
    );
  });

  it("passes when tool_result.content is a string (no blocks to scan)", () => {
    const view = createEmptySessionView();
    view.items = [
      {
        kind: "assistant",
        id: "a1",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "plain string result",
          },
        ],
      },
    ] as unknown as typeof view.items;
    expectNoRawPiRecords(view); // should not throw
  });

  it("fails when content block type is 'model_change' (metadata leak)", () => {
    const view = createEmptySessionView();
    view.items = [
      {
        kind: "assistant",
        id: "a1",
        content: [{ type: "model_change", modelId: "gpt-5" }],
      },
    ] as unknown as typeof view.items;
    expect(() => expectNoRawPiRecords(view)).toThrow(
      /must not be a 'model_change' metadata record/,
    );
  });
});

// ── PiSnapshotToView adapter-level contract test ──

describe("Pi adapter contract", () => {
  it("web-test-session produces a contract-valid view", () => {
    const view = piSnapshotToView(webTestSession);
    expectValidSessionView(view);
    expectNoRawPiRecords(view);
  });

  it("empty records produce a contract-valid view", () => {
    const view = piSnapshotToView([]);
    expectValidSessionView(view);
    expectNoRawPiRecords(view);
  });

  it("user + assistant records produce a contract-valid view", () => {
    const records = [
      { role: "user", content: "Hello", id: "u1" },
      { role: "assistant", content: "World", id: "a1", provider: "openai" },
    ];
    const view = piSnapshotToView(records);
    expectValidSessionView(view);
    expectNoRawPiRecords(view);
  });

  it("tool items in view pass contract checks", () => {
    const view = piSnapshotToView(webTestSession);
    // Add a mock tool item
    view.items.push({
      kind: "tool",
      id: "tool-1",
      toolName: "bash",
      toolLabel: "bash",
      detail: "ls -la",
      input: { command: "ls" },
      output: "file listing",
      status: "done",
    });
    expectValidSessionView(view);
    expectNoRawPiRecords(view);
  });

  it("system notice items pass contract checks", () => {
    const view = piSnapshotToView(webTestSession);
    view.items.push({
      kind: "notice",
      id: "notice-1",
      text: "Session compacted",
      noticeType: "compaction",
    });
    expectValidSessionView(view);
    expectNoRawPiRecords(view);
  });
});

// ── PiDirectSessionManager contract test ──

// Fake Pi process for PiDirectSessionManager
class FakePiProcess extends EventEmitter implements PiProcessLike {
  readonly starts: unknown[] = [];
  readonly sent: Record<string, unknown>[] = [];
  stopped = false;

  start(_config: unknown): void {}
  send(value: Record<string, unknown>): void {
    this.sent.push(value);
  }
  stop(): void {
    this.stopped = true;
  }
}

describe("PiDirectSessionManager contract", () => {
  let process: FakePiProcess;
  let processes: FakePiProcess[];
  let listSessions: ReturnType<typeof vi.fn>;
  let openSession: ReturnType<typeof vi.fn>;
  let manager: PiDirectSessionManager;

  beforeEach(() => {
    process = new FakePiProcess();
    processes = [process];
    listSessions = vi.fn().mockResolvedValue([]);
    openSession = vi.fn().mockReturnValue({
      buildSessionContext: () => ({
        messages: [
          { role: "user", content: "hello", id: "u1" },
          { role: "assistant", content: "Hi there", id: "a1", provider: "anthropic", model: "claude" },
        ],
        model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
      }),
      getSessionId: () => "contract-session-id",
      getSessionFile: () => "/tmp/pi/contract-session.jsonl",
      getCwd: () => "/repo",
      getSessionName: () => "Contract session",
      getHeader: () => ({
        type: "session",
        id: "contract-session-id",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/repo",
      }),
    } satisfies PersistedSessionReader);

    manager = new PiDirectSessionManager({
      cwd: "/repo",
      sessionDir: "/tmp/pi",
      createPiProcess: () => {
        const next = processes.find(
          (c) => c.starts.length === 0 && c.sent.length === 0,
        );
        if (next) return next;
        const created = new FakePiProcess();
        processes.push(created);
        return created;
      },
      listSessions,
      openSession,
    });
  });

  it("openSession snapshot view passes contract checks", async () => {
    listSessions.mockResolvedValue([{
      id: "contract-session-id",
      path: "/tmp/pi/contract-session.jsonl",
      title: "Contract session",
      created: "2026-05-20T00:00:00.000Z",
      modified: "2026-05-21T00:00:00.000Z",
      messageCount: 2,
      firstMessage: "hello",
    }]);

    await manager.listSessions();
    const snapshot = await manager.openSession("contract-session-id");

    expectValidSessionView(snapshot.view);
    expectNoRawPiRecords(snapshot.view);
  });

  it("snapshot view has correct structure", async () => {
    listSessions.mockResolvedValue([{
      id: "contract-session-id",
      path: "/tmp/pi/contract-session.jsonl",
      title: "Contract session",
      created: "2026-05-20T00:00:00.000Z",
      modified: "2026-05-21T00:00:00.000Z",
      messageCount: 2,
      firstMessage: "hello",
    }]);

    await manager.listSessions();
    const snapshot = await manager.openSession("contract-session-id");

    expect(snapshot.session.id).toBe("contract-session-id");
    expect(snapshot.view.items).toHaveLength(2);
    expect(snapshot.view.items[0].kind).toBe("user");
    expect(snapshot.view.items[1].kind).toBe("assistant");
  });

  it("openSession with wrapped Pi records produces a clean view", async () => {
    // Simulates backend returning wrapped { type: "message", message: {...} } records
    openSession.mockReturnValue({
      buildSessionContext: () => ({
        messages: [
          { type: "session", id: "s1", cwd: "/repo" },
          { type: "model_change", modelId: "claude" },
          {
            type: "message",
            id: "rec-1",
            message: { role: "user", content: "Question?" },
          },
          {
            type: "message",
            id: "rec-2",
            message: { role: "assistant", content: "Answer." },
          },
        ],
        model: { provider: "anthropic", modelId: "claude" },
      }),
      getSessionId: () => "wrapped-session-id",
      getSessionFile: () => "/tmp/pi/wrapped.jsonl",
      getCwd: () => "/repo",
      getSessionName: () => "Wrapped session",
      getHeader: () => ({ type: "session", id: "wrapped-session-id" }),
    } satisfies PersistedSessionReader);

    listSessions.mockResolvedValue([{
      id: "wrapped-session-id",
      path: "/tmp/pi/wrapped.jsonl",
      title: "Wrapped session",
      created: "2026-05-20T00:00:00.000Z",
      modified: "2026-05-21T00:00:00.000Z",
      messageCount: 4,
      firstMessage: "Question?",
    }]);

    await manager.listSessions();
    const snapshot = await manager.openSession("wrapped-session-id");

    // The adapter must strip metadata records and unwrap messages
    expect(snapshot.view.items).toHaveLength(2);
    expectValidSessionView(snapshot.view);
    expectNoRawPiRecords(snapshot.view);
  });
});

// ── HTTP/RPC route contract test (/api/sessions/:id) ──

describe("HTTP API /api/sessions/:id contract", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await closeServer(servers.pop()!);
    }
  });

  function makeContractView(): SessionSnapshot["view"] {
    return {
      session: { id: "s1", title: "Contract", status: "running" },
      items: [
        {
          kind: "user",
          id: "u1",
          content: [{ type: "text", text: "Hello" }],
          timestamp: 1000,
        },
        {
          kind: "assistant",
          id: "a1",
          content: [{ type: "text", text: "Hi there" }],
          timestamp: 2000,
        },
      ],
      status: "connected",
      statusText: "Agent finished",
      pendingRequests: [],
      extensionDraft: null,
      cursor: "evt-3",
    };
  }

  async function startServer(
    manager: SessionManager,
  ): Promise<{ url: string }> {
    const handleApi = createSessionApiHandler({ manager });
    const server = createServer(async (req, res) => {
      if (await handleApi(req, res)) return;
      res.writeHead(404);
      res.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${address.port}` };
  }

  it("GET /api/sessions/:id returns a contract-valid view over HTTP", async () => {
    const validView = makeContractView();
    const snapshot: SessionSnapshot = {
      session: { id: "s1", title: "Contract", status: "running" },
      view: validView,
      streamCursor: "evt-3",
    };

    const manager = mockSessionManager({
      openSession: vi.fn().mockResolvedValue(snapshot),
    });
    const { url } = await startServer(manager);

    const response = await fetch(`${url}/api/sessions/s1`);
    expect(response.status).toBe(200);

    const body = await response.json();
    const view = body.view;

    expectValidSessionView(view);
    expectNoRawPiRecords(view);
  });

  it("HTTP response view preserves items across serialization", async () => {
    const validView = makeContractView();
    const snapshot: SessionSnapshot = {
      session: { id: "s1", title: "Contract", status: "running" },
      view: validView,
      streamCursor: "evt-3",
    };

    const manager = mockSessionManager({
      openSession: vi.fn().mockResolvedValue(snapshot),
    });
    const { url } = await startServer(manager);

    const response = await fetch(`${url}/api/sessions/s1`);
    const body = await response.json();

    expect(body.view.items).toHaveLength(2);
    expect(body.view.items[0].kind).toBe("user");
    expect(body.view.items[1].kind).toBe("assistant");
    expect(body.view.cursor).toBe("evt-3");
  });

  it("HTTP response rejects view with wrapper leak", async () => {
    // Simulate a backend bug that returns raw Pi wrappers in the view.
    // The HTTP route should still return the data as-is (it doesn't validate),
    // but our contract assertion must catch the leak.
    const view = makeContractView();
    // Mutate the view to contain a raw Pi wrapper leak
    (view.items[0] as Record<string, unknown>).type = "message";
    (view.items[0] as Record<string, unknown>).message = {
      role: "user",
      content: "Hello",
    };

    const snapshot: SessionSnapshot = {
      session: { id: "s1", title: "Contract", status: "running" },
      view,
      streamCursor: "",
    };

    const manager = mockSessionManager({
      openSession: vi.fn().mockResolvedValue(snapshot),
    });
    const { url } = await startServer(manager);

    const response = await fetch(`${url}/api/sessions/s1`);
    const body = await response.json();

    // The contract assertion must catch the leaked wrapper
    expect(() => expectNoRawPiRecords(body.view)).toThrow(
      /item must not have a raw Pi 'type' property/,
    );
  });

  it("HTTP response rejects view with metadata records in items", async () => {
    // Simulate a backend bug that leaks metadata records as items
    const view = makeContractView();
    (view.items as unknown[]).push({
      type: "session",
      id: "s1",
      title: "metatadata leak",
      kind: "notice", // partial, but still has type
    });

    const snapshot: SessionSnapshot = {
      session: { id: "s1", title: "Contract", status: "running" },
      view,
      streamCursor: "",
    };

    const manager = mockSessionManager({
      openSession: vi.fn().mockResolvedValue(snapshot),
    });
    const { url } = await startServer(manager);

    const response = await fetch(`${url}/api/sessions/s1`);
    const body = await response.json();

    // The contract assertion must catch the metadata leak
    expect(() => expectNoRawPiRecords(body.view)).toThrow(
      /item must not have a raw Pi 'type' property/,
    );
  });

  it("HTTP response preserves tool items contract", async () => {
    const view = makeContractView();
    view.items.push({
      kind: "tool",
      id: "tool-1",
      toolName: "bash",
      toolLabel: "bash",
      detail: "ls -la",
      input: { command: "ls" },
      output: "file listing",
      status: "done",
    });

    const snapshot: SessionSnapshot = {
      session: { id: "s1", title: "Contract", status: "running" },
      view,
      streamCursor: "",
    };

    const manager = mockSessionManager({
      openSession: vi.fn().mockResolvedValue(snapshot),
    });
    const { url } = await startServer(manager);

    const response = await fetch(`${url}/api/sessions/s1`);
    const body = await response.json();

    expectValidSessionView(body.view);
    expectNoRawPiRecords(body.view);
    expect(body.view.items).toHaveLength(3);
    expect(body.view.items[2].kind).toBe("tool");
  });

  it("HTTP response preserves system notice items contract", async () => {
    const view = makeContractView();
    view.items.push({
      kind: "notice",
      id: "notice-1",
      text: "Session compacted",
      noticeType: "compaction",
    });

    const snapshot: SessionSnapshot = {
      session: { id: "s1", title: "Contract", status: "running" },
      view,
      streamCursor: "",
    };

    const manager = mockSessionManager({
      openSession: vi.fn().mockResolvedValue(snapshot),
    });
    const { url } = await startServer(manager);

    const response = await fetch(`${url}/api/sessions/s1`);
    const body = await response.json();

    expectValidSessionView(body.view);
    expectNoRawPiRecords(body.view);
  });
});

// ── Verandah-style backend contract test ──

describe("Verandah-style backend (HTTP/RPC) contract", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    while (servers.length > 0) {
      await closeServer(servers.pop()!);
    }
  });

  async function startServer(
    manager: SessionManager,
  ): Promise<{ url: string }> {
    const handleApi = createSessionApiHandler({ manager });
    const server = createServer(async (req, res) => {
      if (await handleApi(req, res)) return;
      res.writeHead(404);
      res.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${address.port}` };
  }

  function makeVerandahView(): SessionSnapshot["view"] {
    return {
      session: { id: "vh-1", title: "Verandah session", status: "running" },
      items: [
        {
          kind: "user",
          id: "vh-user-1",
          content: [{ type: "text", text: "Solve this problem" }],
          timestamp: 1000,
        },
        {
          kind: "assistant",
          id: "vh-assistant-1",
          content: [
            { type: "text", text: "Here is the solution." },
          ],
          thinking: [{ type: "thinking", thinking: "Let me analyze this." }],
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          usage: { inputTokens: 50, outputTokens: 200 },
          timestamp: 2000,
        },
        {
          kind: "tool",
          id: "vh-tool-1",
          toolName: "read",
          toolLabel: "read",
          detail: "/path/to/file.ts",
          input: { path: "/path/to/file.ts" },
          output: "file contents here",
          status: "done",
        },
      ],
      status: "running",
      statusText: "Agent running",
      pendingRequests: [],
      extensionDraft: null,
      cursor: "evt-10",
    };
  }

  it("Verandah-style snapshot passes contract (normal path)", async () => {
    const view = makeVerandahView();
    const snapshot: SessionSnapshot = {
      session: { id: "vh-1", title: "Verandah session", status: "running" },
      view,
      streamCursor: "evt-10",
      metadata: { projectId: "proj-1" },
    };

    const manager = mockSessionManager({
      openSession: vi.fn().mockResolvedValue(snapshot),
    });
    const { url } = await startServer(manager);

    const response = await fetch(`${url}/api/sessions/vh-1`);
    expect(response.status).toBe(200);

    const body = await response.json();
    expectValidSessionView(body.view);
    expectNoRawPiRecords(body.view);

    // Verify structure survived serialization
    expect(body.session.id).toBe("vh-1");
    expect(body.view.items).toHaveLength(3);
    expect(body.view.items[1].kind).toBe("assistant");
    if (body.view.items[1].kind === "assistant") {
      expect(body.view.items[1].thinking).toHaveLength(1);
      expect(body.view.items[1].provider).toBe("anthropic");
      expect(body.view.items[1].model).toBe("claude-sonnet-4-5");
      expect(body.view.items[1].usage).toEqual({ inputTokens: 50, outputTokens: 200 });
    }
    expect(body.streamCursor).toBe("evt-10");
    expect(body.metadata).toEqual({ projectId: "proj-1" });
  });

  it("Verandah-style view with wrapper leak is caught", async () => {
    // Simulate a Verandah bug: raw Pi wrapper not unwrapped
    const view = makeVerandahView();
    // Replace the first item with a raw wrapped record
    (view.items as unknown[])[0] = {
      type: "message",
      message: { role: "user", content: "Solve this problem" },
      kind: "user",
      id: "vh-user-1",
    };

    const snapshot: SessionSnapshot = {
      session: { id: "vh-1", title: "Verandah session", status: "running" },
      view,
      streamCursor: "",
    };

    const manager = mockSessionManager({
      openSession: vi.fn().mockResolvedValue(snapshot),
    });
    const { url } = await startServer(manager);

    const response = await fetch(`${url}/api/sessions/vh-1`);
    const body = await response.json();

    // Contract must catch the wrapper leak
    expect(() => expectNoRawPiRecords(body.view)).toThrow();
  });

  it("Verandah-style view with metadata leak is caught", async () => {
    // Simulate a Verandah bug: metadata record leaked into conversation items
    const view = makeVerandahView();
    (view.items as unknown[]).splice(1, 0, {
      type: "model_change",
      modelId: "claude-sonnet-4-5",
      id: "meta-1",
      kind: "notice",
      noticeType: "model_change",
      text: "Model changed",
    });

    const snapshot: SessionSnapshot = {
      session: { id: "vh-1", title: "Verandah session", status: "running" },
      view,
      streamCursor: "",
    };

    const manager = mockSessionManager({
      openSession: vi.fn().mockResolvedValue(snapshot),
    });
    const { url } = await startServer(manager);

    const response = await fetch(`${url}/api/sessions/vh-1`);
    const body = await response.json();

    // Contract must catch the metadata leak (the `type` property on the item)
    expect(() => expectNoRawPiRecords(body.view)).toThrow();
  });

  it("Verandah-style view with empty session passes contract", async () => {
    const view = {
      session: { id: "vh-empty", title: "New Verandah session", status: "idle" as const },
      items: [],
      status: "idle" as const,
      statusText: "No messages yet",
      pendingRequests: [],
      extensionDraft: null,
      cursor: "",
    };

    const snapshot: SessionSnapshot = {
      session: { id: "vh-empty", title: "New Verandah session", status: "idle" },
      view,
      streamCursor: "",
    };

    const manager = mockSessionManager({
      openSession: vi.fn().mockResolvedValue(snapshot),
    });
    const { url } = await startServer(manager);

    const response = await fetch(`${url}/api/sessions/vh-empty`);
    const body = await response.json();

    expectValidSessionView(body.view);
    expectNoRawPiRecords(body.view);
    expect(body.view.items).toHaveLength(0);
  });
});

// ── Mock helpers ──

const baseCapabilities: SessionManagerCapabilities = {
  createSession: true,
  deleteSession: false,
  stopSession: true,
  setSessionMetadata: false,
  sendMessage: true,
  respondToUserRequest: true,
  backgroundSessions: false,
};

function mockSessionManager(
  overrides: Partial<SessionManager> = {},
): SessionManager {
  return {
    capabilities: { ...baseCapabilities },
    listSessions: vi.fn().mockResolvedValue([]),
    createSession: vi.fn().mockResolvedValue({
      id: "s1",
      title: "",
      status: "idle",
    } satisfies SessionSummary),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    openSession: vi.fn().mockResolvedValue({
      session: { id: "s1", title: "", status: "idle" },
      view: {
        session: { id: "s1", title: "", status: "idle" },
        items: [],
        status: "idle",
        statusText: "",
        pendingRequests: [],
        extensionDraft: null,
        cursor: "",
      },
      streamCursor: "",
    } satisfies SessionSnapshot),
    sendMessage: vi.fn().mockResolvedValue({ queued: false }),
    stopSession: vi.fn().mockResolvedValue(undefined),
    respondToUserRequest: vi.fn().mockResolvedValue(undefined),
    subscribeToSession: vi.fn(() => vi.fn()),
    subscribeToSessionList: vi.fn(() => vi.fn()),
    openAndSubscribeSession: vi.fn().mockResolvedValue({
      snapshot: {
        session: { id: "s1", title: "", status: "idle" },
        view: {
          session: { id: "s1", title: "", status: "idle" },
          items: [],
          status: "idle",
          statusText: "",
          pendingRequests: [],
          extensionDraft: null,
          cursor: "",
        },
        streamCursor: "",
      },
      unsubscribe: vi.fn(),
    }),
    ...overrides,
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

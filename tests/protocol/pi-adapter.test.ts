import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { piSnapshotToView, piStreamEventToPatch } from "../../src/protocol/pi-adapter";
import { applyViewPatch } from "../../src/protocol/view-reducer";
import { createEmptySessionView } from "../../src/protocol/types";
import type { ConversationItem, SessionView } from "../../src/protocol/types";
import webTestSession from "../../src/protocol/fixtures/web-test-session.json";

// ── Fixture helpers ──

function agentFailureFixture(): Record<string, unknown>[] {
  const fixturePath = path.resolve(
    __dirname,
    "../../src/protocol/fixtures/agent-failure-stream.jsonl",
  );
  const raw = fs.readFileSync(fixturePath, "utf-8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ── Snapshot adapter tests ──

describe("piSnapshotToView", () => {
  it("converts web-test-session into a valid SessionView", () => {
    const view = piSnapshotToView(webTestSession);

    // Session summary extracted from metadata record
    expect(view.session.id).toBe("session-web-test");
    expect(view.session.title).toBe("web-test");

    // Two conversation items (1 user + 1 assistant)
    expect(view.items).toHaveLength(2);

    // First item: user message
    const userItem = view.items[0];
    expect(userItem.kind).toBe("user");
    expect(userItem.id).toBe("record-user-1");

    // Second item: assistant message
    const assistantItem = view.items[1];
    expect(assistantItem.kind).toBe("assistant");
    expect(assistantItem.id).toBe("record-assistant-1");
    if (assistantItem.kind === "assistant") {
      expect(assistantItem.provider).toBe("anthropic");
      expect(assistantItem.model).toBe("claude-sonnet-4-5");
    }

    // Status derived from items presence
    expect(view.status).toBe("connected");
    expect(view.statusText).toBe("Session loaded");
  });

  it("produces items without raw Pi wrapping shapes", () => {
    const view = piSnapshotToView(webTestSession);
    for (const item of view.items) {
      // No raw Pi shapes leaked
      expect(item).not.toHaveProperty("type");
      expect(item).not.toHaveProperty("message");
      expect(item).not.toHaveProperty("responseId");
      // Every item has kind and id
      expect(item.kind).toMatch(/^(user|assistant|tool|notice)$/);
      expect(item.id).toBeTruthy();
    }
  });

  it("extracts text content from user message", () => {
    const view = piSnapshotToView(webTestSession);
    const userItem = view.items[0];
    expect(userItem.kind).toBe("user");
    if (userItem.kind === "user") {
      expect(userItem.content).toHaveLength(1);
      expect(userItem.content[0]).toHaveProperty("text");
    }
  });

  it("extracts text content from assistant message", () => {
    const view = piSnapshotToView(webTestSession);
    const assistantItem = view.items[1];
    expect(assistantItem.kind).toBe("assistant");
    if (assistantItem.kind === "assistant") {
      expect(assistantItem.content).toHaveLength(1);
      expect(assistantItem.content[0]).toHaveProperty("text");
    }
  });

  it("returns empty view for empty records", () => {
    const view = piSnapshotToView([]);
    expect(view.items).toHaveLength(0);
    expect(view.status).toBe("idle");
    expect(view.statusText).toBe("No messages yet");
  });

  it("skips non-message metadata records", () => {
    const records = [
      { type: "session", id: "s1", title: "Test" },
      { type: "model_change", modelId: "gpt-5" },
      {
        type: "message",
        id: "r1",
        message: {
          role: "user",
          content: [{ type: "text", text: "Hi" }],
        },
      },
    ];

    const view = piSnapshotToView(records);
    expect(view.items).toHaveLength(1);
    expect(view.items[0].kind).toBe("user");
  });

  it("handles already-normalized messages (no wrapper)", () => {
    const records = [
      { role: "user", content: "Hello", id: "u1" },
      { role: "assistant", content: "World", id: "a1", provider: "openai" },
    ];

    const view = piSnapshotToView(records);
    expect(view.items).toHaveLength(2);
    expect(view.items[1].kind).toBe("assistant");
    if (view.items[1].kind === "assistant") {
      expect(view.items[1].provider).toBe("openai");
    }
  });

  it("handles string content", () => {
    const records = [
      { role: "user", content: "Plain string", id: "u1" },
      { role: "assistant", content: "Response string", id: "a1" },
    ];

    const view = piSnapshotToView(records);
    expect(view.items).toHaveLength(2);
    const userItem = view.items[0];
    expect(userItem.kind).toBe("user");
    if (userItem.kind === "user") {
      expect(userItem.content).toEqual([{ type: "text", text: "Plain string" }]);
    }
  });

  it("handles assistant content with thinking blocks", () => {
    const records = [
      {
        role: "assistant",
        id: "a1",
        content: [
          { type: "thinking", thinking: "Let me check." },
          { type: "text", text: "Here's the answer." },
        ],
      },
    ];

    const view = piSnapshotToView(records);
    expect(view.items).toHaveLength(1);
    const item = view.items[0];
    expect(item.kind).toBe("assistant");
    if (item.kind === "assistant") {
      expect(item.content).toEqual([{ type: "text", text: "Here's the answer." }]);
      expect(item.thinking).toEqual([{ type: "thinking", thinking: "Let me check." }]);
    }
  });

  it("preserves wrapper-level id and timestamp as fallbacks", () => {
    const records = [
      {
        type: "message",
        id: "wrapper-id",
        timestamp: 9999,
        message: { role: "user", content: "Hello" },
      },
    ];

    const view = piSnapshotToView(records);
    expect(view.items[0].id).toBe("wrapper-id");
    expect(view.items[0].timestamp).toBe(9999);
  });
});

// ── Stream event adapter tests ──

describe("piStreamEventToPatch", () => {
  it("returns null for turn lifecycle events", () => {
    expect(piStreamEventToPatch({ type: "turn_start" })).toBeNull();
    expect(piStreamEventToPatch({ type: "turn_end" })).toBeNull();
  });

  it("returns setStatus for agent_start", () => {
    const patch = piStreamEventToPatch({ type: "agent_start" });
    expect(patch).toEqual({
      type: "setStatus",
      status: "running",
      statusText: "Agent running",
    });
  });

  it("returns setStatus for agent_end (normal completion)", () => {
    const patch = piStreamEventToPatch({ type: "agent_end" });
    expect(patch).toEqual({
      type: "setStatus",
      status: "connected",
      statusText: "Agent finished",
    });
  });

  it("returns null for agent_end when willRetry is true (let auto_retry_start handle it)", () => {
    const patch = piStreamEventToPatch({
      type: "agent_end",
      willRetry: true,
    });
    expect(patch).toBeNull();
  });

  it("returns setStatus failed for agent_end with failure indicator", () => {
    const event = {
      type: "agent_end",
      messages: [
        { role: "assistant", stopReason: "error", content: [{ type: "text", text: "Failed." }] },
      ],
      willRetry: false,
    };

    const patch = piStreamEventToPatch(event);
    expect(patch).toEqual({
      type: "setStatus",
      status: "failed",
      statusText: "Agent error",
    });
  });

  it("returns setStatus failed for agent_end with success:false", () => {
    const patch = piStreamEventToPatch({
      type: "agent_end",
      success: false,
      willRetry: false,
    });
    expect(patch).toMatchObject({
      type: "setStatus",
      status: "failed",
    });
  });

  it("returns setStatus failed for agent_end with errorMessage", () => {
    const patch = piStreamEventToPatch({
      type: "agent_end",
      errorMessage: "Provider rate limit exceeded",
      willRetry: false,
    });
    expect(patch).toMatchObject({
      type: "setStatus",
      status: "failed",
      statusText: "Provider rate limit exceeded",
    });
  });

  it("returns setStatus failed when current state is already failed", () => {
    const state = createEmptySessionView();
    state.status = "failed";
    state.statusText = "Error";

    const patch = piStreamEventToPatch(
      { type: "agent_end", willRetry: false },
      state,
    );
    expect(patch).toMatchObject({
      type: "setStatus",
      status: "failed",
    });
  });

  it("guards fire-and-forget notifications when status is blocked", () => {
    const state = createEmptySessionView();
    state.status = "blocked";
    state.statusText = "Waiting for input";

    const patch = piStreamEventToPatch(
      {
        type: "extension_ui_request",
        id: "notif-1",
        method: "setStatus",
        params: { statusText: "Indexing" },
      },
      state,
    );

    // Should return null — don't clobber a terminal state at all
    expect(patch).toBeNull();
  });

  it("guards fire-and-forget notifications when status is failed", () => {
    const state = createEmptySessionView();
    state.status = "failed";
    state.statusText = "Provider rate limit exceeded";

    const patch = piStreamEventToPatch(
      {
        type: "extension_ui_request",
        id: "notif-1",
        method: "notify",
        params: { message: "Something happened" },
      },
      state,
    );

    // Returns null — preserves existing statusText rather than overwriting
    expect(patch).toBeNull();
  });

  it("returns appendItem for message_start with id", () => {
    const event = {
      type: "message_start",
      message: { id: "a1", role: "assistant" },
    };

    const patch = piStreamEventToPatch(event);
    expect(patch).toMatchObject({
      type: "appendItem",
      item: {
        id: "a1",
        kind: "assistant",
      },
    });
  });

  it("synthesizes id for id-less message_start via normalizeStreamEvent", () => {
    const event = {
      type: "message_start",
      message: { role: "assistant", timestamp: 1717100000001, responseId: "turn-1" },
    };

    const patch = piStreamEventToPatch(event);
    expect(patch).toMatchObject({
      type: "appendItem",
      item: {
        id: "pi:assistant:timestamp:1717100000001",
        kind: "assistant",
      },
    });
  });

  it("returns updateItem for message_update (message.content present)", () => {
    const event = {
      type: "message_update",
      message: { id: "a1", role: "assistant", content: "Hello" },
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    };

    const patch = piStreamEventToPatch(event);
    expect(patch).toMatchObject({
      type: "updateItem",
      id: "a1",
      partial: {
        kind: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
    });
  });

  it("returns updateItem for message_update with delta-only (no message.content)", () => {
    // Real Pi streams always carry message.content, but handle the edge case
    // where only assistantMessageEvent.delta is present.
    const event = {
      type: "message_update",
      message: { id: "a1", role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    };

    const patch = piStreamEventToPatch(event);
    expect(patch).toMatchObject({
      type: "updateItem",
      id: "a1",
      partial: {
        kind: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
    });
  });

  it("returns updateItem for message_update with thinking delta", () => {
    const event = {
      type: "message_update",
      message: { id: "a1", role: "assistant" },
      assistantMessageEvent: { type: "thinking_delta", thinking: "Hmm" },
    };

    const patch = piStreamEventToPatch(event);
    expect(patch).toMatchObject({
      type: "updateItem",
      id: "a1",
      partial: {
        kind: "assistant",
        thinking: [{ type: "thinking", thinking: "Hmm" }],
      },
    });
  });

  it("extracts text from nested content_block_delta", () => {
    const event = {
      type: "message_update",
      message: { id: "a1", role: "assistant" },
      assistantMessageEvent: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "nested text" },
      },
    };

    const patch = piStreamEventToPatch(event);
    expect(patch).toMatchObject({
      type: "updateItem",
      partial: {
        content: [{ type: "text", text: "nested text" }],
      },
    });
  });

  it("does not mutate the caller's event object", () => {
    const event = {
      type: "message_start",
      message: { role: "assistant", timestamp: 1717100000001 },
    };
    const original = JSON.parse(JSON.stringify(event));
    piStreamEventToPatch(event);
    // The original should be unchanged
    expect(event).toEqual(original);
  });

  it("returns updateItem for message_end", () => {
    const event = {
      type: "message_end",
      message: {
        id: "a1",
        role: "assistant",
        content: [{ type: "text", text: "Done." }],
      },
    };

    const patch = piStreamEventToPatch(event);
    expect(patch).toMatchObject({
      type: "updateItem",
      id: "a1",
      partial: {
        kind: "assistant",
        content: [{ type: "text", text: "Done." }],
      },
    });
  });

  it("returns appendItem for tool_execution_start", () => {
    const event = {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "pwd" },
    };

    const patch = piStreamEventToPatch(event);
    expect(patch).toMatchObject({
      type: "appendItem",
      item: {
        id: "tool-1",
        kind: "tool",
        toolName: "bash",
        status: "running",
      },
    });
  });

  it("returns updateItem for tool_execution_end with done status", () => {
    const event = {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "/tmp" }] },
    };

    const patch = piStreamEventToPatch(event);
    expect(patch).toMatchObject({
      type: "updateItem",
      id: "tool-1",
      partial: {
        kind: "tool",
        status: "done",
      },
    });
  });

  it("returns updateItem with error status for failed tools", () => {
    const event = {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "bash",
      result: { isError: true, content: [{ type: "text", text: "command not found" }] },
    };

    const patch = piStreamEventToPatch(event);
    expect(patch).toMatchObject({
      type: "updateItem",
      id: "tool-1",
      partial: {
        kind: "tool",
        status: "error",
      },
    });
  });

  it("returns null for tool events without toolCallId", () => {
    expect(
      piStreamEventToPatch({
        type: "tool_execution_start",
        toolName: "bash",
      }),
    ).toBeNull();

    expect(
      piStreamEventToPatch({
        type: "tool_execution_end",
        toolName: "bash",
      }),
    ).toBeNull();
  });

  it("drops fire-and-forget extension events as setStatus patches", () => {
    const patch = piStreamEventToPatch({
      type: "extension_ui_request",
      id: "notif-1",
      method: "setStatus",
      params: { statusText: "Indexing files 25%" },
    });

    expect(patch).toMatchObject({
      type: "setStatus",
      status: "running",
      statusText: "Indexing files 25%",
    });
  });

  it("emits setPendingRequest for blocking extension events (e.g. confirm)", () => {
    const patch = piStreamEventToPatch({
      type: "extension_ui_request",
      id: "confirm-1",
      method: "confirm",
      params: {
        title: "Run command?",
        message: "Pi wants to run: rm -rf /tmp/test",
      },
    });

    expect(patch).toMatchObject({
      type: "setPendingRequest",
      request: {
        id: "confirm-1",
        method: "confirm",
        params: {
          title: "Run command?",
          message: "Pi wants to run: rm -rf /tmp/test",
        },
      },
    });
  });

  it("handles set_editor_text extension as extension draft patch", () => {
    const patch = piStreamEventToPatch({
      type: "set_editor_text",
      text: "draft content",
    });

    expect(patch).toMatchObject({
      type: "setExtensionDraft",
      text: "draft content",
    });
  });

  it("handles set_editor_text via extension_ui_request as extension draft patch", () => {
    // The fixture shape from extension-notifications.jsonl
    const patch = piStreamEventToPatch({
      type: "extension_ui_request",
      id: "editor-1",
      method: "set_editor_text",
      params: { text: "draft content here" },
    });

    expect(patch).toMatchObject({
      type: "setExtensionDraft",
      text: "draft content here",
    });
  });

  it("returns status patches for compaction events", () => {
    const start = piStreamEventToPatch({ type: "compaction_start" });
    expect(start).toMatchObject({ type: "setStatus", statusText: "Compacting session" });

    const end = piStreamEventToPatch({ type: "compaction_end" });
    expect(end).toMatchObject({ type: "setStatus", statusText: "Compaction complete" });
  });

  it("returns status patches for auto_retry events", () => {
    const start = piStreamEventToPatch({ type: "auto_retry_start" });
    expect(start).toMatchObject({ type: "setStatus", statusText: "Auto retry running" });

    const end = piStreamEventToPatch({ type: "auto_retry_end" });
    expect(end).toMatchObject({ type: "setStatus", statusText: "Auto retry finished" });
  });

  it("returns failed for auto_retry_end with success:false", () => {
    const patch = piStreamEventToPatch({
      type: "auto_retry_end",
      success: false,
      finalError: "All retry attempts exhausted",
    });
    expect(patch).toEqual({
      type: "setStatus",
      status: "failed",
      statusText: "All retry attempts exhausted",
    });
  });

  it("returns null for auto_retry_end when state is already failed", () => {
    const state = createEmptySessionView();
    state.status = "failed";

    const patch = piStreamEventToPatch({ type: "auto_retry_end" }, state);
    expect(patch).toBeNull();
  });

  it("returns null for agent_end when current state is blocked", () => {
    const state = createEmptySessionView();
    state.status = "blocked";

    const patch = piStreamEventToPatch(
      { type: "agent_end", willRetry: false },
      state,
    );
    expect(patch).toBeNull();
  });

  it("returns null for agent_end when current state is stopped", () => {
    const state = createEmptySessionView();
    state.status = "stopped";

    const patch = piStreamEventToPatch(
      { type: "agent_end", willRetry: false },
      state,
    );
    expect(patch).toBeNull();
  });

  it("detects failure from last assistant message even when followed by non-assistant", () => {
    // messages array ends with a tool_result, but the last assistant
    // message (index 1) carries stopReason: "error"
    const patch = piStreamEventToPatch({
      type: "agent_end",
      willRetry: false,
      messages: [
        { role: "user", content: "Run the command" },
        { role: "assistant", content: "Failed.", stopReason: "error", errorMessage: "command not found" },
        { role: "tool", result: "some output" },
      ],
    });
    expect(patch).toMatchObject({
      type: "setStatus",
      status: "failed",
      statusText: "command not found",
    });
  });

  it("returns null for unknown event types", () => {
    expect(piStreamEventToPatch({ type: "unknown_event" })).toBeNull();
    expect(piStreamEventToPatch({})).toBeNull();
  });

  it("skips user message lifecycle events", () => {
    const patch = piStreamEventToPatch({
      type: "message_start",
      message: { id: "u1", role: "user", content: "Hello" },
    });
    // User messages are not conversation items from stream events
    // The adapter returns null for user events since users are rendered from local state
    expect(patch).toBeNull();
  });
});

// ── Integration: snapshot + stream replay ──

describe("snapshot + stream integration", () => {
  it("replays id-less assistant stream and accumulates content from deltas", () => {
    let view = createEmptySessionView();

    // Simulate stream events without message.id and without message.content —
    // only assistantMessageEvent.delta carries text.
    const events = [
      { type: "agent_start" },
      {
        type: "message_start",
        message: { role: "assistant", timestamp: 1717100000001, responseId: "turn-1" },
      },
      {
        type: "message_update",
        message: { role: "assistant", timestamp: 1717100000001, responseId: "turn-1" },
        assistantMessageEvent: { type: "text_delta", delta: "Hello" },
      },
      {
        type: "message_update",
        message: { role: "assistant", timestamp: 1717100000001, responseId: "turn-1" },
        assistantMessageEvent: { type: "text_delta", delta: " world." },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          timestamp: 1717100000001,
          responseId: "turn-1",
          content: [{ type: "text", text: "Hello world." }],
        },
      },
      { type: "agent_end" },
    ];

    for (const event of events) {
      const patch = piStreamEventToPatch(event);
      if (patch) {
        view = applyViewPatch(view, patch);
      }
    }

    expect(view.items).toHaveLength(1);
    expect(view.items[0].kind).toBe("assistant");
    expect(view.items[0].id).toBe("pi:assistant:timestamp:1717100000001");
    expect(view.status).toBe("connected");

    const msg = view.items[0] as ConversationItem & { content: { type: string; text: string }[] };
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0].type).toBe("text");
    expect(msg.content[0].text).toBe("Hello world.");
  });

  it("replays tool stream and produces tool items", () => {
    let view = createEmptySessionView();

    const events = [
      { type: "agent_start" },
      {
        type: "message_start",
        message: { id: "assistant-1", role: "assistant" },
      },
      {
        type: "tool_execution_start",
        toolCallId: "tool-abc",
        toolName: "bash",
        args: { command: "ls -la" },
      },
      {
        type: "tool_execution_end",
        toolCallId: "tool-abc",
        result: { content: [{ type: "text", text: "total 12\n..." }] },
      },
      { type: "agent_end" },
    ];

    for (const event of events) {
      const patch = piStreamEventToPatch(event);
      if (patch) {
        view = applyViewPatch(view, patch);
      }
    }

    // 1 assistant message + 1 tool item
    expect(view.items).toHaveLength(2);
    const toolItem = view.items[1];
    expect(toolItem.kind).toBe("tool");
    if (toolItem.kind === "tool") {
      expect(toolItem.id).toBe("tool-abc");
      expect(toolItem.toolName).toBe("bash");
      expect(toolItem.status).toBe("done");
    }
  });

  it("handles extension dialog stream", () => {
    let view = createEmptySessionView();

    const events = [
      { type: "agent_start" },
      {
        type: "extension_ui_request",
        id: "confirm-1",
        method: "confirm",
        params: { title: "Run command?", message: "Pi wants approval" },
      },
    ];

    for (const event of events) {
      const patch = piStreamEventToPatch(event);
      if (patch) {
        view = applyViewPatch(view, patch);
      }
    }

    expect(view.pendingRequests).toHaveLength(1);
    expect(view.pendingRequests[0].id).toBe("confirm-1");
    expect(view.status).toBe("blocked");
  });

  it("handles fire-and-forget extension notifications without blocking", () => {
    let view = createEmptySessionView();

    const events = [
      { type: "agent_start" },
      {
        type: "extension_ui_request",
        id: "notif-1",
        method: "setStatus",
        params: { statusText: "Indexing files" },
      },
      {
        type: "extension_ui_request",
        id: "notif-2",
        method: "notify",
        params: { message: "Task complete" },
      },
    ];

    for (const event of events) {
      const patch = piStreamEventToPatch(event, view);
      if (patch) {
        view = applyViewPatch(view, patch);
      }
    }

    // No blocking requests
    expect(view.pendingRequests).toHaveLength(0);
    expect(view.status).toBe("running"); // not blocked
  });

  it("replays agent failure stream and ends with failed status", () => {
    let view = createEmptySessionView();

    // Load events from the fixture so the fixture cannot drift
    const events = agentFailureFixture();

    for (const event of events) {
      const patch = piStreamEventToPatch(event, view);
      if (patch) {
        view = applyViewPatch(view, patch);
      }
    }

    expect(view.status).toBe("failed");
    expect(view.statusText).toBe("Agent error");
  });

  it("replays retry stream: agent_end willRetry followed by auto_retry then agent_end", () => {
    let view = createEmptySessionView();

    // agent_end with willRetry=true → null (don't change status)
    expect(piStreamEventToPatch({ type: "agent_end", willRetry: true, messages: [] }, view)).toBeNull();

    // auto_retry_start → running
    view = applyViewPatch(view, piStreamEventToPatch({ type: "auto_retry_start" }, view)!);
    expect(view.status).toBe("running");

    // agent_end with willRetry=false → connected (no error signals)
    view = applyViewPatch(
      view,
      piStreamEventToPatch({ type: "agent_end", willRetry: false, messages: [] }, view)!
    );
    expect(view.status).toBe("connected");
  });

  it("preserves blocked state across fire-and-forget notifications", () => {
    let view = createEmptySessionView();

    // Set up blocked state (via a dialog request)
    view = applyViewPatch(view, {
      type: "setPendingRequest",
      request: { id: "confirm-1", method: "confirm", params: {} },
    });
    expect(view.status).toBe("blocked");

    // Fire-and-forget notification now returns null for terminal states
    const patch = piStreamEventToPatch(
      {
        type: "extension_ui_request",
        id: "notif-1",
        method: "setStatus",
        params: { statusText: "Still processing" },
      },
      view,
    );
    expect(patch).toBeNull();

    // View should be unchanged
    expect(view.status).toBe("blocked");
  });
});

// ── Contract test helpers ──

describe("contract validation", () => {
  function expectValidSessionView(view: SessionView): void {
    for (const item of view.items) {
      expect(item.id).toBeTruthy();
      expect(item.kind).toMatch(/user|assistant|tool|notice/);
      // No raw Pi shapes leaked
      expect(item).not.toHaveProperty("type");
      expect(item).not.toHaveProperty("message");
    }
  }

  it("web-test-session produces a contract-valid view", () => {
    const view = piSnapshotToView(webTestSession);
    expectValidSessionView(view);
  });
});

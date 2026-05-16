import { describe, expect, it } from "vitest";
import {
  appendLocalUserMessage,
  createInitialSessionState,
  hydrateSessionMessages,
  reduceSessionEvent,
  reduceSessionResponse
} from "../src/lib/sessionState";

describe("session state reducer", () => {
  it("adds a local user prompt immediately as a completed message", () => {
    const state = createInitialSessionState();

    appendLocalUserMessage(state, "Please inspect the app");

    expect(state.messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: "Please inspect the app",
        status: "done",
        thinking: "",
        toolDeltas: []
      })
    ]);
  });

  it("ignores Pi user message echoes after adding the local prompt", () => {
    const state = createInitialSessionState();

    appendLocalUserMessage(state, "Please inspect the app");
    reduceSessionEvent(state, {
      type: "message_start",
      messageId: "pi-user-1",
      message: { role: "user", content: "Please inspect the app" }
    });
    reduceSessionEvent(state, {
      type: "message_end",
      messageId: "pi-user-1",
      message: { role: "user", content: "Please inspect the app" }
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toEqual(expect.objectContaining({ role: "user", content: "Please inspect the app" }));
  });

  it("builds assistant text from streaming text deltas", () => {
    const state = createInitialSessionState();
    reduceSessionEvent(state, { type: "message_start", messageId: "m1", role: "assistant" });
    reduceSessionEvent(state, {
      type: "message_update",
      messageId: "m1",
      assistantMessageEvent: { type: "text_delta", delta: "Hello" }
    });
    reduceSessionEvent(state, {
      type: "message_update",
      messageId: "m1",
      assistantMessageEvent: { type: "text_delta", delta: " there" }
    });
    reduceSessionEvent(state, { type: "message_end", messageId: "m1" });

    expect(state.messages).toEqual([
      expect.objectContaining({ id: "m1", role: "assistant", content: "Hello there", status: "done" })
    ]);
  });

  it("tracks tool execution and queue updates", () => {
    const state = createInitialSessionState();
    reduceSessionEvent(state, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "pwd" }
    });
    reduceSessionEvent(state, {
      type: "tool_execution_update",
      toolCallId: "tool-1",
      partialResult: { content: [{ type: "text", text: "ran command" }] }
    });
    reduceSessionEvent(state, {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      isError: false,
      result: { content: [{ type: "text", text: "/tmp" }] }
    });
    reduceSessionEvent(state, { type: "queue_update", steering: ["fix this"], followUp: ["summarize"] });

    expect(state.tools[0]).toEqual(
      expect.objectContaining({
        id: "tool-1",
        name: "bash",
        status: "done",
        input: { command: "pwd" },
        log: ["ran command"],
        output: { content: [{ type: "text", text: "/tmp" }] }
      })
    );
    expect(state.queue).toEqual([
      { id: "steering-0", command: "steer", label: "fix this", value: "fix this" },
      { id: "followUp-0", command: "follow_up", label: "summarize", value: "summarize" }
    ]);
  });

  it("keeps tool executions in chronological order", () => {
    const state = createInitialSessionState();

    reduceSessionEvent(state, { type: "tool_execution_start", toolCallId: "first", toolName: "read" });
    reduceSessionEvent(state, { type: "tool_execution_start", toolCallId: "second", toolName: "write" });

    expect(state.tools.map((tool) => tool.id)).toEqual(["first", "second"]);
  });

  it("keeps streamed message updates together when Pi omits message ids", () => {
    const state = createInitialSessionState();

    reduceSessionEvent(state, { type: "message_start", message: { role: "assistant" } });
    reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "One" }
    });
    reduceSessionEvent(state, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: " message" }
    });
    reduceSessionEvent(state, { type: "message_end", message: { role: "assistant" } });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toEqual(expect.objectContaining({ content: "One message", status: "done" }));
  });

  it("captures extension UI request fields whether they are nested or top-level", () => {
    const state = createInitialSessionState();

    reduceSessionEvent(state, {
      type: "extension_ui_request",
      id: "extension-1",
      method: "confirm",
      title: "Run command?",
      message: "Pi wants approval"
    });

    expect(state.extensionRequests).toEqual([
      {
        id: "extension-1",
        method: "confirm",
        params: { title: "Run command?", message: "Pi wants approval" }
      }
    ]);
  });

  it("keeps fire-and-forget extension methods out of the blocking request queue", () => {
    const state = createInitialSessionState();

    reduceSessionEvent(state, {
      type: "extension_ui_request",
      id: "status-1",
      method: "setStatus",
      params: { statusText: "Indexing files" }
    });
    reduceSessionEvent(state, {
      type: "extension_ui_request",
      id: "editor-1",
      method: "set_editor_text",
      params: { text: "draft" }
    });

    expect(state.statusText).toBe("Editor text updated");
    expect(state.extensionRequests).toEqual([]);
  });

  it("surfaces Pi response success and failure records separately from events", () => {
    const state = createInitialSessionState();

    reduceSessionResponse(state, {
      type: "response",
      command: "get_state",
      success: true,
      data: { sessionId: "abc", provider: "anthropic", model: "claude", status: "ready" }
    });

    expect(state.statusText).toBe("Pi state: session abc / anthropic/claude / ready");
    expect(state.activity[0]).toEqual(expect.objectContaining({ type: "response", summary: "Pi response received" }));

    reduceSessionResponse(state, {
      type: "response",
      success: false,
      error: { message: "bad request" }
    });

    expect(state.statusText).toBe("Pi request failed: bad request");
    expect(state.activity[0]).toEqual(expect.objectContaining({ type: "response", summary: "Pi response failed: bad request" }));
  });

  it("hydrates displayed messages from Pi-owned session messages", () => {
    const state = createInitialSessionState();
    appendLocalUserMessage(state, "transient local draft");
    reduceSessionEvent(state, { type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash" });

    hydrateSessionMessages(state, [
      { id: "u1", role: "user", content: "Show **markdown**" },
      {
        id: "a1",
        role: "assistant",
        content: [
          { type: "thinking", thinking: "checking files" },
          { type: "text", text: "# Done\n\nIt worked." },
          { type: "tool_use", name: "read", input: { path: "package.json" } }
        ]
      }
    ]);

    expect(state.messages).toEqual([
      expect.objectContaining({
        id: "u1",
        role: "user",
        content: "Show **markdown**",
        thinking: "",
        toolDeltas: [],
        status: "done"
      }),
      expect.objectContaining({
        id: "a1",
        role: "assistant",
        content: "# Done\n\nIt worked.",
        thinking: "checking files",
        toolDeltas: [JSON.stringify({ type: "tool_use", name: "read", input: { path: "package.json" } })],
        status: "done"
      })
    ]);
    expect(state.tools).toEqual([]);
    expect(state.activeMessageId).toBeNull();
  });
});

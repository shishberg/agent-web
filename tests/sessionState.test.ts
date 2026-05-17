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
        tools: []
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

  it("streaming partial toolcall deltas plus execution lifecycle produce exactly one tool part summary", () => {
    const state = createInitialSessionState();

    reduceSessionEvent(state, { type: "message_start", messageId: "assistant-1", role: "assistant" });
    reduceSessionEvent(state, {
      type: "message_update",
      messageId: "assistant-1",
      assistantMessageEvent: { type: "tool_call_delta", delta: { type: "input_json_delta", partial_json: "{\"command\"" } }
    });
    reduceSessionEvent(state, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "pwd" }
    });
    reduceSessionEvent(state, {
      type: "tool_execution_update",
      toolCallId: "tool-1",
      partialResult: { content: [{ type: "text", text: "running pwd\n" }] }
    });
    reduceSessionEvent(state, {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      success: true,
      result: { content: [{ type: "text", text: "/tmp" }] }
    });

    expect(state.messages[0].tools).toEqual([
      expect.objectContaining({
        key: "tool-1",
        id: "tool-1",
        label: "bash",
        name: "bash",
        detail: "pwd",
        status: "done",
        statusLabel: "Complete",
        content: "/tmp"
      })
    ]);
    expect(state.messages[0].tools[0].content).not.toContain("tool_call_delta");
  });

  it("replaces accumulated tool execution updates instead of appending them", () => {
    const state = createInitialSessionState();

    reduceSessionEvent(state, { type: "message_start", messageId: "assistant-1", role: "assistant" });
    reduceSessionEvent(state, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "npm test" }
    });
    reduceSessionEvent(state, {
      type: "tool_execution_update",
      toolCallId: "tool-1",
      partialResult: { content: [{ type: "text", text: "one" }] }
    });
    reduceSessionEvent(state, {
      type: "tool_execution_update",
      toolCallId: "tool-1",
      partialResult: { content: [{ type: "text", text: "one\ntwo" }] }
    });

    expect(state.messages[0].tools[0]).toEqual(
      expect.objectContaining({
        status: "running",
        content: "one\ntwo"
      })
    );
  });

  it("marks tool executions as errors when nested results report errors", () => {
    const state = createInitialSessionState();

    reduceSessionEvent(state, { type: "message_start", messageId: "assistant-1", role: "assistant" });
    reduceSessionEvent(state, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "npm test" }
    });
    reduceSessionEvent(state, {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      result: { isError: true, content: [{ type: "text", text: "failed" }] }
    });

    expect(state.tools[0]).toEqual(expect.objectContaining({ status: "failed" }));
    expect(state.messages[0].tools[0]).toEqual(
      expect.objectContaining({
        status: "error",
        statusLabel: "Error",
        content: "failed"
      })
    );
  });

  it("uses stable non-empty fallback keys for id-less tool executions", () => {
    const state = createInitialSessionState();

    reduceSessionEvent(state, { type: "message_start", messageId: "assistant-1", role: "assistant" });
    reduceSessionEvent(state, {
      type: "tool_execution_start",
      toolName: "bash",
      args: { command: "pwd" }
    });
    reduceSessionEvent(state, {
      type: "tool_execution_start",
      toolName: "bash",
      args: { command: "date" }
    });

    expect(state.messages[0].tools).toHaveLength(2);
    expect(state.messages[0].tools.map((tool) => tool.key)).toEqual(["bash:pwd:{\n  \"command\": \"pwd\"\n}", "bash:date:{\n  \"command\": \"date\"\n}"]);
  });

  it("hydrated transcript and equivalent streamed transcript produce equivalent tool state", () => {
    const streamed = createInitialSessionState();
    reduceSessionEvent(streamed, { type: "message_start", messageId: "assistant-1", role: "assistant" });
    reduceSessionEvent(streamed, {
      type: "message_update",
      messageId: "assistant-1",
      assistantMessageEvent: { type: "text_delta", delta: "Let me inspect that." }
    });
    reduceSessionEvent(streamed, {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "find src -type f" }
    });
    reduceSessionEvent(streamed, {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "src/App.vue\n" }] }
    });

    const hydrated = createInitialSessionState();
    hydrateSessionMessages(hydrated, [
      {
        id: "assistant-1",
        role: "assistant",
        content: [
          { type: "text", text: "Let me inspect that." },
          { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "find src -type f" } }
        ]
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "bash",
        content: [{ type: "text", text: "src/App.vue\n" }],
        isError: false
      }
    ]);

    expect(hydrated.messages).toHaveLength(1);
    expect(hydrated.messages[0]).toEqual(
      expect.objectContaining({
        id: "assistant-1",
        role: "assistant",
        content: streamed.messages[0].content,
        tools: [
          expect.objectContaining({
            key: "call_1",
            label: "bash",
            detail: "find src -type f",
            status: "done",
            content: "src/App.vue\n"
          })
        ]
      })
    );
  });

  it("message_end enriches an existing streamed tool without duplicating it", () => {
    const state = createInitialSessionState();

    reduceSessionEvent(state, { type: "message_start", messageId: "assistant-1", role: "assistant" });
    reduceSessionEvent(state, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "pwd" }
    });
    reduceSessionEvent(state, {
      type: "message_end",
      messageId: "assistant-1",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tool-1", name: "bash", arguments: { command: "pwd" } },
          { type: "tool_result", toolCallId: "tool-1", content: [{ type: "text", text: "/tmp" }] }
        ]
      }
    });

    expect(state.messages[0].tools).toHaveLength(1);
    expect(state.messages[0].tools[0]).toEqual(
      expect.objectContaining({
        key: "tool-1",
        label: "bash",
        detail: "pwd",
        status: "done",
        content: "/tmp"
      })
    );
  });

  it("ID-less partial input JSON never renders as a tool", () => {
    const state = createInitialSessionState();

    reduceSessionEvent(state, { type: "message_start", messageId: "assistant-1", role: "assistant" });
    reduceSessionEvent(state, {
      type: "message_update",
      messageId: "assistant-1",
      assistantMessageEvent: { type: "tool_call_delta", delta: { type: "input_json_delta", partial_json: "{" } }
    });
    reduceSessionEvent(state, {
      type: "message_end",
      messageId: "assistant-1",
      message: {
        role: "assistant",
        content: [
          { type: "tool_call_delta", delta: { type: "input_json_delta", partial_json: "{" } },
          { type: "text", text: "Done" }
        ]
      }
    });

    expect(state.messages[0].content).toBe("Done");
    expect(state.messages[0].tools).toEqual([]);
  });

  it("ignores assistant stream tool fragments instead of rendering generic tool parts", () => {
    const state = createInitialSessionState();

    reduceSessionEvent(state, { type: "message_start", messageId: "assistant-1", role: "assistant" });
    reduceSessionEvent(state, {
      type: "message_update",
      messageId: "assistant-1",
      assistantMessageEvent: {
        type: "tool_call",
        id: "call_1",
        name: "bash",
        delta: { type: "input_json_delta", partial_json: "{\"command\":\"pw" }
      }
    });
    reduceSessionEvent(state, {
      type: "message_update",
      messageId: "assistant-1",
      assistantMessageEvent: {
        type: "tool_result",
        toolCallId: "call_1",
        content: [{ type: "text", text: "partial result" }]
      }
    });
    reduceSessionEvent(state, {
      type: "message_update",
      messageId: "assistant-1",
      delta: "{\"command\":\"pwd\"}"
    });

    expect(state.messages[0]).toEqual(
      expect.objectContaining({
        content: "",
        tools: []
      })
    );
  });

  it("renders lifecycle tool events after ignored assistant stream fragments as one attached tool", () => {
    const state = createInitialSessionState();

    reduceSessionEvent(state, { type: "message_start", messageId: "assistant-1", role: "assistant" });
    reduceSessionEvent(state, {
      type: "message_update",
      messageId: "assistant-1",
      assistantMessageEvent: {
        type: "tool_call",
        id: "call_1",
        name: "bash",
        input: { command: "pwd" }
      }
    });
    reduceSessionEvent(state, {
      type: "tool_execution_start",
      toolCallId: "call_1",
      toolName: "bash",
      args: { command: "pwd" }
    });
    reduceSessionEvent(state, {
      type: "tool_execution_update",
      toolCallId: "call_1",
      partialResult: { content: [{ type: "text", text: "running\n" }] }
    });
    reduceSessionEvent(state, {
      type: "tool_execution_end",
      toolCallId: "call_1",
      result: { content: [{ type: "text", text: "/tmp\n" }] }
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].tools).toEqual([
      expect.objectContaining({
        key: "call_1",
        label: "bash",
        detail: "pwd",
        status: "done",
        content: "/tmp\n"
      })
    ]);
  });

  it("tool execution before message creates a synthetic assistant message and message_start reuses it", () => {
    const state = createInitialSessionState();

    reduceSessionEvent(state, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "pwd" }
    });
    expect(state.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "",
        tools: [expect.objectContaining({ key: "tool-1", status: "running" })],
        status: "streaming"
      })
    ]);

    reduceSessionEvent(state, { type: "message_start", messageId: "assistant-1", role: "assistant" });
    reduceSessionEvent(state, {
      type: "message_update",
      messageId: "assistant-1",
      assistantMessageEvent: { type: "text_delta", delta: "Checking." }
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toEqual(
      expect.objectContaining({
        id: "assistant-1",
        content: "Checking.",
        tools: [expect.objectContaining({ key: "tool-1", detail: "pwd" })]
      })
    );
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
          { type: "tool_use", name: "read", input: { path: "package.json" } },
          { type: "tool_result", tool_use_id: "read-1", content: [{ type: "text", text: "package contents" }] }
        ]
      }
    ]);

    expect(state.messages).toEqual([
      expect.objectContaining({
        id: "u1",
        role: "user",
        content: "Show **markdown**",
        thinking: "",
        tools: [],
        status: "done"
      }),
      expect.objectContaining({
        id: "a1",
        role: "assistant",
        content: "# Done\n\nIt worked.",
        thinking: "checking files",
        tools: [
          expect.objectContaining({
            key: "read-1",
            id: "read-1",
            label: "read",
            detail: "package.json",
            status: "done",
            content: "package contents"
          })
        ],
        status: "done"
      })
    ]);
    expect(state.tools).toEqual([]);
    expect(state.activeMessageId).toBeNull();
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

    expect(state.statusText).toBe("Pi ready (anthropic/claude)");
    expect(state.activity[0]).toEqual(expect.objectContaining({ type: "response", summary: "Pi response received" }));

    reduceSessionResponse(state, {
      type: "response",
      success: false,
      error: { message: "bad request" }
    });

    expect(state.statusText).toBe("Pi request failed: bad request");
    expect(state.activity[0]).toEqual(expect.objectContaining({ type: "response", summary: "Pi response failed: bad request" }));
  });
});

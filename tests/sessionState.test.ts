import { describe, expect, it } from "vitest";
import {
  appendLocalUserMessage,
  createInitialSessionState,
  hydrateSessionMessages,
  reduceSessionEvent,
  reduceSessionResponse
} from "../src/lib/sessionState";
import { groupToolDeltas } from "../src/lib/toolDeltas";

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

  it("associates streamed tool execution events with the active assistant message", () => {
    const state = createInitialSessionState();

    reduceSessionEvent(state, { type: "message_start", messageId: "assistant-1", role: "assistant" });
    reduceSessionEvent(state, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "pwd" }
    });
    reduceSessionEvent(state, {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "bash",
      isError: false,
      result: { content: [{ type: "text", text: "/tmp" }] }
    });
    reduceSessionEvent(state, { type: "message_end", messageId: "assistant-1" });

    expect(state.messages).toEqual([
      expect.objectContaining({
        id: "assistant-1",
        role: "assistant",
        toolDeltas: [
          JSON.stringify({
            type: "tool_execution_start",
            toolCallId: "tool-1",
            toolName: "bash",
            args: { command: "pwd" }
          }),
          JSON.stringify({
            type: "tool_execution_end",
            toolCallId: "tool-1",
            toolName: "bash",
            isError: false,
            result: { content: [{ type: "text", text: "/tmp" }] }
          })
        ],
        status: "done"
      })
    ]);
  });

  it("keeps tool execution events visible on the latest assistant message after streaming ends", () => {
    const state = createInitialSessionState();

    reduceSessionEvent(state, { type: "message_start", messageId: "assistant-1", role: "assistant" });
    reduceSessionEvent(state, { type: "message_update", messageId: "assistant-1", assistantMessageEvent: { type: "text_delta", delta: "I'll check." } });
    reduceSessionEvent(state, { type: "message_end", messageId: "assistant-1" });
    reduceSessionEvent(state, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "pwd" }
    });
    reduceSessionEvent(state, {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      isError: false,
      result: { content: [{ type: "text", text: "/tmp" }] }
    });

    expect(state.messages).toEqual([
      expect.objectContaining({
        id: "assistant-1",
        content: "I'll check.",
        toolDeltas: [
          JSON.stringify({
            type: "tool_execution_start",
            toolCallId: "tool-1",
            toolName: "bash",
            args: { command: "pwd" }
          }),
          JSON.stringify({
            type: "tool_execution_end",
            toolCallId: "tool-1",
            isError: false,
            result: { content: [{ type: "text", text: "/tmp" }] }
          })
        ]
      })
    ]);
  });

  it("creates an assistant message for tool execution events when none exists yet", () => {
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
        toolDeltas: [
          JSON.stringify({
            type: "tool_execution_start",
            toolCallId: "tool-1",
            toolName: "bash",
            args: { command: "pwd" }
          })
        ],
        status: "streaming"
      })
    ]);
  });

  it("merges early tool events into the next assistant message", () => {
    const state = createInitialSessionState();

    reduceSessionEvent(state, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "pwd" }
    });
    reduceSessionEvent(state, { type: "message_start", messageId: "assistant-1", role: "assistant" });
    reduceSessionEvent(state, {
      type: "message_update",
      messageId: "assistant-1",
      assistantMessageEvent: { type: "text_delta", delta: "Checking." }
    });
    reduceSessionEvent(state, {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      isError: false,
      result: { content: [{ type: "text", text: "/tmp" }] }
    });

    expect(state.messages).toEqual([
      expect.objectContaining({
        id: "assistant-1",
        content: "Checking.",
        toolDeltas: [
          JSON.stringify({
            type: "tool_execution_start",
            toolCallId: "tool-1",
            toolName: "bash",
            args: { command: "pwd" }
          }),
          JSON.stringify({
            type: "tool_execution_end",
            toolCallId: "tool-1",
            isError: false,
            result: { content: [{ type: "text", text: "/tmp" }] }
          })
        ]
      })
    ]);
  });

  it("does not render duplicate generic groups for streamed partial tool call fragments", () => {
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
      partialResult: { content: [{ type: "text", text: "running pwd" }] }
    });
    reduceSessionEvent(state, {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      success: true,
      result: { content: [{ type: "text", text: "/tmp" }] }
    });

    const groups = groupToolDeltas(state.messages[0].toolDeltas);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toEqual(expect.objectContaining({ label: "bash", detail: "pwd", status: "done" }));
    expect(groups[0].content).toContain("running pwd");
    expect(groups[0].content).not.toContain("tool_call_delta");
  });

  it("ignores id-less partial assistant tool events without useful display information", () => {
    const state = createInitialSessionState();

    reduceSessionEvent(state, { type: "message_start", messageId: "assistant-1", role: "assistant" });
    reduceSessionEvent(state, {
      type: "message_update",
      messageId: "assistant-1",
      assistantMessageEvent: { type: "tool_call_delta", delta: { type: "input_json_delta", partial_json: "{" } }
    });

    expect(state.messages[0].toolDeltas).toEqual([]);
  });

  it("ignores id-only partial assistant tool events without useful display information", () => {
    const state = createInitialSessionState();

    reduceSessionEvent(state, { type: "message_start", messageId: "assistant-1", role: "assistant" });
    reduceSessionEvent(state, {
      type: "message_update",
      messageId: "assistant-1",
      assistantMessageEvent: { type: "tool_call_delta", toolCallId: "tool-1" }
    });

    expect(state.messages[0].toolDeltas).toEqual([]);
  });

  it("ignores partial assistant tool events with non-display content fragments", () => {
    const state = createInitialSessionState();

    reduceSessionEvent(state, { type: "message_start", messageId: "assistant-1", role: "assistant" });
    reduceSessionEvent(state, {
      type: "message_update",
      messageId: "assistant-1",
      assistantMessageEvent: {
        type: "tool_call_delta",
        content: [{ type: "input_json_delta", partial_json: "{" }]
      }
    });
    reduceSessionEvent(state, {
      type: "message_update",
      messageId: "assistant-1",
      assistantMessageEvent: {
        type: "tool_call_delta",
        content: "{\"command\""
      }
    });

    expect(state.messages[0].toolDeltas).toEqual([]);
  });

  it("keeps complete streamed assistant tool calls and results even with sparse fields", () => {
    const state = createInitialSessionState();

    reduceSessionEvent(state, { type: "message_start", messageId: "assistant-1", role: "assistant" });
    reduceSessionEvent(state, {
      type: "message_update",
      messageId: "assistant-1",
      assistantMessageEvent: { type: "toolCall" }
    });
    reduceSessionEvent(state, {
      type: "message_update",
      messageId: "assistant-1",
      assistantMessageEvent: { type: "tool_call" }
    });
    reduceSessionEvent(state, {
      type: "message_update",
      messageId: "assistant-1",
      assistantMessageEvent: { type: "toolResult" }
    });
    reduceSessionEvent(state, {
      type: "message_update",
      messageId: "assistant-1",
      assistantMessageEvent: { type: "tool_result" }
    });

    expect(state.messages[0].toolDeltas).toEqual([
      JSON.stringify({ type: "toolCall" }),
      JSON.stringify({ type: "tool_call" }),
      JSON.stringify({ type: "toolResult" }),
      JSON.stringify({ type: "tool_result" })
    ]);
  });

  it("keeps streamed partial assistant tool events when nested tool metadata is displayable", () => {
    const state = createInitialSessionState();

    reduceSessionEvent(state, { type: "message_start", messageId: "assistant-1", role: "assistant" });
    reduceSessionEvent(state, {
      type: "message_update",
      messageId: "assistant-1",
      assistantMessageEvent: { type: "tool_call_delta", tool: { name: "read", input: { path: "src/App.vue" } } }
    });
    reduceSessionEvent(state, {
      type: "message_update",
      messageId: "assistant-1",
      assistantMessageEvent: {
        type: "tool_call_delta",
        function: { name: "bash", arguments: { command: "npm test" } }
      }
    });
    reduceSessionEvent(state, {
      type: "message_update",
      messageId: "assistant-1",
      assistantMessageEvent: {
        type: "tool_call_delta",
        function: { name: "bash", arguments: "{\"command\":\"npm run build\"}" }
      }
    });

    expect(state.messages[0].toolDeltas).toEqual([
      JSON.stringify({ type: "tool_call_delta", tool: { name: "read", input: { path: "src/App.vue" } } }),
      JSON.stringify({ type: "tool_call_delta", function: { name: "bash", arguments: { command: "npm test" } } }),
      JSON.stringify({ type: "tool_call_delta", function: { name: "bash", arguments: "{\"command\":\"npm run build\"}" } })
    ]);
  });

  it("filters generic partial tool fragments out of completed message content", () => {
    const state = createInitialSessionState();

    reduceSessionEvent(state, {
      type: "message_end",
      messageId: "assistant-1",
      role: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Done" },
          { type: "tool_call_delta", toolCallId: "tool-1" },
          { type: "tool_call_delta", delta: { type: "input_json_delta", partial_json: "{" } },
          { type: "tool_call", id: "tool-1", name: "bash", arguments: { command: "pwd" } },
          { type: "tool_result", toolCallId: "tool-1", content: [{ type: "text", text: "/tmp" }] }
        ]
      }
    });

    expect(state.messages[0].content).toBe("Done");
    expect(state.messages[0].toolDeltas).toEqual([
      JSON.stringify({ type: "tool_call", id: "tool-1", name: "bash", arguments: { command: "pwd" } }),
      JSON.stringify({ type: "tool_result", toolCallId: "tool-1", content: [{ type: "text", text: "/tmp" }] })
    ]);
  });

  it("filters generic partial tool fragments out of hydrated session content", () => {
    const state = createInitialSessionState();

    hydrateSessionMessages(state, [
      {
        id: "assistant-1",
        role: "assistant",
        content: [
          { type: "text", text: "Done" },
          { type: "tool_call_delta", toolCallId: "tool-1" },
          { type: "tool_call", id: "tool-1", name: "read", input: { path: "package.json" } }
        ]
      }
    ]);

    expect(state.messages[0].content).toBe("Done");
    expect(state.messages[0].toolDeltas).toEqual([
      JSON.stringify({ type: "tool_call", id: "tool-1", name: "read", input: { path: "package.json" } })
    ]);
  });

  it("keeps non-text message_end content with the assistant message", () => {
    const state = createInitialSessionState();

    reduceSessionEvent(state, {
      type: "message_end",
      messageId: "assistant-1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "checking files" },
          { type: "text", text: "Done" },
          { type: "tool_use", name: "read", input: { path: "package.json" } }
        ]
      }
    });

    expect(state.messages).toEqual([
      expect.objectContaining({
        id: "assistant-1",
        role: "assistant",
        content: "Done",
        thinking: "checking files",
        toolDeltas: [JSON.stringify({ type: "tool_use", name: "read", input: { path: "package.json" } })],
        status: "done"
      })
    ]);
  });

  it("hydrates tool result messages into the previous assistant message", () => {
    const state = createInitialSessionState();

    hydrateSessionMessages(state, [
      {
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
        content: [{ type: "text", text: "src/App.vue\nsrc/styles.css\n" }],
        isError: false
      }
    ]);

    expect(state.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: "Let me inspect that.",
        toolDeltas: [
          JSON.stringify({ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "find src -type f" } }),
          JSON.stringify({
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "bash",
            content: [{ type: "text", text: "src/App.vue\nsrc/styles.css\n" }],
            isError: false
          })
        ]
      })
    ]);
  });

  it("merges message_end non-text content with already streamed tool deltas", () => {
    const state = createInitialSessionState();

    reduceSessionEvent(state, { type: "message_start", messageId: "assistant-1", role: "assistant" });
    reduceSessionEvent(state, {
      type: "message_update",
      messageId: "assistant-1",
      assistantMessageEvent: { type: "tool_use", name: "read", input: { path: "package.json" } }
    });
    reduceSessionEvent(state, {
      type: "message_end",
      messageId: "assistant-1",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "read", input: { path: "package.json" } },
          { type: "tool_result", tool_use_id: "read-1", content: [{ type: "text", text: "package contents" }] }
        ]
      }
    });

    expect(state.messages).toEqual([
      expect.objectContaining({
        id: "assistant-1",
        toolDeltas: [
          JSON.stringify({ type: "tool_use", name: "read", input: { path: "package.json" } }),
          JSON.stringify({ type: "tool_result", tool_use_id: "read-1", content: [{ type: "text", text: "package contents" }] })
        ],
        status: "done"
      })
    ]);
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
        toolDeltas: [],
        status: "done"
      }),
      expect.objectContaining({
        id: "a1",
        role: "assistant",
        content: "# Done\n\nIt worked.",
        thinking: "checking files",
        toolDeltas: [
          JSON.stringify({ type: "tool_use", name: "read", input: { path: "package.json" } }),
          JSON.stringify({ type: "tool_result", tool_use_id: "read-1", content: [{ type: "text", text: "package contents" }] })
        ],
        status: "done"
      })
    ]);
    expect(state.tools).toEqual([]);
    expect(state.activeMessageId).toBeNull();
  });
});

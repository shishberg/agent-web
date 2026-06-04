import { describe, expect, it } from "vitest";
import type {
  AdapterContext,
  AssistantMessageItem,
  AssistantToolPart,
  ContentBlock,
  SessionView,
  UserMessageItem,
  ViewPatch,
  ViewStreamAdapter,
} from "../../src/protocol/types";
import { createEmptySessionView } from "../../src/protocol/types";

describe("SessionView protocol types", () => {
  it("createEmptySessionView returns a valid default view", () => {
    const view = createEmptySessionView();
    expect(view.session).toBeDefined();
    expect(view.session.title).toBe("New session");
    expect(view.items).toEqual([]);
    expect(view.status).toBe("idle");
    expect(view.statusText).toBe("Ready");
    expect(view.pendingRequests).toEqual([]);
    expect(view.extensionDraft).toBeNull();
    expect(view.cursor).toBe("");
  });

  it("createEmptySessionView accepts a session parameter", () => {
    const view = createEmptySessionView({
      id: "s1",
      title: "My session",
      status: "running",
    });
    expect(view.session.id).toBe("s1");
    expect(view.session.title).toBe("My session");
    expect(view.session.status).toBe("running");
  });

  it("UserMessageItem has the correct structure", () => {
    const msg: UserMessageItem = {
      kind: "user",
      id: "u1",
      content: [{ type: "text", text: "Hello" }],
      timestamp: 1000,
    };
    expect(msg.kind).toBe("user");
    expect(msg.id).toBe("u1");
    expect(msg.content).toHaveLength(1);
  });

  it("AssistantMessageItem has the correct structure", () => {
    const msg: AssistantMessageItem = {
      kind: "assistant",
      id: "a1",
      content: [{ type: "text", text: "Hi" }],
      thinking: [{ type: "thinking", thinking: "Let me check..." }],
      provider: "anthropic",
      model: "claude-4",
      usage: { inputTokens: 100, outputTokens: 50 },
      tools: [
        {
          id: "call_1",
          name: "bash",
          label: "bash",
          input: { command: "pwd" },
          status: "pending",
        } satisfies AssistantToolPart,
      ],
    };
    expect(msg.kind).toBe("assistant");
    expect(msg.provider).toBe("anthropic");
    expect(msg.thinking).toHaveLength(1);
    expect(msg.tools?.[0]?.id).toBe("call_1");
    expect(msg.usage?.inputTokens).toBe(100);
  });

  it("ContentBlock accepts text blocks", () => {
    const block: ContentBlock = { type: "text", text: "Hello" };
    expect(block.type).toBe("text");
  });

  it("ContentBlock accepts thinking blocks", () => {
    const block: ContentBlock = { type: "thinking", thinking: "Hmm" };
    expect(block.type).toBe("thinking");
  });

  it("ViewPatch union types compile", () => {
    const patches: ViewPatch[] = [
      { type: "appendItem", item: { kind: "user", id: "u1", content: [] } },
      { type: "updateItem", id: "i1", partial: { kind: "user", content: [] } },
      { type: "setStatus", status: "running" },
      { type: "setPendingRequest", request: { id: "r1", method: "confirm", params: {} } },
      { type: "clearPendingRequest", id: "r1" },
      { type: "setExtensionDraft", text: "draft" },
      { type: "setCursor", cursor: "evt-5" },
      { type: "setSession", session: { id: "s1", title: "S1", status: "idle" } },
      { type: "upsertAssistantTool", assistantId: "a1", tool: { id: "call_1", status: "running" } },
    ];
    expect(patches).toHaveLength(9);
  });

  it("SessionView type has all required fields", () => {
    const view: SessionView = {
      session: { id: "s1", title: "Test", status: "running" },
      items: [],
      status: "running",
      statusText: "Agent running",
      pendingRequests: [],
      extensionDraft: null,
      cursor: "evt-10",
    };
    expect(view.session.id).toBe("s1");
    expect(view.cursor).toBe("evt-10");
  });
});

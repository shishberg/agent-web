import { describe, expect, it } from "vitest";
import { applyViewPatch } from "../../src/protocol/view-reducer";
import { createEmptySessionView } from "../../src/protocol/types";
import type {
  AssistantMessageItem,
  UserMessageItem,
  UserRequest,
} from "../../src/protocol/types";

describe("applyViewPatch", () => {
  it("appendItem adds an item to the view", () => {
    const view = createEmptySessionView();
    const item: UserMessageItem = {
      kind: "user",
      id: "u1",
      content: [{ type: "text", text: "Hello" }],
    };
    const next = applyViewPatch(view, { type: "appendItem", item });
    expect(next.items).toHaveLength(1);
    expect(next.items[0].id).toBe("u1");
    expect(view.items).toHaveLength(0); // original not mutated
  });

  it("appendItem appends multiple items in order", () => {
    let view = createEmptySessionView();
    view = applyViewPatch(view, {
      type: "appendItem",
      item: { kind: "user", id: "u1", content: [] },
    });
    view = applyViewPatch(view, {
      type: "appendItem",
      item: { kind: "user", id: "u2", content: [] },
    });
    expect(view.items).toHaveLength(2);
    expect(view.items[0].id).toBe("u1");
    expect(view.items[1].id).toBe("u2");
  });

  it("updateItem updates matching item by id", () => {
    let view = createEmptySessionView();
    view = applyViewPatch(view, {
      type: "appendItem",
      item: { kind: "assistant", id: "a1", content: [] } as AssistantMessageItem,
    });
    view = applyViewPatch(view, {
      type: "updateItem",
      id: "a1",
      partial: { kind: "assistant", content: [{ type: "text", text: "Hi" }] },
    });
    expect((view.items[0] as AssistantMessageItem).content).toEqual([{ type: "text", text: "Hi" }]);
  });

  it("updateItem merges content by accumulating text deltas", () => {
    let view = createEmptySessionView();
    view = applyViewPatch(view, {
      type: "appendItem",
      item: { kind: "assistant", id: "a1", content: [] } as AssistantMessageItem,
    });

    // First delta
    view = applyViewPatch(view, {
      type: "updateItem",
      id: "a1",
      partial: { kind: "assistant", content: [{ type: "text", text: "Hello" }] },
    });
    expect((view.items[0] as AssistantMessageItem).content).toEqual([
      { type: "text", text: "Hello" },
    ]);

    // Second delta — appends to existing text
    view = applyViewPatch(view, {
      type: "updateItem",
      id: "a1",
      partial: { kind: "assistant", content: [{ type: "text", text: " world." }] },
    });
    expect((view.items[0] as AssistantMessageItem).content).toEqual([
      { type: "text", text: "Hello world." },
    ]);

    // Full accumulated update (message_end) — replaces since incoming
    // starts with existing text.
    view = applyViewPatch(view, {
      type: "updateItem",
      id: "a1",
      partial: {
        kind: "assistant",
        content: [{ type: "text", text: "Hello world." }],
      },
    });
    expect((view.items[0] as AssistantMessageItem).content).toEqual([
      { type: "text", text: "Hello world." },
    ]);
  });

  it("updateItem merges thinking blocks by appending", () => {
    let view = createEmptySessionView();
    view = applyViewPatch(view, {
      type: "appendItem",
      item: {
        kind: "assistant",
        id: "a1",
        content: [],
        thinking: [{ type: "thinking", thinking: "Let me" }],
      } as AssistantMessageItem,
    });

    view = applyViewPatch(view, {
      type: "updateItem",
      id: "a1",
      partial: { kind: "assistant", thinking: [{ type: "thinking", thinking: " think." }] },
    });
    expect((view.items[0] as AssistantMessageItem).thinking).toEqual([
      { type: "thinking", thinking: "Let me think." },
    ]);
  });

  it("updateItem on non-existent id leaves items unchanged", () => {
    const view = createEmptySessionView();
    const next = applyViewPatch(view, {
      type: "updateItem",
      id: "nonexistent",
      partial: { content: [{ type: "text", text: "x" }] },
    });
    expect(next.items).toEqual(view.items);
  });

  it("setStatus changes status and statusText", () => {
    let view = createEmptySessionView();
    view = applyViewPatch(view, { type: "setStatus", status: "running" });
    expect(view.status).toBe("running");
    expect(view.statusText).toBe("Agent running");
  });

  it("setStatus with custom statusText preserves the custom text", () => {
    let view = createEmptySessionView();
    view = applyViewPatch(view, {
      type: "setStatus",
      status: "running",
      statusText: "Custom text",
    });
    expect(view.status).toBe("running");
    expect(view.statusText).toBe("Custom text");
  });

  it("setPendingRequest adds a request and sets status to blocked", () => {
    let view = createEmptySessionView();
    view = applyViewPatch(view, { type: "setStatus", status: "running" });

    const request: UserRequest = {
      id: "req-1",
      method: "confirm",
      params: { title: "Approve?" },
    };
    view = applyViewPatch(view, { type: "setPendingRequest", request });
    expect(view.pendingRequests).toHaveLength(1);
    expect(view.pendingRequests[0].id).toBe("req-1");
    expect(view.status).toBe("blocked");
  });

  it("clearPendingRequest removes the request", () => {
    let view = createEmptySessionView();
    view = applyViewPatch(view, { type: "setStatus", status: "running" });
    view = applyViewPatch(view, {
      type: "setPendingRequest",
      request: { id: "req-1", method: "confirm", params: {} },
    });
    view = applyViewPatch(view, { type: "clearPendingRequest", id: "req-1" });
    expect(view.pendingRequests).toHaveLength(0);
    expect(view.status).toBe("running"); // returns to previous running
  });

  it("clearPendingRequest keeps blocked if other requests remain", () => {
    let view = createEmptySessionView();
    view = applyViewPatch(view, { type: "setStatus", status: "running" });
    view = applyViewPatch(view, {
      type: "setPendingRequest",
      request: { id: "req-1", method: "confirm", params: {} },
    });
    view = applyViewPatch(view, {
      type: "setPendingRequest",
      request: { id: "req-2", method: "input", params: {} },
    });
    view = applyViewPatch(view, { type: "clearPendingRequest", id: "req-1" });
    expect(view.pendingRequests).toHaveLength(1);
    expect(view.status).toBe("blocked");
  });

  it("setExtensionDraft sets the draft text", () => {
    let view = createEmptySessionView();
    view = applyViewPatch(view, {
      type: "setExtensionDraft",
      text: "editor content",
    });
    expect(view.extensionDraft).toBe("editor content");
  });

  it("setExtensionDraft replaces previous draft", () => {
    let view = createEmptySessionView();
    view = applyViewPatch(view, {
      type: "setExtensionDraft",
      text: "first draft",
    });
    view = applyViewPatch(view, {
      type: "setExtensionDraft",
      text: "second draft",
    });
    expect(view.extensionDraft).toBe("second draft");
  });

  it("setCursor updates the cursor", () => {
    let view = createEmptySessionView();
    view = applyViewPatch(view, { type: "setCursor", cursor: "evt-42" });
    expect(view.cursor).toBe("evt-42");
  });

  it("setSession updates the session summary", () => {
    let view = createEmptySessionView();
    view = applyViewPatch(view, {
      type: "setSession",
      session: { id: "s2", title: "Updated", status: "running" },
    });
    expect(view.session.id).toBe("s2");
    expect(view.session.title).toBe("Updated");
  });

  it("multiple patches applied in sequence produce correct aggregate state", () => {
    let view = createEmptySessionView();

    view = applyViewPatch(view, {
      type: "setSession",
      session: { id: "s1", title: "Test chat", status: "idle" },
    });
    view = applyViewPatch(view, { type: "setStatus", status: "running" });
    view = applyViewPatch(view, {
      type: "appendItem",
      item: {
        kind: "user",
        id: "u1",
        content: [{ type: "text", text: "Hello" }],
      },
    });
    view = applyViewPatch(view, {
      type: "appendItem",
      item: {
        kind: "assistant",
        id: "a1",
        content: [{ type: "text", text: "Hi there" }],
      } as AssistantMessageItem,
    });
    view = applyViewPatch(view, { type: "setStatus", status: "connected" });

    expect(view.session.title).toBe("Test chat");
    expect(view.items).toHaveLength(2);
    expect(view.items[0].id).toBe("u1");
    expect(view.items[1].id).toBe("a1");
    expect(view.status).toBe("connected");
    expect(view.statusText).toBe("Agent finished");
  });

  it("does not mutate the original SessionView", () => {
    const view = createEmptySessionView();
    const patch = { type: "appendItem" as const, item: { kind: "user" as const, id: "u1", content: [] } };
    const next = applyViewPatch(view, patch);
    expect(next).not.toBe(view);
    expect(next.items).not.toBe(view.items);
    expect(view.items).toHaveLength(0);
  });
});

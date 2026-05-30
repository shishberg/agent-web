import { describe, expect, it } from "vitest";
import { normalizeStreamEvent, normalizeTranscript } from "../src/lib/transcriptNormalizer";

describe("normalizeStreamEvent", () => {
  it("preserves message.id when already present", () => {
    const event: Record<string, unknown> = { type: "message_start", message: { id: "m1", role: "assistant" } };
    normalizeStreamEvent(event);
    expect((event.message as Record<string, unknown>).id).toBe("m1");
  });

  it("synthesizes message.id from timestamp when id is missing", () => {
    const event: Record<string, unknown> = { type: "message_start", message: { role: "assistant", timestamp: 1717000000123 } };
    normalizeStreamEvent(event);
    expect((event.message as Record<string, unknown>).id).toBe("pi:assistant:timestamp:1717000000123");
  });

  it("synthesizes message.id from responseId when timestamp is also missing", () => {
    const event: Record<string, unknown> = { type: "message_start", message: { role: "assistant", responseId: "resp-abc" } };
    normalizeStreamEvent(event);
    expect((event.message as Record<string, unknown>).id).toBe("pi:assistant:response:resp-abc");
  });

  it("prefers timestamp over responseId when both are present", () => {
    const event: Record<string, unknown> = { type: "message_start", message: { role: "assistant", timestamp: 9999, responseId: "resp-abc" } };
    normalizeStreamEvent(event);
    expect((event.message as Record<string, unknown>).id).toBe("pi:assistant:timestamp:9999");
  });

  it("preserves message.id over any fallback", () => {
    const event: Record<string, unknown> = { type: "message_start", message: { role: "assistant", id: "kept", timestamp: 1234, responseId: "resp-abc" } };
    normalizeStreamEvent(event);
    expect((event.message as Record<string, unknown>).id).toBe("kept");
  });

  it("does not mutate events without a message field", () => {
    const event: Record<string, unknown> = { type: "tool_execution_start", toolCallId: "t1" };
    const copy = { ...event };
    normalizeStreamEvent(event);
    expect(event).toEqual(copy);
  });

  it("does not mutate events where message has no role", () => {
    const event: Record<string, unknown> = { type: "some_event", message: { content: "hello" } };
    const copy = { ...event, message: { ...(event.message as Record<string, unknown>) } };
    normalizeStreamEvent(event);
    expect(event).toEqual(copy);
  });

  it("produces the same id across Verandah-style lifecycle events for the same message", () => {
    // Verandah streams emit message_start, message_update, message_end
    // with the same nested message shape but no message.id.
    const makeEvent = (type: string): Record<string, unknown> => ({
      type,
      message: { role: "assistant", timestamp: 1717000000, responseId: "turn-1" },
    });

    const start = makeEvent("message_start");
    const update = makeEvent("message_update");
    const end = makeEvent("message_end");

    normalizeStreamEvent(start);
    normalizeStreamEvent(update);
    normalizeStreamEvent(end);

    expect((start.message as Record<string, unknown>).id).toBe("pi:assistant:timestamp:1717000000");
    expect((update.message as Record<string, unknown>).id).toBe("pi:assistant:timestamp:1717000000");
    expect((end.message as Record<string, unknown>).id).toBe("pi:assistant:timestamp:1717000000");
  });

  it("returns the same reference for chaining", () => {
    const event: Record<string, unknown> = { type: "message_start", message: { role: "assistant", timestamp: 42 } };
    const result = normalizeStreamEvent(event);
    expect(result).toBe(event);
  });

  it("treats empty string message.id as missing", () => {
    const event: Record<string, unknown> = { type: "message_start", message: { id: "", role: "assistant", timestamp: 1234 } };
    normalizeStreamEvent(event);
    expect((event.message as Record<string, unknown>).id).toBe("pi:assistant:timestamp:1234");
  });
});

describe("normalizeTranscript", () => {
  it("unwraps session-file message records", () => {
    const result = normalizeTranscript([
      {
        type: "message",
        id: "record-user-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "Hello" }],
        },
      },
      {
        type: "message",
        id: "record-assistant-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Hi there" }],
        },
      },
    ]);

    expect(result).toEqual([
      { role: "user", content: [{ type: "text", text: "Hello" }], id: "record-user-1" },
      { role: "assistant", content: [{ type: "text", text: "Hi there" }], id: "record-assistant-1" },
    ]);
  });

  it("skips non-message metadata records", () => {
    const result = normalizeTranscript([
      { type: "session", id: "session-1", cwd: "/tmp/project" },
      { type: "model_change", id: "model-1", modelId: "gpt-5.5" },
      {
        type: "message",
        id: "record-user-1",
        message: { role: "user", content: [{ type: "text", text: "Hello" }] },
      },
    ]);

    expect(result).toEqual([
      { role: "user", content: [{ type: "text", text: "Hello" }], id: "record-user-1" },
    ]);
  });

  it("passes through already-normalized messages unchanged", () => {
    const normalized = [
      { role: "user", content: "Hello", id: "msg-1", timestamp: 1000 },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
        id: "msg-2",
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      },
    ];

    const result = normalizeTranscript(normalized);

    expect(result).toEqual(normalized);
  });

  it("handles empty arrays", () => {
    expect(normalizeTranscript([])).toEqual([]);
  });

  it("handles nulls and non-object entries", () => {
    const result = normalizeTranscript([
      null,
      undefined,
      42,
      "string",
      { role: "user", content: "valid" },
    ] as unknown[]);

    expect(result).toEqual([{ role: "user", content: "valid" }]);
  });

  it("passes through message objects that have a type field but also a role", () => {
    // Some backends may emit objects with both type and role — treat as messages.
    const result = normalizeTranscript([
      { type: "some_type", role: "assistant", content: "Hello" },
    ]);

    expect(result).toEqual([
      { type: "some_type", role: "assistant", content: "Hello" },
    ]);
  });

  it("preserves wrapper id / responseId / timestamp as fallbacks when inner message lacks them", () => {
    const result = normalizeTranscript([
      {
        type: "message",
        id: "wrapper-id",
        responseId: "wrapper-rid",
        timestamp: 9999,
        message: { role: "user", content: "Hello" },
      },
    ]);

    expect(result).toEqual([
      {
        role: "user",
        content: "Hello",
        id: "wrapper-id",
        responseId: "wrapper-rid",
        timestamp: 9999,
      },
    ]);
  });

  it("prefers inner message metadata over wrapper metadata", () => {
    const result = normalizeTranscript([
      {
        type: "message",
        id: "wrapper-id",
        responseId: "wrapper-rid",
        timestamp: 9999,
        message: { role: "user", content: "Hello", id: "inner-id", timestamp: 1111 },
      },
    ]);

    expect(result).toEqual([
      {
        role: "user",
        content: "Hello",
        id: "inner-id",
        responseId: "wrapper-rid",
        timestamp: 1111,
      },
    ]);
  });

  it("does not unwrap non-message type records with role", () => {
    // A record with type "model_change" but also a role field is unusual
    // but should be passed through rather than silently unwrapped.
    const result = normalizeTranscript([
      { type: "model_change", role: "system", content: "model changed" },
    ]);

    expect(result).toEqual([
      { type: "model_change", role: "system", content: "model changed" },
    ]);
  });
});

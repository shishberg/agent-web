import { describe, expect, it } from "vitest";
import { normalizeTranscript } from "../src/lib/transcriptNormalizer";

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

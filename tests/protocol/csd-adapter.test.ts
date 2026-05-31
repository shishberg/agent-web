import { describe, expect, it } from "vitest";
import {
  createCsdViewAdapter,
  csdSnapshotToView,
} from "../../src/protocol/csd-adapter";
import { assertNoRawPiRecords, assertValidSessionView } from "../../src/protocol/contract";
import { applyViewPatch } from "../../src/protocol/view-reducer";
import { createEmptySessionView } from "../../src/protocol/types";
import type { SessionView, ViewPatch } from "../../src/protocol/types";

describe("csdSnapshotToView", () => {
  it("converts CSD transcript observations into a valid SessionView", () => {
    const view = csdSnapshotToView(
      [
        { type: "prompt_submitted", id: "u1", prompt: "Review this" },
        { type: "worker_started", statusText: "Claude running" },
        { type: "assistant_final", id: "a1", finalText: "Looks good" },
        { type: "stop_hook", statusText: "Done" },
      ],
      {
        session: {
          id: "csd-1",
          title: "CSD task",
          status: "idle",
          metadata: { backend: "verandah" },
        },
        cursor: "cursor-4",
      },
    );

    assertValidSessionView(view);
    assertNoRawPiRecords(view);
    expect(view.session).toMatchObject({
      id: "csd-1",
      title: "CSD task",
      status: "idle",
      metadata: { runner: "csd" },
    });
    expect(view.cursor).toBe("cursor-4");
    expect(view.items).toHaveLength(2);
    expect(view.items[0]).toMatchObject({
      kind: "user",
      id: "u1",
      content: [{ type: "text", text: "Review this" }],
    });
    expect(view.items[1]).toMatchObject({
      kind: "assistant",
      id: "a1",
      content: [{ type: "text", text: "Looks good" }],
    });
    expect(view.status).toBe("idle");
    expect(view.statusText).toBe("Done");
  });

  it("is deterministic for generated IDs", () => {
    const records = [
      { type: "prompt_submitted", prompt: "Hello" },
      { type: "assistant_final", finalText: "Hi" },
    ];

    expect(csdSnapshotToView(records)).toEqual(csdSnapshotToView(records));
  });
});

describe("createCsdViewAdapter", () => {
  it("maps prompt, running, assistant, and stop observations to patches", () => {
    const adapter = createCsdViewAdapter(createEmptySessionView());

    expect(adapter.toPatches({ type: "prompt_submitted", id: "u1", text: "Hi" })).toEqual([
      {
        type: "appendItem",
        item: {
          kind: "user",
          id: "u1",
          content: [{ type: "text", text: "Hi" }],
          timestamp: undefined,
        },
      },
    ]);
    expect(adapter.toPatches({ type: "worker_started" })).toEqual([
      { type: "setStatus", status: "running", statusText: "Running" },
    ]);
    expect(adapter.toPatches({ type: "assistant_final", id: "a1", text: "Done" })).toEqual([
      {
        type: "appendItem",
        item: {
          kind: "assistant",
          id: "a1",
          content: [{ type: "text", text: "Done" }],
          provider: undefined,
          model: undefined,
          timestamp: undefined,
        },
      },
    ]);
    expect(adapter.toPatches({ type: "stop_hook" })).toEqual([
      { type: "setStatus", status: "idle", statusText: "Idle" },
    ]);
  });

  it("maps timeout, driver errors, and user stops to status patches", () => {
    const adapter = createCsdViewAdapter(createEmptySessionView());

    expect(adapter.toPatches({ type: "timeout", message: "CSD timed out" })).toEqual([
      { type: "setStatus", status: "failed", statusText: "CSD timed out" },
    ]);
    expect(adapter.toPatches({ type: "driver_error", error: "bad exit" })).toEqual([
      { type: "setStatus", status: "failed", statusText: "bad exit" },
    ]);
    expect(adapter.toPatches({ type: "user_stop" })).toEqual([
      { type: "setStatus", status: "stopped", statusText: "Stopped" },
    ]);
  });

  it("represents unsupported interactive prompts as blocked", () => {
    const adapter = createCsdViewAdapter(createEmptySessionView());

    const patches = adapter.toPatches({
      type: "interactive_prompt",
      id: "req-1",
      method: "approval",
      message: "Approve command?",
    });

    expect(patches).toEqual([
      {
        type: "setPendingRequest",
        request: {
          id: "req-1",
          method: "approval",
          params: { message: "Approve command?" },
        },
      },
      { type: "setStatus", status: "blocked", statusText: "Approve command?" },
    ]);
  });

  it("does not mutate native events", () => {
    const adapter = createCsdViewAdapter(createEmptySessionView());
    const event = { type: "assistant_final", id: "a1", text: "Done" };
    const before = structuredClone(event);

    adapter.toPatches(event);

    expect(event).toEqual(before);
  });

  it("applied stream patches reconstruct the same view shape", () => {
    const initial = createEmptySessionView({ id: "csd", title: "CSD", status: "idle" });
    const adapter = createCsdViewAdapter(initial);
    const events = [
      { type: "prompt_submitted", id: "u1", prompt: "Hi" },
      { type: "worker_started" },
      { type: "assistant_final", id: "a1", finalText: "Hello" },
      { type: "stop_hook" },
    ];

    let view: SessionView = initial;
    const patches: ViewPatch[] = [];
    for (const event of events) {
      patches.push(...adapter.toPatches(event));
    }
    for (const patch of patches) {
      view = applyViewPatch(view, patch);
    }

    expect(view.items.map((item) => item.kind)).toEqual(["user", "assistant"]);
    expect(view.status).toBe("idle");
    assertValidSessionView(view);
  });
});

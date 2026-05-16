import { describe, expect, it } from "vitest";
import { groupToolDeltas, rawToolDeltaId } from "../src/lib/toolDeltas";

describe("tool delta display helpers", () => {
  it("uses concise labels for known and unknown tool deltas", () => {
    expect(groupToolDeltas([JSON.stringify({ type: "tool_use", name: "read", input: { path: "package.json" } })])[0]).toEqual(
      expect.objectContaining({
        label: "read",
        detail: "package.json",
        status: "running",
        statusLabel: "In progress"
      })
    );
    expect(groupToolDeltas([JSON.stringify({ type: "tool_result", content: "done" })])[0]).toEqual(
      expect.objectContaining({
        label: "Tool call",
        status: "done",
        statusLabel: "Complete"
      })
    );
  });

  it("includes bash command detail and infers completion from prior deltas for the same tool call", () => {
    const deltas = [
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "pwd" }
      }),
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        result: { content: [{ type: "text", text: "/tmp" }] }
      })
    ];

    expect(groupToolDeltas(deltas)).toEqual([
      expect.objectContaining({
        label: "bash",
        detail: "pwd",
        status: "done",
        statusLabel: "Complete",
        content: expect.stringContaining('"command": "pwd"')
      })
    ]);
  });

  it("includes file path detail from file tool shapes", () => {
    expect(groupToolDeltas([JSON.stringify({ type: "toolCall", name: "edit", arguments: { file_path: "src/App.vue" } })])[0]).toEqual(
      expect.objectContaining({
        label: "edit",
        detail: "src/App.vue"
      })
    );

    expect(groupToolDeltas([JSON.stringify({ type: "tool_use", name: "read", path: "src/styles.css" })])[0]).toEqual(
      expect.objectContaining({
        label: "read",
        detail: "src/styles.css"
      })
    );
  });

  it("infers running, done, and error status", () => {
    expect(groupToolDeltas([JSON.stringify({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash" })])[0]).toEqual(
      expect.objectContaining({ status: "running", statusLabel: "In progress" })
    );

    expect(groupToolDeltas([JSON.stringify({ type: "toolResult", toolCallId: "tool-1", isError: false })])[0]).toEqual(
      expect.objectContaining({ status: "done", statusLabel: "Complete" })
    );

    expect(groupToolDeltas([JSON.stringify({ type: "tool_execution_end", toolCallId: "tool-1", success: false })])[0]).toEqual(
      expect.objectContaining({ status: "error", statusLabel: "Error" })
    );

    expect(groupToolDeltas([JSON.stringify({ type: "tool_result", toolCallId: "tool-1", is_error: true })])[0]).toEqual(
      expect.objectContaining({ status: "error", statusLabel: "Error" })
    );
  });

  it("pretty-prints JSON while keeping plain log text intact", () => {
    expect(groupToolDeltas([JSON.stringify({ type: "tool_use", name: "read" })])[0].content).toBe(
      '{\n  "type": "tool_use",\n  "name": "read"\n}'
    );
    expect(groupToolDeltas(["plain log line"])[0].content).toBe("plain log line");
  });

  it("uses raw UUID-like ids for grouping without displaying them as labels", () => {
    const firstId = "019e30fc-d214-7349-8b1c-b149337ace1e";
    const secondId = "019e30fc-d214-7349-8b1c-b149337ace1f";
    const groups = groupToolDeltas([
      JSON.stringify({ type: "tool_execution_start", toolCallId: firstId, toolName: "bash", args: { command: "pwd" } }),
      JSON.stringify({ type: "tool_execution_start", toolCallId: secondId, toolName: "read", input: { path: "package.json" } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: firstId, result: { content: [{ type: "text", text: "/tmp" }] } }),
      JSON.stringify({ type: "tool_execution_end", toolCallId: secondId, result: { content: [{ type: "text", text: "{}" }] } })
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual(expect.objectContaining({ key: firstId, label: "bash", detail: "pwd", status: "done" }));
    expect(groups[0].content).toContain("/tmp");
    expect(groups[1]).toEqual(expect.objectContaining({ key: secondId, label: "read", detail: "package.json", status: "done" }));
    expect(groups[1].content).toContain("{}");
  });

  it("extracts raw ids separately from display values", () => {
    expect(rawToolDeltaId({ id: "019e30fc-d214-7349-8b1c-b149337ace1e" })).toBe("019e30fc-d214-7349-8b1c-b149337ace1e");
  });
});

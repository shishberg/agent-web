import { describe, expect, it } from "vitest";
import { groupToolDeltas, rawToolDeltaId } from "../src/lib/toolDeltas";

describe("tool delta display helpers", () => {
  it("uses concise labels for known and unknown tool deltas", () => {
    expect(groupToolDeltas([JSON.stringify({ type: "tool_use", name: "read", input: { path: "package.json" } })])[0].label).toBe("read");
    expect(groupToolDeltas([JSON.stringify({ type: "tool_result", content: "done" })])[0].label).toBe("Tool call");
  });

  it("infers bash completion from prior deltas for the same tool call", () => {
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
        label: "bash complete",
        content: expect.stringContaining('"command": "pwd"')
      })
    ]);
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
    expect(groups[0]).toEqual(expect.objectContaining({ key: firstId, label: "bash complete" }));
    expect(groups[0].content).toContain("/tmp");
    expect(groups[1]).toEqual(expect.objectContaining({ key: secondId, label: "read" }));
    expect(groups[1].content).toContain("{}");
  });

  it("extracts raw ids separately from display values", () => {
    expect(rawToolDeltaId({ id: "019e30fc-d214-7349-8b1c-b149337ace1e" })).toBe("019e30fc-d214-7349-8b1c-b149337ace1e");
  });
});

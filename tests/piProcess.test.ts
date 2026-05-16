import { describe, expect, it } from "vitest";
import { buildPiArgs, createPiRpcCommand } from "../server/piProcess";

describe("Pi process helpers", () => {
  it("serializes UI commands into Pi RPC command objects", () => {
    expect(createPiRpcCommand("prompt", { message: "hello", type: "not-prompt" })).toEqual({
      type: "prompt",
      message: "hello"
    });
  });

  it("builds Pi RPC startup arguments", () => {
    expect(
      buildPiArgs({
        provider: "anthropic",
        model: "claude",
        noSession: true,
        sessionDir: "/tmp/pi",
        session: "abc123",
        extraArgs: "--debug 'two words'"
      })
    ).toEqual([
      "--mode",
      "rpc",
      "--provider",
      "anthropic",
      "--model",
      "claude",
      "--no-session",
      "--session-dir",
      "/tmp/pi",
      "--session",
      "abc123",
      "--debug",
      "two words"
    ]);
  });
});

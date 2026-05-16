import { describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "../src/lib/clipboard";

describe("copyTextToClipboard", () => {
  it("writes the exact message text to the Clipboard API", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    await copyTextToClipboard("Line one\n\n- Line two", { clipboard: { writeText } });

    expect(writeText).toHaveBeenCalledWith("Line one\n\n- Line two");
  });
});

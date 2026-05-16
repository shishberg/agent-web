import { describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "../src/lib/clipboard";

describe("copyTextToClipboard", () => {
  it("writes the exact message text to the Clipboard API", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    await copyTextToClipboard("Line one\n\n- Line two", { clipboard: { writeText } });

    expect(writeText).toHaveBeenCalledWith("Line one\n\n- Line two");
  });

  it("falls back to a hidden textarea when the Clipboard API fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("blocked"));
    const textarea = {
      value: "",
      style: {},
      setAttribute: vi.fn(),
      focus: vi.fn(),
      select: vi.fn(),
      setSelectionRange: vi.fn()
    };
    const document = {
      body: {
        appendChild: vi.fn(),
        removeChild: vi.fn()
      },
      createElement: vi.fn(() => textarea),
      execCommand: vi.fn(() => true),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    await expect(
      copyTextToClipboard("Exact\n\nmessage text", {
        clipboard: { writeText },
        document
      })
    ).resolves.toBe(true);

    expect(textarea.value).toBe("Exact\n\nmessage text");
    expect(document.body.appendChild).toHaveBeenCalledWith(textarea);
    expect(textarea.select).toHaveBeenCalled();
    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(document.body.removeChild).toHaveBeenCalledWith(textarea);
  });

  it("throws only after both Clipboard API and fallback copying fail", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("blocked"));
    const document = {
      body: {
        appendChild: vi.fn(),
        removeChild: vi.fn()
      },
      createElement: vi.fn(() => ({
        value: "",
        style: {},
        setAttribute: vi.fn(),
        focus: vi.fn(),
        select: vi.fn(),
        setSelectionRange: vi.fn()
      })),
      execCommand: vi.fn(() => false),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };

    await expect(copyTextToClipboard("Nope", { clipboard: { writeText }, document })).rejects.toThrow(
      "Copy to clipboard failed."
    );
  });
});

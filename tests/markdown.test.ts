import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/lib/markdown";

describe("renderMarkdown", () => {
  it("renders common Markdown elements", () => {
    const html = renderMarkdown("**Bold** and _em_\n\n- one\n- two\n\n`code`");

    expect(html).toContain("<strong>Bold</strong>");
    expect(html).toContain("<em>em</em>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<code>code</code>");
  });

  it("escapes raw HTML and rejects unsafe links", () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1))');

    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("href=\"javascript:");
  });

  it("renders tables and safe images for constrained bubble styling", () => {
    const html = renderMarkdown("| A | B |\n| - | - |\n| one | two |\n\n![alt](https://example.com/image.png)");

    expect(html).toContain("<table>");
    expect(html).toContain("<img");
    expect(html).toContain('src="https://example.com/image.png"');
  });
});

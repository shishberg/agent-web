import { describe, expect, it } from "vitest";
import { isAllowedOrigin } from "../server/origin";

describe("WebSocket origin checks", () => {
  it("allows same-host and local browser origins", () => {
    expect(isAllowedOrigin("http://127.0.0.1:4177", "127.0.0.1", 4177)).toBe(true);
    expect(isAllowedOrigin("http://localhost:4177", "127.0.0.1", 4177)).toBe(true);
    expect(isAllowedOrigin("http://kodama.local:4177", "127.0.0.1", 4177)).toBe(true);
    expect(isAllowedOrigin("http://kodama.local:4177", "0.0.0.0", 4177)).toBe(true);
    expect(isAllowedOrigin("http://[::1]:4177", "::1", 4177)).toBe(true);
  });

  it("rejects cross-site browser origins", () => {
    expect(isAllowedOrigin("https://example.com", "127.0.0.1", 4177)).toBe(false);
    expect(isAllowedOrigin("http://localhost:5173", "127.0.0.1", 4177)).toBe(false);
  });

  it("keeps the configured bind host usable", () => {
    expect(isAllowedOrigin("http://pi.local:4177", "pi.local", 4177)).toBe(true);
    expect(isAllowedOrigin("http://localhost:4177", "pi.local", 4177)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { JsonlFramer } from "../server/jsonlFramer";

describe("JsonlFramer", () => {
  it("emits complete LF-delimited JSON lines across chunks", () => {
    const framer = new JsonlFramer();

    expect(framer.push(Buffer.from('{"type":"one"}\n{"type"'))).toEqual([
      { type: "one" }
    ]);
    expect(framer.push(Buffer.from(':"two"}\n'))).toEqual([{ type: "two" }]);
  });

  it("strips one trailing carriage return but preserves other content", () => {
    const framer = new JsonlFramer();

    expect(framer.push(Buffer.from('{"text":"a\\\\rb"}\r\n'))).toEqual([
      { text: "a\\rb" }
    ]);
  });

  it("keeps unterminated data buffered until close reports it", () => {
    const framer = new JsonlFramer();

    expect(framer.push(Buffer.from('{"type":"partial"}'))).toEqual([]);
    expect(framer.flush()).toEqual(['{"type":"partial"}']);
  });
});

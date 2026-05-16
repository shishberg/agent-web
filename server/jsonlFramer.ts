export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export class JsonlFramer {
  private buffered = "";

  push(chunk: Buffer | string): JsonValue[] {
    this.buffered += chunk.toString();
    const lines = this.buffered.split("\n");
    this.buffered = lines.pop() ?? "";

    return lines.filter((line) => line.length > 0).map((line) => {
      const cleanLine = line.endsWith("\r") ? line.slice(0, -1) : line;
      return JSON.parse(cleanLine) as JsonValue;
    });
  }

  flush(): string[] {
    if (!this.buffered) {
      return [];
    }

    const remaining = this.buffered;
    this.buffered = "";
    return [remaining];
  }
}

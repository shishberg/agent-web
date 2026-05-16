import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { JsonlFramer, type JsonValue } from "./jsonlFramer";

export type PiSessionConfig = {
  provider?: string;
  model?: string;
  noSession?: boolean;
  sessionDir?: string;
  extraArgs?: string;
};

export type PiProcessEvent =
  | { type: "status"; status: "starting" | "running" | "exited"; code?: number | null; signal?: NodeJS.Signals | null }
  | { type: "event"; event: JsonValue }
  | { type: "response"; response: JsonValue }
  | { type: "stderr"; data: string }
  | { type: "spawn_error"; message: string }
  | { type: "framing_error"; message: string }
  | { type: "write_error"; message: string };

export class PiProcess extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly framer = new JsonlFramer();

  start(config: PiSessionConfig): void {
    if (this.child) {
      return;
    }

    const command = process.env.PI_COMMAND?.trim() || "pi";
    const args = buildPiArgs(config);
    this.emitEvent({ type: "status", status: "starting" });

    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });
    const child = this.child;
    let settled = false;

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const record of this.framer.push(chunk)) {
          if (isObjectRecord(record) && record.type === "response") {
            this.emitEvent({ type: "response", response: record });
          } else {
            this.emitEvent({ type: "event", event: record });
          }
        }
      } catch (error) {
        this.emitEvent({ type: "framing_error", message: error instanceof Error ? error.message : String(error) });
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      this.emitEvent({ type: "stderr", data: chunk.toString() });
    });

    child.on("spawn", () => {
      this.emitEvent({ type: "status", status: "running" });
    });

    child.on("error", (error) => {
      settled = true;
      this.emitEvent({ type: "spawn_error", message: error.message });
      this.emitEvent({ type: "status", status: "exited", code: null, signal: null });
      this.child = null;
    });

    child.on("exit", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      for (const leftover of this.framer.flush()) {
        this.emitEvent({ type: "framing_error", message: `Pi stdout ended with incomplete JSONL frame: ${leftover}` });
      }
      this.emitEvent({ type: "status", status: "exited", code, signal });
      this.child = null;
    });
  }

  send(value: Record<string, unknown>): void {
    if (!this.child || !this.child.stdin.writable) {
      this.emitEvent({ type: "write_error", message: "Pi process is not running." });
      return;
    }

    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  stop(): void {
    if (!this.child) {
      return;
    }
    this.child.kill("SIGTERM");
  }

  private emitEvent(event: PiProcessEvent): void {
    this.emit("pi-event", event);
  }
}

function isObjectRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createPiRpcCommand(command: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...payload, type: command };
}

export function buildPiArgs(config: PiSessionConfig): string[] {
  const args = ["--mode", "rpc"];

  if (config.provider?.trim()) {
    args.push("--provider", config.provider.trim());
  }
  if (config.model?.trim()) {
    args.push("--model", config.model.trim());
  }
  if (config.noSession) {
    args.push("--no-session");
  }
  if (config.sessionDir?.trim()) {
    args.push("--session-dir", config.sessionDir.trim());
  }
  if (config.extraArgs?.trim()) {
    args.push(...splitArgs(config.extraArgs));
  }

  return args;
}

function splitArgs(input: string): string[] {
  const matches = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return matches.map((arg) => arg.replace(/^(['"])(.*)\1$/, "$2"));
}

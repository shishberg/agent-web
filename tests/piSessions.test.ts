import { beforeEach, describe, expect, it, vi } from "vitest";

const list = vi.fn();

vi.mock("@earendil-works/pi-coding-agent", () => ({
  SessionManager: { list }
}));

describe("Pi session catalog", () => {
  beforeEach(() => {
    list.mockReset();
  });

  it("lists Pi-owned sessions for the project cwd", async () => {
    list.mockResolvedValue([
      {
        path: "/tmp/pi/session-older.jsonl",
        id: "older",
        cwd: "/repo",
        created: new Date("2026-01-01T00:00:00.000Z"),
        modified: new Date("2026-01-01T01:00:00.000Z"),
        messageCount: 2,
        firstMessage: "older session",
        allMessagesText: "older session"
      },
      {
        path: "/tmp/pi/session-newer.jsonl",
        id: "newer",
        cwd: "/repo",
        name: "Named session",
        created: new Date("2026-01-02T00:00:00.000Z"),
        modified: new Date("2026-01-02T01:00:00.000Z"),
        messageCount: 4,
        firstMessage: "newer first message",
        allMessagesText: "newer first message"
      }
    ]);

    await expect(listPiSessions("/repo", "/tmp/pi")).resolves.toEqual([
      {
        id: "newer",
        path: "/tmp/pi/session-newer.jsonl",
        cwd: "/repo",
        title: "Named session",
        created: "2026-01-02T00:00:00.000Z",
        modified: "2026-01-02T01:00:00.000Z",
        messageCount: 4,
        firstMessage: "newer first message"
      },
      {
        id: "older",
        path: "/tmp/pi/session-older.jsonl",
        cwd: "/repo",
        title: "older session",
        created: "2026-01-01T00:00:00.000Z",
        modified: "2026-01-01T01:00:00.000Z",
        messageCount: 2,
        firstMessage: "older session"
      }
    ]);
    expect(list).toHaveBeenCalledWith("/repo", "/tmp/pi");
  });

  it("falls back to a stable title when Pi has no name or first message", async () => {
    list.mockResolvedValue([
      {
        path: "/tmp/pi/session-empty.jsonl",
        id: "empty",
        cwd: "/repo",
        created: new Date("2026-01-01T00:00:00.000Z"),
        modified: new Date("2026-01-01T01:00:00.000Z"),
        messageCount: 0,
        firstMessage: "",
        allMessagesText: ""
      }
    ]);

    await expect(listPiSessions("/repo")).resolves.toEqual([
      expect.objectContaining({
        id: "empty",
        title: "Untitled session"
      })
    ]);
    expect(list).toHaveBeenCalledWith("/repo", undefined);
  });
});

async function listPiSessions(cwd: string, sessionDir?: string) {
  const module = await import("../server/piSessions");
  return module.listPiSessions(cwd, sessionDir);
}

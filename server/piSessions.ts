import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";

export type PiSessionSummary = {
  id: string;
  path: string;
  cwd: string;
  title: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
};

export async function listPiSessions(cwd: string, sessionDir?: string): Promise<PiSessionSummary[]> {
  const sessions = await SessionManager.list(cwd, sessionDir);
  return sessions
    .map(toSummary)
    .sort((left, right) => Date.parse(right.modified) - Date.parse(left.modified));
}

function toSummary(session: SessionInfo): PiSessionSummary {
  return {
    id: session.id,
    path: session.path,
    cwd: session.cwd,
    title: sessionTitle(session),
    created: session.created.toISOString(),
    modified: session.modified.toISOString(),
    messageCount: session.messageCount,
    firstMessage: session.firstMessage
  };
}

function sessionTitle(session: SessionInfo): string {
  const title = session.name?.trim() || session.firstMessage.replace(/\s+/g, " ").trim();
  return title || "Untitled session";
}

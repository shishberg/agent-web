import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PiDirectSessionManager } from "../server/backends/piDirect/piDirectSessionManager";
import type {
	PersistedSessionReader,
	PiProcessLike,
} from "../server/runnerCore";
import type { SessionSummary } from "../src/lib/sessionApi";

class FakePiProcess extends EventEmitter implements PiProcessLike {
	readonly starts: unknown[] = [];
	readonly sent: Record<string, unknown>[] = [];
	stopped = false;

	start(config: unknown): void {
		this.starts.push(config);
	}

	send(value: Record<string, unknown>): void {
		this.sent.push(value);
	}

	stop(): void {
		this.stopped = true;
	}
}

function fakeOpenSession(path: string): PersistedSessionReader {
	return {
		buildSessionContext: () => ({
			messages: [{ role: "user", content: "hello from " + path }],
			model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
			thinkingLevel: "medium",
		}),
		getSessionId: () =>
			path.includes("saved") ? "saved-session-id" : "other-id",
		getSessionFile: () => path,
		getCwd: () => "/repo",
		getSessionName: () => "Saved session",
		getHeader: () => ({
			type: "session",
			id: "saved-session-id",
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd: "/repo",
		}),
	};
}

function mockPiSession(
	id: string,
	path: string,
	title: string,
	modified = "2026-05-21T00:00:00.000Z",
) {
	return {
		id,
		path,
		cwd: "/repo",
		title,
		created: "2026-05-20T00:00:00.000Z",
		modified,
		messageCount: 3,
		firstMessage: title,
	};
}

describe("PiDirectSessionManager", () => {
	let process: FakePiProcess;
	let processes: FakePiProcess[];
	let listSessions: ReturnType<typeof vi.fn>;
	let openSession: ReturnType<typeof vi.fn>;
	let manager: PiDirectSessionManager;

	beforeEach(() => {
		process = new FakePiProcess();
		processes = [process];
		listSessions = vi.fn().mockResolvedValue([]);
		openSession = vi.fn(fakeOpenSession);

		manager = new PiDirectSessionManager({
			cwd: "/repo",
			sessionDir: "/tmp/pi",
			createPiProcess: () => {
				const next = processes.find(
					(c) => c.starts.length === 0 && c.sent.length === 0,
				);
				if (next) {
					return next;
				}
				const created = new FakePiProcess();
				processes.push(created);
				return created;
			},
			listSessions,
			openSession,
		});
	});

	describe("capabilities", () => {
		it("declares supported backend capabilities", () => {
			expect(manager.capabilities.createSession).toBe(true);
			expect(manager.capabilities.deleteSession).toBe(false);
			expect(manager.capabilities.stopSession).toBe(true);
			expect(manager.capabilities.setSessionMetadata).toBe(false);
			expect(manager.capabilities.sendMessage).toBe(true);
			expect(manager.capabilities.respondToUserRequest).toBe(true);
			expect(manager.capabilities.backgroundSessions).toBe(false);
		});
	});

	describe("listSessions", () => {
		it("returns an empty list when no Pi sessions exist", async () => {
			const sessions = await manager.listSessions();
			expect(sessions).toEqual([]);
		});

		it("returns Pi sessions mapped to session summaries", async () => {
			listSessions.mockResolvedValue([
				mockPiSession("s1", "/tmp/pi/s1.jsonl", "Session one"),
				mockPiSession(
					"s2",
					"/tmp/pi/s2.jsonl",
					"Session two",
					"2026-05-22T00:00:00.000Z",
				),
			]);

			const sessions = await manager.listSessions();
			expect(sessions).toHaveLength(2);
			expect(sessions[0].id).toBe("s2");
			expect(sessions[0].title).toBe("Session two");
			expect(sessions[1].id).toBe("s1");
		});

		it("filters sessions by status query", async () => {
			listSessions.mockResolvedValue([
				mockPiSession("s1", "/tmp/pi/s1.jsonl", "Session one"),
			]);

			const sessions = await manager.listSessions({ status: "running" });
			expect(sessions).toEqual([]);
		});
	});

	describe("createSession", () => {
		it("creates a draft session when no prompt is provided", async () => {
			const summary = await manager.createSession({
				title: "Draft session",
				kind: "manual",
			});

			expect(summary.id).toMatch(/^draft-/);
			expect(summary.title).toBe("Draft session");
			expect(summary.status).toBe("idle");
			expect(summary.kind).toBe("manual");
			expect(summary.createdAt).toBeDefined();
		});

		it("starts Pi and returns a session summary when a prompt is provided", async () => {
			const resultPromise = manager.createSession({ prompt: "Hello, Pi!" });

			// Pi should report session creation — emit via the PiRunnerCore event path
			process.emit("pi-event", {
				type: "response",
				response: {
					id: "session-1-new",
					command: "new_session",
					success: true,
					data: { sessionFile: "/tmp/pi/new.jsonl" },
				},
			});

			process.emit("pi-event", {
				type: "response",
				response: {
					id: "hydrate-1-state",
					command: "get_state",
					success: true,
					data: {
						sessionId: "new-session-id",
						sessionFile: "/tmp/pi/new.jsonl",
						cwd: "/repo",
						sessionName: "Hello, Pi!",
					},
				},
			});

			const summary = await resultPromise;

			expect(summary.id).toBe("new-session-id");
			expect(summary.title).toBe("Hello, Pi!");
			expect(summary.status).toBe("running");
			expect(summary.sessionPath).toBe("/tmp/pi/new.jsonl");
			expect(process.starts.length).toBeGreaterThan(0);
			expect(process.sent).toContainEqual({
				type: "new_session",
				id: "session-1-new",
			});
		});

		it("sends config fields as Pi commands, not process start args", async () => {
			const resultPromise = manager.createSession({
				prompt: "test",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				cwd: "/other-dir",
				projectId: "project-1",
			});

			process.emit("pi-event", {
				type: "response",
				response: {
					id: "session-1-new",
					command: "new_session",
					success: true,
					data: { sessionFile: "/tmp/pi/new.jsonl" },
				},
			});

			process.emit("pi-event", {
				type: "response",
				response: {
					id: "hydrate-1-state",
					command: "get_state",
					success: true,
					data: {
						sessionId: "config-session-id",
						sessionFile: "/tmp/pi/new.jsonl",
						cwd: "/repo",
						sessionName: "test",
					},
				},
			});

			const summary = await resultPromise;

			expect(summary.metadata).toMatchObject({
				projectId: "project-1",
				cwd: "/other-dir",
			});

			// Config fields go through the new_session command payload
			expect(process.sent).toContainEqual({
				type: "new_session",
				id: "session-1-new",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				cwd: "/other-dir",
			});
		});
	});

	describe("deleteSession", () => {
		it("rejects because PiDirect does not support deletion", async () => {
			await expect(manager.deleteSession("any-id")).rejects.toThrow(
				"not supported",
			);
		});
	});

	describe("openSession", () => {
		it("opens a persisted Pi session and returns a snapshot", async () => {
			listSessions.mockResolvedValue([
				mockPiSession("saved-session-id", "/tmp/pi/saved.jsonl", "Saved"),
			]);

			await manager.listSessions();
			const snapshot = await manager.openSession("saved-session-id");

			expect(snapshot.session.id).toBe("saved-session-id");
			expect(snapshot.messages).toEqual([
				{ role: "user", content: "hello from /tmp/pi/saved.jsonl" },
			]);
			expect(snapshot.state).toBeDefined();
			expect(snapshot.streamCursor).toBe("");
		});

		it("throws when session is not found", async () => {
			await expect(manager.openSession("nonexistent")).rejects.toThrow(
				"Session not found",
			);
		});

		it("normalizes session-file records into frontend-ready messages", async () => {
			openSession.mockImplementation((path: string) => ({
				buildSessionContext: () => ({
					messages: [
						{ type: "session", id: "s1", cwd: "/repo" },
						{ type: "model_change", modelId: "claude" },
						{
							type: "message",
							id: "rec-1",
							message: { role: "user", content: "from " + path },
						},
						{
							type: "message",
							id: "rec-2",
							message: { role: "assistant", content: "reply from " + path },
						},
					],
					model: { provider: "anthropic", modelId: "claude" },
				}),
				getSessionId: () => "session-record-id",
				getSessionFile: () => path,
				getCwd: () => "/repo",
				getSessionName: () => "Record session",
				getHeader: () => ({ type: "session", id: "session-record-id" }),
			}));

			listSessions.mockResolvedValue([
				mockPiSession(
					"session-record-id",
					"/tmp/pi/record.jsonl",
					"Record",
				),
			]);

			await manager.listSessions();
			const snapshot = await manager.openSession("session-record-id");

			// Metadata records are stripped; message records are unwrapped.
			// Wrapper ids are preserved as fallbacks since inner messages lack them.
			expect(snapshot.messages).toEqual([
				{ role: "user", content: "from /tmp/pi/record.jsonl", id: "rec-1" },
				{ role: "assistant", content: "reply from /tmp/pi/record.jsonl", id: "rec-2" },
			]);
		});
	});

	describe("sendMessage", () => {
		it("activates a draft session and sends the first message", async () => {
			const draft = await manager.createSession({ title: "My draft" });

			const sendPromise = manager.sendMessage(draft.id, "First message");

			process.emit("pi-event", {
				type: "response",
				response: {
					id: "session-1-new",
					command: "new_session",
					success: true,
					data: { sessionFile: "/tmp/pi/activated.jsonl" },
				},
			});

			process.emit("pi-event", {
				type: "response",
				response: {
					id: "hydrate-1-state",
					command: "get_state",
					success: true,
					data: {
						sessionId: "activated-id",
						sessionFile: "/tmp/pi/activated.jsonl",
						cwd: "/repo",
						sessionName: "First message",
					},
				},
			});

			const result = await sendPromise;

			expect(result.queued).toBe(false);
			expect(process.sent).toContainEqual({
				type: "new_session",
				id: "session-1-new",
			});
			expect(process.sent).toContainEqual({
				type: "prompt",
				message: "First message",
			});
		});

		it("sends a prompt to an active session by session path", async () => {
			listSessions.mockResolvedValue([
				mockPiSession("s1", "/tmp/pi/s1.jsonl", "Existing"),
			]);

			await manager.listSessions();

			const resultPromise = manager.sendMessage("s1", "follow-up message");

			const result = await resultPromise;
			expect(result.queued).toBe(false);
		});

		it("does not add streamingBehavior on the first prompt of a new runner", async () => {
			// PiRunnerCore only adds streamingBehavior when activeTurn is true.
			// The first prompt on a brand-new runner has activeTurn=false,
			// so queueMode is silently ignored (this is expected Pi behavior).
			const draft = await manager.createSession({ title: "Test" });

			const sendPromise = manager.sendMessage(draft.id, "steered message", {
				mode: "followUp",
			});

			process.emit("pi-event", {
				type: "response",
				response: {
					id: "session-1-new",
					command: "new_session",
					success: true,
					data: { sessionFile: "/tmp/pi/follow.jsonl" },
				},
			});

			process.emit("pi-event", {
				type: "response",
				response: {
					id: "hydrate-1-state",
					command: "get_state",
					success: true,
					data: {
						sessionId: "follow-id",
						sessionFile: "/tmp/pi/follow.jsonl",
						cwd: "/repo",
						sessionName: "Test",
					},
				},
			});

			await sendPromise;

			// The prompt IS sent — just without streamingBehavior (activeTurn=false)
			expect(process.sent).toContainEqual({
				type: "prompt",
				message: "steered message",
			});
		});

		it("throws when session is not found", async () => {
			await expect(manager.sendMessage("nonexistent", "msg")).rejects.toThrow(
				"Session not found",
			);
		});
	});

	describe("stopSession", () => {
		it("stops the Pi process for a running session", async () => {
			const resultPromise = manager.createSession({
				prompt: "Running session",
			});

			process.emit("pi-event", {
				type: "response",
				response: {
					id: "session-1-new",
					command: "new_session",
					success: true,
					data: { sessionFile: "/tmp/pi/stop-me.jsonl" },
				},
			});

			process.emit("pi-event", {
				type: "response",
				response: {
					id: "hydrate-1-state",
					command: "get_state",
					success: true,
					data: {
						sessionId: "stop-me-id",
						sessionFile: "/tmp/pi/stop-me.jsonl",
						cwd: "/repo",
						sessionName: "Running session",
					},
				},
			});

			const summary = await resultPromise;

			await manager.stopSession(summary.id);

			expect(process.stopped).toBe(true);
		});

		it("throws when session is not found", async () => {
			await expect(manager.stopSession("nonexistent")).rejects.toThrow(
				"Session not found",
			);
		});
	});

	describe("respondToUserRequest", () => {
		it("sends an extension_ui_response command for a known session", async () => {
			listSessions.mockResolvedValue([
				mockPiSession("req-session", "/tmp/pi/req.jsonl", "Request session"),
			]);

			await manager.listSessions();

			await manager.respondToUserRequest("req-session", {
				id: "ext-1",
				confirmed: true,
				value: "approved",
			});

			// sessionPath is used by PiRunnerCore for routing, then stripped from the command
			expect(process.sent).toContainEqual({
				type: "extension_ui_response",
				id: "ext-1",
				confirmed: true,
				value: "approved",
			});
		});

		it("throws when session is not found", async () => {
			await expect(
				manager.respondToUserRequest("nonexistent", { id: "req-1" }),
			).rejects.toThrow("Session not found");
		});
	});

	describe("subscribeToSession", () => {
		it("delivers Pi events to session subscribers as StreamEvents", async () => {
			const resultPromise = manager.createSession({ prompt: "subscribe test" });

			process.emit("pi-event", {
				type: "response",
				response: {
					id: "session-1-new",
					command: "new_session",
					success: true,
					data: { sessionFile: "/tmp/pi/sub.jsonl" },
				},
			});

			process.emit("pi-event", {
				type: "response",
				response: {
					id: "hydrate-1-state",
					command: "get_state",
					success: true,
					data: {
						sessionId: "sub-id",
						sessionFile: "/tmp/pi/sub.jsonl",
						cwd: "/repo",
						sessionName: "subscribe test",
					},
				},
			});

			const summary = await resultPromise;

			const events: unknown[] = [];
			const unsub = manager.subscribeToSession(summary.id, (event) =>
				events.push(event),
			);

			process.emit("pi-event", {
				type: "event",
				event: { type: "message_start", role: "assistant" },
			});

			expect(events).toHaveLength(1);
			const streamEvent = events[0] as Record<string, unknown>;
			expect(streamEvent.type).toBe("pi.event");
			expect(streamEvent.sessionId).toBe("sub-id");
			expect(streamEvent.eventId).toMatch(/^evt-/);

			unsub();
		});

		it("wraps extension UI requests as user_request.created events", async () => {
			const resultPromise = manager.createSession({ prompt: "extension test" });

			process.emit("pi-event", {
				type: "response",
				response: {
					id: "session-1-new",
					command: "new_session",
					success: true,
					data: { sessionFile: "/tmp/pi/ext.jsonl" },
				},
			});

			process.emit("pi-event", {
				type: "response",
				response: {
					id: "hydrate-1-state",
					command: "get_state",
					success: true,
					data: {
						sessionId: "ext-id",
						sessionFile: "/tmp/pi/ext.jsonl",
						cwd: "/repo",
						sessionName: "extension test",
					},
				},
			});

			const summary = await resultPromise;

			const events: unknown[] = [];
			manager.subscribeToSession(summary.id, (event) => events.push(event));

			process.emit("pi-event", {
				type: "event",
				event: {
					type: "extension_ui_request",
					id: "ext-99",
					method: "confirm",
				},
			});

			expect(events).toHaveLength(1);
			const streamEvent = events[0] as Record<string, unknown>;
			expect(streamEvent.type).toBe("user_request.created");
			expect(streamEvent.payload).toEqual({
				request: {
					type: "extension_ui_request",
					id: "ext-99",
					method: "confirm",
				},
			});
		});

		it("returns an unsubscribe function that removes the listener", async () => {
			const resultPromise = manager.createSession({ prompt: "unsub test" });

			process.emit("pi-event", {
				type: "response",
				response: {
					id: "session-1-new",
					command: "new_session",
					success: true,
					data: { sessionFile: "/tmp/pi/unsub.jsonl" },
				},
			});

			process.emit("pi-event", {
				type: "response",
				response: {
					id: "hydrate-1-state",
					command: "get_state",
					success: true,
					data: {
						sessionId: "unsub-id",
						sessionFile: "/tmp/pi/unsub.jsonl",
						cwd: "/repo",
						sessionName: "unsub test",
					},
				},
			});

			const summary = await resultPromise;

			const events: unknown[] = [];
			const unsub = manager.subscribeToSession(summary.id, (event) =>
				events.push(event),
			);

			unsub();

			process.emit("pi-event", {
				type: "event",
				event: { type: "message_start" },
			});

			expect(events).toEqual([]);
		});
	});

	describe("subscribeToSessionList", () => {
		it("calls the subscriber with the current session list", async () => {
			const updates: SessionSummary[][] = [];
			manager.subscribeToSessionList((sessions) => updates.push(sessions));

			// Allow the initial async load to settle
			await vi.waitFor(() => {
				expect(updates.length).toBeGreaterThanOrEqual(1);
			});

			expect(updates[0]).toEqual([]);
		});

		it("returns an unsubscribe function", () => {
			const unsub = manager.subscribeToSessionList(() => {});
			expect(typeof unsub).toBe("function");
			unsub();
		});
	});

	describe("Pi event routing", () => {
		it("updates session status to stopped when Pi exits", async () => {
			const resultPromise = manager.createSession({ prompt: "exit test" });

			process.emit("pi-event", {
				type: "response",
				response: {
					id: "session-1-new",
					command: "new_session",
					success: true,
					data: { sessionFile: "/tmp/pi/exit.jsonl" },
				},
			});

			process.emit("pi-event", {
				type: "response",
				response: {
					id: "hydrate-1-state",
					command: "get_state",
					success: true,
					data: {
						sessionId: "exit-id",
						sessionFile: "/tmp/pi/exit.jsonl",
						cwd: "/repo",
						sessionName: "exit test",
					},
				},
			});

			const summary = await resultPromise;
			expect(summary.status).toBe("running");

			const statusEvents: unknown[] = [];
			manager.subscribeToSession(summary.id, (event) => {
				if (event.type === "pi.status") {
					statusEvents.push(event);
				}
			});

			process.emit("pi-event", { type: "status", status: "exited", code: 0 });

			expect(statusEvents).toHaveLength(1);

			const sessions = await manager.listSessions();
			const updated = sessions.find((s) => s.id === summary.id);
			expect(updated?.status).toBe("stopped");
		});
	});
});

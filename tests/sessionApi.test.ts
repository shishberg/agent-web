import { describe, expect, it, vi } from "vitest";
import type {
	CreateSessionArgs,
	SendResult,
	SessionManager,
	SessionManagerCapabilities,
	SessionSnapshot,
	SessionSummary,
	StreamEvent,
	Unsubscribe,
	UserRequestResponse,
} from "../src/lib/sessionApi";

function makeEmptyView(sessionId = "s1") {
	return {
		session: { id: sessionId, title: "", status: "idle" as const },
		items: [],
		status: "idle" as const,
		statusText: "",
		pendingRequests: [],
		extensionDraft: null,
		cursor: "",
	};
}

function mockSessionManager(
	overrides: Partial<SessionManager> = {},
): SessionManager {
	return {
		capabilities: {
			createSession: true,
			deleteSession: true,
			stopSession: true,
			setSessionMetadata: false,
			sendMessage: true,
			respondToUserRequest: true,
			backgroundSessions: false,
		},
		listSessions: vi.fn().mockResolvedValue([]),
		createSession: vi
			.fn()
			.mockResolvedValue({ id: "s1", title: "", status: "idle" }),
		deleteSession: vi.fn().mockResolvedValue(undefined),
		openSession: vi.fn().mockResolvedValue({
			session: { id: "s1", title: "", status: "idle" },
			view: makeEmptyView(),
			streamCursor: "",
		}),
		sendMessage: vi.fn().mockResolvedValue({ queued: false }),
		stopSession: vi.fn().mockResolvedValue(undefined),
		respondToUserRequest: vi.fn().mockResolvedValue(undefined),
		subscribeToSession: vi.fn(() => vi.fn()),
		subscribeToSessionList: vi.fn(() => vi.fn()),
		openAndSubscribeSession: vi.fn().mockResolvedValue({
			snapshot: {
				session: { id: "s1", title: "", status: "idle" as const },
				view: makeEmptyView(),
				streamCursor: "",
			},
			unsubscribe: vi.fn(),
		}),
		...overrides,
	};
}

describe("SessionManager contract", () => {
	it("exports all required types", () => {
		// This test exists primarily to ensure the imports compile.
		// If any type is missing from the module, this file won't typecheck.
		const caps: SessionManagerCapabilities = {
			createSession: true,
			deleteSession: true,
			stopSession: true,
			setSessionMetadata: false,
			sendMessage: true,
			respondToUserRequest: false,
			backgroundSessions: false,
		};
		expect(caps.createSession).toBe(true);

		const unsub: Unsubscribe = () => {};
		expect(typeof unsub).toBe("function");

		const summary: SessionSummary = {
			id: "abc",
			title: "Test",
			status: "idle",
		};
		expect(summary.id).toBe("abc");

		const args: CreateSessionArgs = { prompt: "hello" };
		expect(args.prompt).toBe("hello");

		const snapshot: SessionSnapshot = {
			session: summary,
			view: makeEmptyView("abc"),
			streamCursor: "evt-1",
		};
		expect(snapshot.streamCursor).toBe("evt-1");

		const sendResult: SendResult = { queued: true, messageId: "msg-1" };
		expect(sendResult.messageId).toBe("msg-1");

		const event: StreamEvent = {
			type: "session.created",
			eventId: "evt-1",
			createdAt: new Date().toISOString(),
			payload: { session: summary },
		};
		expect(event.type).toBe("session.created");

		const response: UserRequestResponse = { id: "req-1", confirmed: true };
		expect(response.confirmed).toBe(true);
	});

	it("allows a compliant SessionManager mock", async () => {
		const mgr = mockSessionManager();

		const sessions = await mgr.listSessions();
		expect(sessions).toEqual([]);

		const session = await mgr.createSession({ prompt: "hi" });
		expect(session.id).toBe("s1");

		const snapshot = await mgr.openSession("s1");
		expect(snapshot.session.id).toBe("s1");

		const result = await mgr.sendMessage("s1", "hello");
		expect(result.queued).toBe(false);

		await mgr.stopSession("s1");

		const unsub = mgr.subscribeToSession("s1", () => {});
		unsub();
	});

	it("subscribeToSession accepts an optional cursor", () => {
		const onEvent = vi.fn();
		const mockSub = vi.fn(() => vi.fn());
		const mgr = mockSessionManager({ subscribeToSession: mockSub });

		mgr.subscribeToSession("s1", onEvent, { cursor: "evt-5" });

		expect(mockSub).toHaveBeenCalledWith("s1", onEvent, { cursor: "evt-5" });
	});

	it("subscribeToSessionList returns an unsubscribe function", () => {
		const onUpdate = vi.fn();
		const mgr = mockSessionManager();

		const unsub = mgr.subscribeToSessionList(onUpdate);
		expect(typeof unsub).toBe("function");
		unsub();
	});

	it("deleteSession accepts an optional force flag", async () => {
		const deleteSession = vi.fn().mockResolvedValue(undefined);
		const mgr = mockSessionManager({ deleteSession });

		await mgr.deleteSession("s1", { force: true });

		expect(deleteSession).toHaveBeenCalledWith("s1", { force: true });
	});

	it("respondToUserRequest sends id and confirm/cancel/value", async () => {
		const respond = vi.fn().mockResolvedValue(undefined);
		const mgr = mockSessionManager({ respondToUserRequest: respond });

		await mgr.respondToUserRequest("s1", {
			id: "req-1",
			confirmed: true,
			value: "approved",
		});

		expect(respond).toHaveBeenCalledWith("s1", {
			id: "req-1",
			confirmed: true,
			value: "approved",
		});
	});
});

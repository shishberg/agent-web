import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRpcSessionManager } from "../src/lib/rpcSessionManager";
import type { SessionSummary, StreamEvent } from "../src/lib/sessionApi";

type FetchCall = {
	url: string;
	init?: RequestInit;
};

const eventSources: MockEventSource[] = [];
let fetchCalls: FetchCall[] = [];
let fetchQueue: Response[] = [];
let originalFetch: typeof globalThis.fetch;
let originalEventSource: typeof globalThis.EventSource | undefined;

describe("RpcSessionManager", () => {
	beforeEach(() => {
		fetchCalls = [];
		fetchQueue = [];
		eventSources.length = 0;
		originalFetch = globalThis.fetch;
		originalEventSource = globalThis.EventSource;

		globalThis.fetch = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				fetchCalls.push({ url: String(input), init });
				const response = fetchQueue.shift();
				if (!response) {
					throw new Error("Unexpected fetch call");
				}
				return response;
			},
		) as typeof fetch;

		globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		globalThis.EventSource = originalEventSource as typeof EventSource;
	});

	it("lists sessions with encoded query params", async () => {
		const sessions: SessionSummary[] = [
			{ id: "s1", title: "One", status: "idle" },
		];
		queueJson({ sessions });
		const manager = createRpcSessionManager({
			baseUrl: "http://example.test/root",
		});

		await expect(
			manager.listSessions({ status: "running now", kind: "manual/task" }),
		).resolves.toEqual(sessions);

		expect(fetchCalls[0]).toMatchObject({
			url: "http://example.test/root/api/sessions?status=running+now&kind=manual%2Ftask",
		});
		expect(fetchCalls[0].init?.method).toBe("GET");
	});

	it("creates sessions with a JSON POST body", async () => {
		queueJson({ id: "s1", title: "Created", status: "idle" }, 201);
		const manager = createRpcSessionManager();

		await expect(
			manager.createSession({ prompt: "hello", kind: "manual" }),
		).resolves.toEqual({ id: "s1", title: "Created", status: "idle" });

		expect(fetchCalls[0]).toMatchObject({ url: "/api/sessions" });
		expect(fetchCalls[0].init).toMatchObject({
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "hello", kind: "manual" }),
		});
	});

	it("opens and deletes encoded session paths", async () => {
		queueJson({
			session: { id: "session/1", title: "Open", status: "running" },
			messages: [],
			streamCursor: "evt-1",
		});
		queueEmpty(204);
		queueEmpty(204);
		const manager = createRpcSessionManager();

		await manager.openSession("session/1");
		await manager.deleteSession("session/1", { force: true });
		await manager.deleteSession("session/1");

		expect(fetchCalls[0]).toMatchObject({
			url: "/api/sessions/session%2F1",
			init: { method: "GET" },
		});
		expect(fetchCalls[1]).toMatchObject({
			url: "/api/sessions/session%2F1?force=true",
			init: { method: "DELETE" },
		});
		expect(fetchCalls[2]).toMatchObject({
			url: "/api/sessions/session%2F1",
			init: { method: "DELETE" },
		});
	});

	it("sends messages, stops sessions, and responds to requests", async () => {
		queueJson({ queued: true, messageId: "msg-1" });
		queueJson({ queued: true, messageId: "msg-2" });
		queueEmpty(204);
		queueEmpty(204);
		const manager = createRpcSessionManager();

		await expect(
			manager.sendMessage("s1", "hello", { mode: "followUp" }),
		).resolves.toEqual({ queued: true, messageId: "msg-1" });
		await expect(manager.sendMessage("s1", "plain")).resolves.toEqual({
			queued: true,
			messageId: "msg-2",
		});
		await manager.stopSession("s1");
		await manager.respondToUserRequest("s1", {
			id: "request/1",
			confirmed: true,
			value: { ok: true },
		});

		expect(fetchCalls[0]).toMatchObject({
			url: "/api/sessions/s1/messages",
			init: {
				method: "POST",
				body: JSON.stringify({ message: "hello", mode: "followUp" }),
			},
		});
		expect(fetchCalls[1]).toMatchObject({
			url: "/api/sessions/s1/messages",
			init: {
				method: "POST",
				body: JSON.stringify({ message: "plain" }),
			},
		});
		expect(fetchCalls[2]).toMatchObject({
			url: "/api/sessions/s1/messages",
			init: { method: "DELETE" },
		});
		expect(fetchCalls[3]).toMatchObject({
			url: "/api/sessions/s1/requests/request%2F1",
			init: {
				method: "POST",
				body: JSON.stringify({
					id: "request/1",
					confirmed: true,
					value: { ok: true },
				}),
			},
		});
	});

	it("calls fetch with globalThis as this receiver", async () => {
		let fetchThis: unknown = null;
		globalThis.fetch = vi.fn(async function (
			this: unknown,
			input: RequestInfo | URL,
			init?: RequestInit,
		) {
			fetchThis = this;
			fetchCalls.push({ url: String(input), init });
			const response = fetchQueue.shift();
			if (!response) throw new Error("Unexpected fetch call");
			return response;
		}) as typeof fetch;

		queueJson({ id: "s2", title: "Test", status: "idle" });
		const manager = createRpcSessionManager();
		await manager.openSession("s2");

		expect(fetchThis).toBe(globalThis);
	});

	it("throws useful errors from JSON error responses", async () => {
		queueJson({ error: "not_found", message: "Session not found" }, 404);
		const manager = createRpcSessionManager();

		await expect(manager.openSession("missing")).rejects.toMatchObject({
			message: "Session not found",
			status: 404,
			body: { error: "not_found", message: "Session not found" },
		});
	});

	it("throws useful errors from non-JSON error responses", async () => {
		fetchQueue.push(
			new Response("plain failure", {
				status: 500,
				headers: { "content-type": "text/plain" },
			}),
		);
		const manager = createRpcSessionManager();

		await expect(manager.openSession("s1")).rejects.toMatchObject({
			message: "HTTP 500: plain failure",
			status: 500,
			body: "plain failure",
		});
	});

	it("subscribes to session streams and closes on unsubscribe", () => {
		const events: StreamEvent[] = [];
		const manager = createRpcSessionManager();

		const unsubscribe = manager.subscribeToSession(
			"session/1",
			(event) => events.push(event),
			{ cursor: "evt-1" },
		);

		expect(eventSources[0].url).toBe("/api/stream?session=session%2F1&cursor=evt-1");
		eventSources[0].dispatch("pi.event", {
			sessionId: "session/1",
			eventId: "evt-2",
			createdAt: "2026-05-26T00:00:00.000Z",
			payload: { event: { type: "turn_start" } },
		});

		expect(events).toEqual([
			{
				type: "pi.event",
				sessionId: "session/1",
				eventId: "evt-2",
				createdAt: "2026-05-26T00:00:00.000Z",
				payload: { event: { type: "turn_start" } },
			},
		]);

		unsubscribe();
		expect(eventSources[0].close).toHaveBeenCalledTimes(1);
	});

	it("maps list stream updates to session summaries", () => {
		const updates: SessionSummary[][] = [];
		const manager = createRpcSessionManager({ baseUrl: "http://example.test" });
		const unsubscribe = manager.subscribeToSessionList((sessions) =>
			updates.push(sessions),
		);

		expect(eventSources[0].url).toBe(
			"http://example.test/api/stream?list=true",
		);
		eventSources[0].dispatch("session.list.updated", {
			sessionId: null,
			eventId: "list-1",
			createdAt: "2026-05-26T00:00:00.000Z",
			payload: {
				sessions: [{ id: "s1", title: "One", status: "idle" }],
			},
		});
		eventSources[0].dispatch("pi.event", {
			eventId: "evt-1",
			createdAt: "2026-05-26T00:00:00.000Z",
			payload: {},
		});

		expect(updates).toEqual([[{ id: "s1", title: "One", status: "idle" }]]);
		unsubscribe();
		expect(eventSources[0].close).toHaveBeenCalledTimes(1);
	});
});

class MockEventSource {
	readonly url: string;
	readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();
	readonly close = vi.fn();

	constructor(url: string | URL) {
		this.url = String(url);
		eventSources.push(this);
	}

	addEventListener(
		type: string,
		listener: (event: MessageEvent) => void,
	): void {
		const listeners = this.listeners.get(type) ?? new Set();
		listeners.add(listener);
		this.listeners.set(type, listeners);
	}

	dispatch(type: string, data: unknown, lastEventId = ""): void {
		const event = {
			data: JSON.stringify(data),
			lastEventId,
		} as MessageEvent;
		this.listeners.get(type)?.forEach((listener) => listener(event));
	}
}

function queueJson(value: unknown, status = 200): void {
	fetchQueue.push(
		new Response(JSON.stringify(value), {
			status,
			headers: { "content-type": "application/json" },
		}),
	);
}

function queueEmpty(status: number): void {
	fetchQueue.push(new Response(null, { status }));
}

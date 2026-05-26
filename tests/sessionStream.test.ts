import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionStreamHandler } from "../server/sessionStream";
import type {
	SessionManager,
	SessionSummary,
	StreamEvent,
	Unsubscribe,
} from "../src/lib/sessionApi";

type MockSessionManager = SessionManager & {
	sessionCallbacks: Map<string, (event: StreamEvent) => void>;
	listCallbacks: Set<(sessions: SessionSummary[]) => void>;
	sessionUnsubscribe: ReturnType<typeof vi.fn>;
	listUnsubscribe: ReturnType<typeof vi.fn>;
};

describe("session SSE stream", () => {
	const servers: Server[] = [];

	afterEach(async () => {
		while (servers.length > 0) {
			await closeServer(servers.pop()!);
		}
	});

	it("returns 400 when neither session nor list is requested", async () => {
		const { url } = await startStreamServer(mockSessionManager());

		const response = await fetch(`${url}/api/stream`);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			ok: false,
			error: "stream_subscription_required",
		});
	});

	it("formats session StreamEvent envelopes as SSE", async () => {
		const manager = mockSessionManager();
		const { url } = await startStreamServer(manager);
		const response = await fetch(`${url}/api/stream?session=s1`);
		const reader = response.body!.getReader();

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		manager.sessionCallbacks.get("s1")?.({
			type: "pi.event",
			sessionId: "s1",
			eventId: "evt-1",
			createdAt: "2026-05-26T00:00:00.000Z",
			payload: { event: { type: "turn_start" } },
		});

		const chunk = await readUntil(reader, "\n\n");
		expect(chunk).toBe(
			'event: pi.event\nid: evt-1\ndata: {"sessionId":"s1","eventId":"evt-1","createdAt":"2026-05-26T00:00:00.000Z","payload":{"event":{"type":"turn_start"}}}\n\n',
		);
		await reader.cancel();
	});

	it("wraps list updates in session.list.updated StreamEvents with generated ids", async () => {
		const manager = mockSessionManager();
		const { url } = await startStreamServer(manager);
		const response = await fetch(`${url}/api/stream?list=true`);
		const reader = response.body!.getReader();

		manager.listCallbacks.forEach((callback) =>
			callback([{ id: "s1", title: "One", status: "idle" }]),
		);

		const chunk = await readUntil(reader, "\n\n");
		expect(chunk).toMatch(/^event: session\.list\.updated\nid: sse-1\ndata: /);
		const data = JSON.parse(chunk.split("data: ")[1]);
		expect(data).toMatchObject({
			sessionId: null,
			eventId: "sse-1",
			payload: { sessions: [{ id: "s1", title: "One", status: "idle" }] },
		});
		expect(typeof data.createdAt).toBe("string");
		await reader.cancel();
	});

	it("streams session and list events for combined subscriptions", async () => {
		const manager = mockSessionManager();
		const { url } = await startStreamServer(manager);
		const response = await fetch(`${url}/api/stream?session=s1&list=true`);
		const reader = response.body!.getReader();

		manager.sessionCallbacks.get("s1")?.(streamEvent("evt-1", "one"));
		const sessionChunk = await readUntil(reader, "\n\n");
		expect(sessionChunk).toContain("event: pi.event\nid: evt-1\n");
		expect(sessionChunk).toContain('"sessionId":"s1"');

		manager.listCallbacks.forEach((callback) =>
			callback([{ id: "s2", title: "Two", status: "running" }]),
		);
		const listChunk = await readUntil(reader, "\n\n");
		expect(listChunk).toMatch(
			/^event: session\.list\.updated\nid: sse-1\ndata: /,
		);
		expect(listChunk).toContain('"sessionId":null');
		expect(listChunk).toContain('"id":"s2"');
		await reader.cancel();
	});

	it("sends heartbeat comments", async () => {
		const manager = mockSessionManager();
		const { url } = await startStreamServer(manager, { heartbeatMs: 10 });
		const response = await fetch(`${url}/api/stream?session=s1`);
		const reader = response.body!.getReader();

		const chunk = await readUntil(reader, ": heartbeat\n\n");
		expect(chunk).toContain(": heartbeat\n\n");
		await reader.cancel();
	});

	it("replays buffered events newer than Last-Event-ID before live events", async () => {
		const manager = mockSessionManager();
		const { url } = await startStreamServer(manager);
		const first = await fetch(`${url}/api/stream?session=s1`);
		const firstReader = first.body!.getReader();

		manager.sessionCallbacks.get("s1")?.(streamEvent("evt-1", "one"));
		await readUntil(firstReader, "id: evt-1");
		manager.sessionCallbacks.get("s1")?.(streamEvent("evt-2", "two"));
		await readUntil(firstReader, "id: evt-2");
		await firstReader.cancel();

		const replayed = await fetch(`${url}/api/stream?session=s1`, {
			headers: { "Last-Event-ID": "evt-1" },
		});
		const replayReader = replayed.body!.getReader();

		const replayChunk = await readUntil(replayReader, "\n\n");
		expect(replayChunk).toContain("event: pi.event\nid: evt-2\n");
		expect(replayChunk).toContain('"message":"two"');
		await replayReader.cancel();
	});

	it("unsubscribes when the client closes", async () => {
		const manager = mockSessionManager();
		const { url } = await startStreamServer(manager);
		const response = await fetch(`${url}/api/stream?session=s1&list=true`);
		const reader = response.body!.getReader();

		expect(manager.subscribeToSession).toHaveBeenCalledWith(
			"s1",
			expect.any(Function),
			{ cursor: undefined },
		);
		expect(manager.subscribeToSessionList).toHaveBeenCalledWith(
			expect.any(Function),
		);

		await reader.cancel();

		await expect
			.poll(() => manager.sessionUnsubscribe.mock.calls.length)
			.toBe(1);
		await expect.poll(() => manager.listUnsubscribe.mock.calls.length).toBe(1);
	});

	async function startStreamServer(
		manager: MockSessionManager,
		options: { heartbeatMs?: number } = {},
	): Promise<{ url: string; server: Server }> {
		const handleStream = createSessionStreamHandler({ manager, ...options });
		const server = createServer((req, res) => {
			if (handleStream(req, res)) {
				return;
			}
			res.writeHead(404);
			res.end();
		});
		servers.push(server);
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address() as AddressInfo;
		return { url: `http://127.0.0.1:${address.port}`, server };
	}
});

function mockSessionManager(): MockSessionManager {
	const sessionCallbacks = new Map<string, (event: StreamEvent) => void>();
	const listCallbacks = new Set<(sessions: SessionSummary[]) => void>();
	const sessionUnsubscribe = vi.fn();
	const listUnsubscribe = vi.fn();

	return {
		capabilities: {
			createSession: true,
			deleteSession: false,
			stopSession: true,
			setSessionMetadata: false,
			sendMessage: true,
			respondToUserRequest: true,
			backgroundSessions: false,
		},
		listSessions: vi.fn().mockResolvedValue([]),
		createSession: vi.fn(),
		deleteSession: vi.fn(),
		openSession: vi.fn(),
		sendMessage: vi.fn(),
		stopSession: vi.fn(),
		respondToUserRequest: vi.fn(),
		subscribeToSession: vi.fn(
			(
				sessionId: string,
				onEvent: (event: StreamEvent) => void,
			): Unsubscribe => {
				sessionCallbacks.set(sessionId, onEvent);
				return sessionUnsubscribe;
			},
		),
		subscribeToSessionList: vi.fn(
			(onUpdate: (sessions: SessionSummary[]) => void): Unsubscribe => {
				listCallbacks.add(onUpdate);
				return listUnsubscribe;
			},
		),
		sessionCallbacks,
		listCallbacks,
		sessionUnsubscribe,
		listUnsubscribe,
	};
}

function streamEvent(eventId: string, message: string): StreamEvent {
	return {
		type: "pi.event",
		sessionId: "s1",
		eventId,
		createdAt: "2026-05-26T00:00:00.000Z",
		payload: { event: { message } },
	};
}

async function readUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	needle: string,
): Promise<string> {
	const decoder = new TextDecoder();
	let text = "";
	const deadline = Date.now() + 1000;

	while (!text.includes(needle)) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new Error(`Timed out waiting for ${needle}; received ${text}`);
		}

		const result = await Promise.race([
			reader.read(),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error("read timeout")), remaining),
			),
		]);
		if (result.done) {
			break;
		}
		text += decoder.decode(result.value, { stream: true });
	}

	return text;
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

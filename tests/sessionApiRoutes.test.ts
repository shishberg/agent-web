import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionApiHandler } from "../server/sessionApiRoutes";
import type {
	CreateSessionArgs,
	SendResult,
	SessionManager,
	SessionManagerCapabilities,
	SessionSnapshot,
	SessionSummary,
	Unsubscribe,
	UserRequestResponse,
} from "../src/lib/sessionApi";

describe("session API routes", () => {
	const servers: Server[] = [];

	afterEach(async () => {
		while (servers.length > 0) {
			await closeServer(servers.pop()!);
		}
	});

	// ── GET /api/sessions ──

	it("lists sessions", async () => {
		const manager = mockSessionManager({
			listSessions: vi.fn().mockResolvedValue([
				{ id: "s1", title: "One", status: "idle" },
				{ id: "s2", title: "Two", status: "running" },
			]),
		});
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			sessions: [
				{ id: "s1", title: "One", status: "idle" },
				{ id: "s2", title: "Two", status: "running" },
			],
		});
	});

	it("passes status and kind query params to listSessions", async () => {
		const listSessions = vi.fn().mockResolvedValue([]);
		const manager = mockSessionManager({ listSessions });
		const { url } = await startServer(manager);

		await fetch(`${url}/api/sessions?status=running&kind=task`);
		expect(listSessions).toHaveBeenCalledWith({
			status: "running",
			kind: "task",
		});
	});

	it("omits query when both status and kind are absent", async () => {
		const listSessions = vi.fn().mockResolvedValue([]);
		const manager = mockSessionManager({ listSessions });
		const { url } = await startServer(manager);

		await fetch(`${url}/api/sessions`);
		expect(listSessions).toHaveBeenCalledWith(undefined);
	});

	it("returns 405 for unsupported methods on /api/sessions", async () => {
		const manager = mockSessionManager();
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions`, { method: "PUT" });
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("GET, POST");
		expect(await response.json()).toEqual({ error: "method_not_allowed" });
	});

	// ── POST /api/sessions ──

	it("creates a session and returns 201", async () => {
		const created: SessionSummary = {
			id: "new-s1",
			title: "Test session",
			status: "idle",
			kind: "manual",
		};
		const createSession = vi.fn().mockResolvedValue(created);
		const manager = mockSessionManager({ createSession });
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "hello", kind: "manual" }),
		});

		expect(response.status).toBe(201);
		expect(await response.json()).toEqual(created);
		expect(createSession).toHaveBeenCalledWith({
			prompt: "hello",
			kind: "manual",
		});
	});

	it("returns 400 on malformed JSON body for create", async () => {
		const manager = mockSessionManager();
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "not json",
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_json" });
	});

	it("returns 400 on empty body for create", async () => {
		const manager = mockSessionManager();
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "body_required" });
	});

	it("propagates error from createSession as 500", async () => {
		const manager = mockSessionManager({
			createSession: vi.fn().mockRejectedValue(new Error("something broke")),
		});
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "hi" }),
		});

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "something broke" });
	});

	// ── GET /api/sessions/{sessionId} ──

	it("opens and returns a session snapshot", async () => {
		const snapshot: SessionSnapshot = {
			session: { id: "s1", title: "One", status: "running" },
			messages: [{ type: "message_start" }],
			streamCursor: "evt-3",
		};
		const manager = mockSessionManager({
			openSession: vi.fn().mockResolvedValue(snapshot),
		});
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s1`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(snapshot);
		expect(manager.openSession).toHaveBeenCalledWith("s1");
	});

	it("returns 404 when openSession throws not-found", async () => {
		const manager = mockSessionManager({
			openSession: vi
				.fn()
				.mockRejectedValue(new Error("Session not found: s99")),
		});
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s99`);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "not_found" });
	});

	// ── PATCH /api/sessions/{sessionId} ──

	it("returns 501 when setSessionMetadata capability is false", async () => {
		const manager = mockSessionManager({
			capabilities: {
				...baseCapabilities,
				setSessionMetadata: false,
			},
		});
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s1`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ title: "Updated" }),
		});

		expect(response.status).toBe(501);
		expect(await response.json()).toEqual({
			error: "unsupported_capability",
			capability: "setSessionMetadata",
		});
	});

	it("returns 405 for unsupported methods on /api/sessions/{id}", async () => {
		const manager = mockSessionManager();
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s1`, {
			method: "PUT",
		});
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("GET, PATCH, DELETE");
	});

	// ── DELETE /api/sessions/{sessionId} ──

	it("returns 501 when deleteSession capability is false", async () => {
		const manager = mockSessionManager({
			capabilities: {
				...baseCapabilities,
				deleteSession: false,
			},
		});
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s1`, {
			method: "DELETE",
		});

		expect(response.status).toBe(501);
		expect(await response.json()).toEqual({
			error: "unsupported_capability",
			capability: "deleteSession",
		});
	});

	it("deletes a session and returns 204 when capability is true", async () => {
		const deleteSession = vi.fn().mockResolvedValue(undefined);
		const manager = mockSessionManager({
			capabilities: {
				...baseCapabilities,
				deleteSession: true,
			},
			deleteSession,
		});
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s1`, {
			method: "DELETE",
		});

		expect(response.status).toBe(204);
		expect(deleteSession).toHaveBeenCalledWith("s1", { force: false });
	});

	it("passes force=true query param to deleteSession", async () => {
		const deleteSession = vi.fn().mockResolvedValue(undefined);
		const manager = mockSessionManager({
			capabilities: {
				...baseCapabilities,
				deleteSession: true,
			},
			deleteSession,
		});
		const { url } = await startServer(manager);

		await fetch(`${url}/api/sessions/s1?force=true`, { method: "DELETE" });
		expect(deleteSession).toHaveBeenCalledWith("s1", { force: true });
	});

	it("returns 409 when deleteSession throws a running conflict", async () => {
		const manager = mockSessionManager({
			capabilities: {
				...baseCapabilities,
				deleteSession: true,
			},
			deleteSession: vi.fn().mockRejectedValue(new Error("Session is running")),
		});
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s1`, {
			method: "DELETE",
		});

		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "conflict",
			message: "Session is running",
		});
	});

	it("returns 404 when deleteSession throws not-found", async () => {
		const manager = mockSessionManager({
			capabilities: {
				...baseCapabilities,
				deleteSession: true,
			},
			deleteSession: vi
				.fn()
				.mockRejectedValue(new Error("Session not found: s99")),
		});
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s99`, {
			method: "DELETE",
		});

		expect(response.status).toBe(404);
	});

	// ── POST /api/sessions/{sessionId}/messages ──

	it("sends a message and returns SendResult", async () => {
		const result: SendResult = { queued: true, messageId: "msg-1" };
		const sendMessage = vi.fn().mockResolvedValue(result);
		const manager = mockSessionManager({ sendMessage });
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "hello" }),
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(result);
		expect(sendMessage).toHaveBeenCalledWith("s1", "hello", {
			mode: undefined,
		});
	});

	it("passes mode=followUp to sendMessage", async () => {
		const sendMessage = vi.fn().mockResolvedValue({ queued: false });
		const manager = mockSessionManager({ sendMessage });
		const { url } = await startServer(manager);

		await fetch(`${url}/api/sessions/s1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "hello", mode: "followUp" }),
		});

		expect(sendMessage).toHaveBeenCalledWith("s1", "hello", {
			mode: "followUp",
		});
	});

	it("returns 400 for invalid mode values", async () => {
		const sendMessage = vi.fn().mockResolvedValue({ queued: false });
		const manager = mockSessionManager({ sendMessage });
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "hello", mode: "invalid" }),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "invalid_field",
			field: "mode",
			message: 'Must be "steer" or "followUp".',
		});
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("returns 400 when message is missing from send body", async () => {
		const manager = mockSessionManager();
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "steer" }),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "message_required" });
	});

	it("returns 400 when message is empty string", async () => {
		const manager = mockSessionManager();
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "   " }),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "message_required" });
	});

	it("returns 400 on malformed JSON for send message", async () => {
		const manager = mockSessionManager();
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "bad-json",
		});

		expect(response.status).toBe(400);
	});

	it("returns 404 when sendMessage throws not-found", async () => {
		const manager = mockSessionManager({
			sendMessage: vi
				.fn()
				.mockRejectedValue(new Error("Session not found: s99")),
		});
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s99/messages`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ message: "hello" }),
		});

		expect(response.status).toBe(404);
	});

	// ── DELETE /api/sessions/{sessionId}/messages (stop) ──

	it("stops a session and returns 204", async () => {
		const stopSession = vi.fn().mockResolvedValue(undefined);
		const manager = mockSessionManager({
			capabilities: {
				...baseCapabilities,
				stopSession: true,
			},
			stopSession,
		});
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s1/messages`, {
			method: "DELETE",
		});

		expect(response.status).toBe(204);
		expect(stopSession).toHaveBeenCalledWith("s1");
	});

	it("returns 501 when stopSession capability is false", async () => {
		const manager = mockSessionManager({
			capabilities: {
				...baseCapabilities,
				stopSession: false,
			},
		});
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s1/messages`, {
			method: "DELETE",
		});

		expect(response.status).toBe(501);
		expect(await response.json()).toEqual({
			error: "unsupported_capability",
			capability: "stopSession",
		});
	});

	it("returns 404 when stopSession throws not-found", async () => {
		const manager = mockSessionManager({
			capabilities: {
				...baseCapabilities,
				stopSession: true,
			},
			stopSession: vi
				.fn()
				.mockRejectedValue(new Error("Session not found: s99")),
		});
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s99/messages`, {
			method: "DELETE",
		});

		expect(response.status).toBe(404);
	});

	it("returns 405 for unsupported methods on /messages", async () => {
		const manager = mockSessionManager();
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s1/messages`, {
			method: "PUT",
		});
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("POST, DELETE");
	});

	// ── POST /api/sessions/{sessionId}/requests/{requestId} ──

	it("responds to a user request and returns 204", async () => {
		const respondToUserRequest = vi.fn().mockResolvedValue(undefined);
		const manager = mockSessionManager({ respondToUserRequest });
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s1/requests/req-1`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: "req-1",
				confirmed: true,
			}),
		});

		expect(response.status).toBe(204);
		expect(respondToUserRequest).toHaveBeenCalledWith("s1", {
			id: "req-1",
			confirmed: true,
		});
	});

	it("returns 400 when body id mismatches path requestId", async () => {
		const manager = mockSessionManager();
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s1/requests/req-1`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: "req-2",
				confirmed: true,
			}),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "request_id_mismatch",
			message: 'Body id "req-2" does not match path requestId "req-1".',
		});
	});

	it("returns 400 when body id is missing", async () => {
		const manager = mockSessionManager();
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s1/requests/req-1`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ confirmed: true }),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "id_required" });
	});

	it("returns 400 when cancelled is a non-boolean string", async () => {
		const manager = mockSessionManager();
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s1/requests/req-1`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "req-1", cancelled: "false" }),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "invalid_field",
			field: "cancelled",
			message: "Must be a boolean.",
		});
	});

	it("returns 400 when confirmed is a non-boolean string", async () => {
		const manager = mockSessionManager();
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s1/requests/req-1`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "req-1", confirmed: 1 }),
		});

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "invalid_field",
			field: "confirmed",
			message: "Must be a boolean.",
		});
	});

	it("returns 404 when respondToUserRequest throws not-found", async () => {
		const manager = mockSessionManager({
			respondToUserRequest: vi
				.fn()
				.mockRejectedValue(new Error("Session not found: s99")),
		});
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s99/requests/req-1`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id: "req-1" }),
		});

		expect(response.status).toBe(404);
	});

	it("returns 405 for unsupported methods on /requests", async () => {
		const manager = mockSessionManager();
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s1/requests/req-1`, {
			method: "GET",
		});
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("POST");
	});

	// ── Unknown paths ──

	it("returns 404 for unknown sub-paths under /api/sessions", async () => {
		const manager = mockSessionManager();
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/sessions/s1/unknown/resource`);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "not_found" });
	});

	it("returns false for non-/api/sessions paths", async () => {
		const manager = mockSessionManager();
		const { url } = await startServer(manager);

		const response = await fetch(`${url}/api/stream`);
		expect(response.status).toBe(404);
	});

	// ── Helpers ──

	async function startServer(
		manager: SessionManager,
	): Promise<{ url: string; server: Server }> {
		const handleApi = createSessionApiHandler({ manager });
		const server = createServer(async (req, res) => {
			if (await handleApi(req, res)) {
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

const baseCapabilities: SessionManagerCapabilities = {
	createSession: true,
	deleteSession: false,
	stopSession: true,
	setSessionMetadata: false,
	sendMessage: true,
	respondToUserRequest: true,
	backgroundSessions: false,
};

function mockSessionManager(
	overrides: Partial<SessionManager> = {},
): SessionManager {
	return {
		capabilities: { ...baseCapabilities },
		listSessions: vi.fn().mockResolvedValue([]),
		createSession: vi.fn().mockResolvedValue({
			id: "s1",
			title: "",
			status: "idle",
		}),
		deleteSession: vi.fn().mockResolvedValue(undefined),
		openSession: vi.fn().mockResolvedValue({
			session: { id: "s1", title: "", status: "idle" },
			messages: [],
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
				messages: [],
				streamCursor: "",
			},
			unsubscribe: vi.fn(),
		}),
		...overrides,
	};
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

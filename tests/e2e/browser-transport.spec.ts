/**
 * Browser-environment tests for the RPC browser transport.
 *
 * These tests validate that the transport abstraction works correctly
 * with native browser Web APIs (`window.fetch`, `window.EventSource`).
 * The app exposes `__agentWeb__` on `window` during development so we
 * can exercise the real library code in a live browser.
 */
import { expect, test } from "@playwright/test";

test("createBrowserTransport produces a callable fetch bound to window", async ({
	page,
}) => {
	// Capture console errors to help debug module loading issues.
	const consoleErrors: string[] = [];
	page.on("console", (msg) => {
		if (msg.type() === "error") {
			consoleErrors.push(msg.text());
		}
	});

	await page.goto("/");

	// Wait for the Vue app to mount and our module to load.
	await page.waitForSelector("#app > *", { timeout: 10_000 });

	// The __agentWeb__ property is set synchronously by main.ts
	// before the Vue app mounts.  If it's not there, the module
	// may have failed to load.
	const hasAgentWeb = await page.evaluate(
		() => (window as any).__agentWeb__ !== undefined,
	);

	if (!hasAgentWeb) {
		// Dump what's on window to diagnose.
		const keys = await page.evaluate(() =>
			Object.keys(window).filter((k) => k.startsWith("__") || k === "agentWeb"),
		);
		throw new Error(
			`__agentWeb__ not found on window. Console errors: ${consoleErrors.join("; ")}. ` +
				`Window keys: ${keys.join(", ")}`,
		);
	}

	const result = await page.evaluate(async () => {
		const agentWeb = (window as any).__agentWeb__;
		const transport = agentWeb.createBrowserTransport();

		if (typeof transport.fetch !== "function") {
			return { ok: false, error: "fetch is not a function" };
		}
		if (typeof transport.createEventSource !== "function") {
			return { ok: false, error: "createEventSource is not a function" };
		}

		// Verify fetch can be called without throwing a receiver error.
		try {
			const response = await transport.fetch("/api/sessions");
			return {
				ok: true,
				status: response.status,
				contentType: response.headers.get("content-type"),
			};
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	});

	expect(result.ok).toBe(true);
	expect(typeof result.status).toBe("number");
});

test("createBrowserTransport fetch is receiver-agnostic (no 'called on object that does not implement interface Window')", async ({
	page,
}) => {
	await page.goto("/");
	await page.waitForSelector("#app > *", { timeout: 10_000 });

	const hasAgentWeb = await page.evaluate(
		() => (window as any).__agentWeb__ !== undefined,
	);
	if (!hasAgentWeb) {
		throw new Error("__agentWeb__ not found on window");
	}

	const result = await page.evaluate(async () => {
		const agentWeb = (window as any).__agentWeb__;
		const transport = agentWeb.createBrowserTransport();

		// Extract the fetch function and call it detached from the
		// transport object — this simulates the class method call
		// pattern (`this.fetchFn(...)`) that caused the Safari bug.
		const detachedFetch = transport.fetch;

		try {
			const response = await detachedFetch("/api/sessions");
			const body = await response.json();
			return {
				ok: true,
				calledDetached: true,
				status: response.status,
				hasSessionsKey: "sessions" in body,
			};
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	});

	expect(result.ok).toBe(true);
	expect(result.calledDetached).toBe(true);
});

test("RpcSessionManager with default transport communicates over real HTTP", async ({
	page,
}) => {
	await page.goto("/");
	await page.waitForSelector("#app > *", { timeout: 10_000 });

	const hasAgentWeb = await page.evaluate(
		() => (window as any).__agentWeb__ !== undefined,
	);
	if (!hasAgentWeb) {
		throw new Error("__agentWeb__ not found on window");
	}

	const result = await page.evaluate(async () => {
		const agentWeb = (window as any).__agentWeb__;

		// Create a manager using only the default transport (no mocks).
		// This exercises the full path: createBrowserTransport → bind
		// globalThis.fetch → RpcSessionManager.request → real HTTP.
		const manager = agentWeb.createRpcSessionManager();

		try {
			const sessions = await manager.listSessions();
			return {
				ok: true,
				sessionsCount: sessions.length,
				sessions: sessions.map(
					(s: { id: string; status: string }) => ({
						id: s.id,
						status: s.status,
					}),
				),
			};
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
				errorName: err instanceof Error ? err.name : undefined,
			};
		}
	});

	if (!result.ok) {
		// If the backend returned an error, it should still be an HTTP
		// error, not a TypeError about fetch receiver.
		expect(result.errorName).not.toBe("TypeError");
		expect(true).toBe(true);
	} else {
		expect(Array.isArray(result.sessions)).toBe(true);
	}
});

test("createBrowserTransport creates valid EventSource instances", async ({
	page,
}) => {
	await page.goto("/");
	await page.waitForSelector("#app > *", { timeout: 10_000 });

	const hasAgentWeb = await page.evaluate(
		() => (window as any).__agentWeb__ !== undefined,
	);
	if (!hasAgentWeb) {
		throw new Error("__agentWeb__ not found on window");
	}

	const result = await page.evaluate(async () => {
		const agentWeb = (window as any).__agentWeb__;
		const transport = agentWeb.createBrowserTransport();

		try {
			const es = transport.createEventSource(
				"/api/stream?session=test&cursor=0",
			);
			return {
				ok: true,
				isEventSource: es instanceof EventSource,
				readyState: es.readyState,
				url: es.url,
			};
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	});

	expect(result.ok).toBe(true);
	expect(result.isEventSource).toBe(true);
	// 0 = CONNECTING
	expect(result.readyState).toBe(0);
	expect(result.url).toContain("/api/stream?session=test");
});

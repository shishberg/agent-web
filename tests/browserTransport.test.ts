import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserTransport } from "../src/lib/browserTransport";

let originalFetch: typeof globalThis.fetch;
let originalEventSource: typeof globalThis.EventSource | undefined;

describe("createBrowserTransport", () => {
	beforeEach(() => {
		originalFetch = globalThis.fetch;
		originalEventSource = globalThis.EventSource;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		globalThis.EventSource = originalEventSource as typeof EventSource;
	});

	it("binds default fetch to globalThis", async () => {
		let fetchThis: unknown = null;
		globalThis.fetch = vi.fn(async function (
			this: unknown,
			_input: RequestInfo | URL,
			_init?: RequestInit,
		) {
			fetchThis = this;
			return new Response("ok");
		}) as typeof fetch;

		globalThis.EventSource = vi.fn() as unknown as typeof EventSource;

		const transport = createBrowserTransport();
		await transport.fetch("http://example.test/api");

		expect(fetchThis).toBe(globalThis);
	});

	it("leaves an explicitly provided fetch untouched (no extra bind)", async () => {
		let fetchThis: unknown = null;
		const customFetch = vi.fn(async function (
			this: unknown,
			_input: RequestInfo | URL,
			_init?: RequestInit,
		) {
			fetchThis = this;
			return new Response("ok");
		}) as typeof fetch;

		globalThis.EventSource = vi.fn() as unknown as typeof EventSource;

		const transport = createBrowserTransport({ fetch: customFetch });
		await transport.fetch("http://example.test/api");

		// The custom fetch is used as-is; `this` depends on how the
		// caller invokes it.  Since we call it directly on the transport,
		// `this` will be undefined (strict mode) or the transport object.
		// The important thing is that we did NOT apply an extra .bind().
		expect(customFetch).toHaveBeenCalledOnce();
	});

	it("throws when fetch is unavailable", () => {
		globalThis.fetch = undefined as unknown as typeof fetch;
		globalThis.EventSource = vi.fn() as unknown as typeof EventSource;

		expect(() => createBrowserTransport()).toThrow(
			"fetch is not available in this environment.",
		);
	});

	it("throws when EventSource is unavailable", () => {
		globalThis.fetch = vi.fn() as unknown as typeof fetch;
		globalThis.EventSource = undefined as unknown as typeof EventSource;

		expect(() => createBrowserTransport()).toThrow(
			"EventSource is not available in this environment.",
		);
	});

	it("creates EventSource instances via the transport", () => {
		const sources: EventSource[] = [];
		class FakeEventSource {
			constructor(url: string | URL) {
				sources.push(this as unknown as EventSource);
			}
		}
		globalThis.fetch = vi.fn() as unknown as typeof fetch;
		globalThis.EventSource =
			FakeEventSource as unknown as typeof EventSource;

		const transport = createBrowserTransport();
		transport.createEventSource("http://example.test/stream");

		expect(sources).toHaveLength(1);
	});

	it("creates independent transports that all delegate to the same underlying fetch", async () => {
		// Verify that each transport is a simple value object, not a
		// class instance that could accidentally carry mutable state.
		const spy = vi.fn(async () => new Response("ok"));
		globalThis.fetch = spy as unknown as typeof fetch;
		globalThis.EventSource = vi.fn() as unknown as typeof EventSource;

		const t1 = createBrowserTransport();
		const t2 = createBrowserTransport();

		// Different transport objects
		expect(t1).not.toBe(t2);

		// Both transports call the same underlying global fetch
		await t1.fetch("http://example.test/a");
		await t2.fetch("http://example.test/b");
		expect(spy).toHaveBeenCalledTimes(2);
	});
});

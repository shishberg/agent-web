/**
 * Abstraction over browser network primitives (fetch and EventSource)
 * used by {@link RpcSessionManager} to communicate with the backend API.
 *
 * The transport is deliberately small and explicit: every dependency
 * (`fetch` and `EventSource`) is wired at construction so that
 * tests and non-browser environments can supply controlled doubles
 * without patching globals.
 */
export interface BrowserTransport {
	/** Makes an HTTP request.  Must be safe to call as a bare function
	 *  (i.e. `this`-agnostic). */
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;

	/** Creates a new EventSource for the given URL. */
	createEventSource(
		url: string | URL,
		eventSourceInitDict?: EventSourceInit,
	): EventSource;
}

export interface CreateBrowserTransportOptions {
	/**
	 * Fetch implementation.  When omitted, defaults to `globalThis.fetch`
	 * bound to `globalThis` so that native browser `fetch` never sees an
	 * arbitrary `this` receiver (Safari/WebKit requirement).
	 */
	fetch?: typeof globalThis.fetch;

	/**
	 * EventSource constructor.  When omitted, defaults to
	 * `globalThis.EventSource`.
	 */
	EventSource?: typeof globalThis.EventSource;
}

/**
 * Creates a {@link BrowserTransport} suitable for use in a web browser.
 *
 * The returned object is a simple value — it carries no mutable state and
 * can be freely passed between consumers.
 */
export function createBrowserTransport(
	options: CreateBrowserTransportOptions = {},
): BrowserTransport {
	const fetchFn =
		options.fetch ?? globalThis.fetch?.bind(globalThis);
	const EventSourceCtor =
		options.EventSource ?? globalThis.EventSource;

	if (!fetchFn) {
		throw new Error("fetch is not available in this environment.");
	}
	if (!EventSourceCtor) {
		throw new Error("EventSource is not available in this environment.");
	}

	return {
		fetch: fetchFn,
		createEventSource: (url, eventSourceInitDict?) =>
			new EventSourceCtor(url, eventSourceInitDict),
	};
}

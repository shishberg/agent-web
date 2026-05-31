import { createRpcSessionManager } from "./rpcSessionManager";
import type { SessionManager } from "./sessionApi";

/**
 * Browser test/dev namespace. A page can set `window.__agentWeb__ =
 * { sessionManager }` before app startup; development startup augments the
 * same object instead of replacing it.
 */
export type AgentWebBrowserApi = {
	sessionManager?: SessionManager;
	setSessionManager?: (manager: SessionManager) => void;
	resetSessionManager?: () => void;
} & Record<string, unknown>;

declare global {
	interface Window {
		__agentWeb__?: AgentWebBrowserApi;
	}
}

let instance: SessionManager | null = null;

export function getSessionManager(): SessionManager {
	if (instance) {
		return instance;
	}

	const injected = getBrowserSessionManager();
	if (injected) {
		instance = injected;
		return instance;
	}

	instance = createRpcSessionManager();
	return instance;
}

export function setSessionManager(manager: SessionManager): void {
	instance = manager;
	const api = ensureAgentWebBrowserApi();
	if (api) {
		api.sessionManager = manager;
	}
}

export function resetSessionManager(): void {
	instance = null;
	const api = getAgentWebBrowserApi();
	if (api) {
		delete api.sessionManager;
	}
}

export function installSessionManagerInjectionApi(): AgentWebBrowserApi | null {
	const api = ensureAgentWebBrowserApi();
	if (!api) {
		return null;
	}

	api.setSessionManager = setSessionManager;
	api.resetSessionManager = resetSessionManager;
	return api;
}

function getBrowserSessionManager(): SessionManager | null {
	return getAgentWebBrowserApi()?.sessionManager ?? null;
}

function getAgentWebBrowserApi(): AgentWebBrowserApi | null {
	if (typeof window === "undefined") {
		return null;
	}
	return window.__agentWeb__ ?? null;
}

function ensureAgentWebBrowserApi(): AgentWebBrowserApi | null {
	if (typeof window === "undefined") {
		return null;
	}
	window.__agentWeb__ ??= {};
	return window.__agentWeb__;
}

import { createRpcSessionManager } from "./rpcSessionManager";
import type { SessionManager } from "./sessionApi";

declare global {
	interface Window {
		__mockSessionManager__?: SessionManager;
	}
}

let instance: SessionManager | null = null;

export function getSessionManager(): SessionManager {
	if (instance) {
		return instance;
	}

	if (
		typeof window !== "undefined" &&
		(window as any).__mockSessionManager__ != null
	) {
		instance = (window as any).__mockSessionManager__;
		return instance!;
	}

	instance = createRpcSessionManager();
	return instance!;
}

export function setSessionManager(manager: SessionManager): void {
	instance = manager;
}

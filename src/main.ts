import { createApp } from "vue";
import App from "./App.vue";
import "./styles.css";
import { createRpcSessionManager } from "./lib/rpcSessionManager";
import { createBrowserTransport } from "./lib/browserTransport";

// Expose transport helpers on window for browser-environment tests
// in development mode only. Playwright e2e tests use these to
// exercise the real transport with native browser Web APIs.
if (import.meta.env.DEV) {
	;(window as unknown as Record<string, unknown>).__agentWeb__ = {
		createRpcSessionManager,
		createBrowserTransport,
	};
}

createApp(App).mount("#app");

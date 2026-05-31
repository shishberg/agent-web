import { createApp } from "vue";
import App from "./App.vue";
import "./styles.css";
import { createRpcSessionManager } from "./lib/rpcSessionManager";
import { createBrowserTransport } from "./lib/browserTransport";
import { installSessionManagerInjectionApi } from "./lib/sessionManagerInstance";

// Expose the browser test/dev namespace in development mode only.
// Playwright uses these helpers to exercise native browser Web APIs.
if (import.meta.env.DEV) {
	const agentWeb = installSessionManagerInjectionApi();
	if (agentWeb) {
		agentWeb.createRpcSessionManager = createRpcSessionManager;
		agentWeb.createBrowserTransport = createBrowserTransport;
	}
}

createApp(App).mount("#app");

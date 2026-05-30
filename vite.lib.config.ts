import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [vue()],
	publicDir: false,
	build: {
		outDir: "dist/package",
		emptyOutDir: true,
		lib: {
			entry: {
				"agent-web": "src/packageEntry.ts",
				"session-protocol": "src/sessionProtocolEntry.ts",
			},
			formats: ["es"],
		},
		rollupOptions: {
			external: ["vue", "@lucide/vue"],
		},
	},
});

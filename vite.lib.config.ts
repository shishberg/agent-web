import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [vue()],
	publicDir: false,
	build: {
		outDir: "dist/package",
		emptyOutDir: true,
		lib: {
			entry: "src/packageEntry.ts",
			formats: ["es"],
			fileName: () => "agent-web.js",
		},
		rollupOptions: {
			external: ["vue", "@lucide/vue"],
		},
	},
});

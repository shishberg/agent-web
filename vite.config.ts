import vue from "@vitejs/plugin-vue";
import { configDefaults, defineConfig } from "vitest/config";

const port = Number(process.env.PORT ?? 4177);

export default defineConfig({
  plugins: [vue()],
  server: {
    port,
    allowedHosts: ["kodama.local"]
  },
  build: {
    outDir: "dist/client"
  },
  test: {
    exclude: [...configDefaults.exclude, "tests/e2e/**"]
  }
});

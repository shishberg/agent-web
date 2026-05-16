import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const port = Number(process.env.PORT ?? 4177);

export default defineConfig({
  plugins: [vue()],
  server: {
    port,
    allowedHosts: ["kodama.local"]
  },
  build: {
    outDir: "dist/client"
  }
});

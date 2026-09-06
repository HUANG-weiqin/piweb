import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const piWebPort = process.env.PORT ?? "31415";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/ws": { target: `ws://127.0.0.1:${piWebPort}`, ws: true } },
  },
  build: { outDir: "dist-client" },
});

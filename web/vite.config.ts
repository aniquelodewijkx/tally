import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the API runs separately (`cargo run -p tally-server`); proxy its gRPC-web and
// /auth paths so the browser stays same-origin, exactly like production where tally-server
// serves web/dist.
export default defineConfig({
  plugins: [react()],
  // One bundle is fine for a single-user app served from the same machine.
  build: { chunkSizeWarningLimit: 800 },
  server: {
    host: true,
    port: 5173,
    proxy: { "/finance.": "http://127.0.0.1:8080", "/auth/": "http://127.0.0.1:8080" },
  },
});

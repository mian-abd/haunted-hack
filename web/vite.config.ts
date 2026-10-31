import { defineConfig } from "vite"

// No React plugin: JSX compiles through tsconfig "jsx": "react-jsx". shortcut: no Fast Refresh (edits full-reload), add @vitejs/plugin-react if that gets annoying.
// /api is proxied to server/ so one public tunnel URL (cloudflared → :5173) serves the app and the API.
const api = { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false } }

export default defineConfig({
  // shortcut: allowedHosts true accepts any tunnel/domain (quick or named Cloudflare tunnels); pin hosts after the hackathon.
  server: { port: 5173, strictPort: true, allowedHosts: true, proxy: api },
  preview: { allowedHosts: true, proxy: api },
})

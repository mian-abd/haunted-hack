import { defineConfig } from "vite"

// No React plugin: JSX compiles through tsconfig "jsx": "react-jsx". shortcut: no Fast Refresh (edits full-reload), add @vitejs/plugin-react if that gets annoying.
export default defineConfig({ server: { port: 5173, strictPort: true } })

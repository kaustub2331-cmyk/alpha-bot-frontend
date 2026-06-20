// ============================================================
// Alpha Bot — vite.config.js
// Standard Vite + React config.
// No @vite/pwa plugin needed — SW is manually placed in /public.
// ============================================================
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  // Environment variables — all must be prefixed VITE_
  // Set these in .env.local (never commit):
  //   VITE_SUPABASE_URL=https://xxxx.supabase.co
  //   VITE_SUPABASE_ANON_KEY=eyJh...
  //   VITE_BOT_BACKEND_URL=https://your-backend.railway.app

  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ["react", "react-dom"],
          supabase: ["@supabase/supabase-js"],
        },
      },
    },
  },

  server: {
    port: 5173,
    host: true, // expose on LAN for mobile testing
  },

  preview: {
    port: 4173,
    host: true,
  },
});

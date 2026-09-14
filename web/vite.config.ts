import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Standalone frontend, deliberately separate from the API server (see
// ../src/server.ts) — its own build/serve pipeline, own port. Talks to
// the API only over HTTP (cross-origin, credentialed fetches), never
// imports anything from ../src.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173
  }
});

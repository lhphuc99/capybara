import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Must match the --allow-origin given to the server when developing the UI.
  server: { port: 5174, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});

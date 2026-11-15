import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// index.html ships the production CSP. The dev server needs two relaxations that
// must never reach dist/: inline scripts (@vitejs/plugin-react preamble) and the
// HMR websocket.
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws://127.0.0.1:5173",
].join('; ');

const devCsp = {
  name: 'dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) =>
    html.replace(
      /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/,
      `$1${DEV_CSP}$2`,
    ),
};

export default defineConfig({
  plugins: [react(), tailwindcss(), devCsp],
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});

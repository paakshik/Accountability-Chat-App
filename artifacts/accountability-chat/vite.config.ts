import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

// Replit's artifact runner injects PORT and BASE_PATH (see .replit-artifact/artifact.toml).
// Outside it these are unset, so fall back to the same values the artifact config uses —
// that way `pnpm dev` works on a plain machine without exporting anything first.
const DEFAULT_PORT = 18666;
const DEFAULT_API_PORT = 8080;

// The api-server reads the repo-root .env via --env-file-if-exists, but Vite only loads
// .env into import.meta.env for the client bundle, not into process.env at config time.
// Read it here too, so a single .env configures both halves and `pnpm run dev` needs no
// flags. A real environment variable still wins, keeping Replit's injected values
// authoritative in that runtime.
const rootEnv = loadEnv('development', path.resolve(import.meta.dirname, '..', '..'), '');
const fromEnv = (name: string) => process.env[name] || rootEnv[name] || '';

// WEB_PORT takes precedence for the same reason API_PORT does on the server: it lets
// one shell run both halves without PORT meaning two different things.
const rawPort = fromEnv('WEB_PORT') || fromEnv('PORT');
const port = rawPort ? Number(rawPort) : DEFAULT_PORT;

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = fromEnv('BASE_PATH') || '/';

// In Replit the platform router forwards /api to the api-server artifact before the
// request ever reaches Vite. Locally nothing does that, so proxy it ourselves —
// otherwise every request the app makes 404s against the Vite dev server.
const apiTarget =
  fromEnv('API_PROXY_TARGET') ||
  `http://127.0.0.1:${fromEnv('API_PORT') || DEFAULT_API_PORT}`;

const proxy = {
  '/api': {
    target: apiTarget,
    changeOrigin: true,
  },
};

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy,
  },
});

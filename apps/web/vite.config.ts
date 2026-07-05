import { resolve } from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Consume the shared package from source: its dist is CommonJS (built for the
      // NestJS API), which Rollup won't interop for a symlinked workspace package.
      '@leadprocure/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  server: { port: 5173 },
});

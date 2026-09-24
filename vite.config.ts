import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Симуляция живёт в бэкенде (src/game/sim) и импортируется как есть:
// один и тот же код правил на клиенте (предсказание) и на сервере (авторитет).
const simPath = fileURLToPath(new URL('../backend/src/game/sim/index.ts', import.meta.url));

export default defineConfig({
  resolve: { alias: { '@sim': simPath } },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: { '/api': 'http://localhost:3000' },
  },
  preview: {
    proxy: { '/api': 'http://localhost:3000' },
  },
});

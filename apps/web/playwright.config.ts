import { defineConfig } from '@playwright/test';

// UI smoke over the real stack. Expects the API (:3000) and the web dev server (:5173)
// to be running against the seeded dev database:
//   pnpm --filter api start:dev   &   pnpm --filter web dev
// BASE_URL points the same suite at a deployed stand instead:
//   BASE_URL=http://<host>:<port> npx playwright test
export default defineConfig({
  testDir: './tests',
  // Generous: the Vite dev server compiles each route on first visit, so a run that
  // walks every page cold can be slow (this is a dev-server trait, not the app).
  timeout: 90_000,
  retries: 1,
  // Отчёт, а не только строчки в консоли. Шаг приёмки уже выкладывает
  // `apps/web/playwright-report` в артефакт `acceptance-evidence` — а папки не было, потому
  // что репортёр по умолчанию ничего не пишет на диск. Путь в воркфлоу был намерением.
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:5173',
    headless: true,
    viewport: { width: 1280, height: 900 },
    // След падения. До этого от упавшего теста в артефакте оставался ОДИН файл —
    // `error-context.md`, то есть снимок доступности страницы: по нему видно, что браузер
    // стоит на форме входа, и ничего о том, почему. Четыре падения приёмки 10 ноября 2026
    // перезапустили именно поэтому. Трасса несёт каждый запрос с кодом ответа — ровно то
    // свидетельство, которого не хватало; снимок и видео читаются без инструментов.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: undefined, // servers are managed externally (see header comment)
});

import { defineConfig } from '@playwright/test';

// UI smoke over the real stack. Expects the API (:3000) and the web dev server (:5173)
// to be running against the seeded dev database:
//   pnpm --filter api start:dev   &   pnpm --filter web dev
// BASE_URL points the same suite at a deployed stand instead:
//   BASE_URL=http://<host>:<port> npx playwright test
// Стенд одноразовый, пока никто не увёл набор на другой адрес. `PLAYWRIGHT_TRACE=1` — явное
// «да, я знаю, что в трассе окажутся настоящие учётные данные».
const DISPOSABLE_STAND = !process.env.BASE_URL || process.env.PLAYWRIGHT_TRACE === '1';

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
    // свидетельство, которого не хватало.
    //
    // Снимок экрана — всегда: пароль на нём скрыт полем, а артефакт весит килобайты.
    // Трасса и видео — ТОЛЬКО на одноразовом стенде (замечание из разбора PR #182). Трасса
    // записывает запросы ЦЕЛИКОМ: тело `POST /auth/login` с почтой и паролем, заголовки с
    // cookie. На стенде приёмки это фикстуры (`@audit.invalid`, фикстурный пароль), и терять
    // там нечего; но `BASE_URL` уводит этот же набор на живой стенд, а артефакт прогона лежит
    // в публичном репозитории — и тогда та же настройка положила бы туда настоящие учётные
    // данные. Поэтому признак одноразовости — отсутствие `BASE_URL`; на живом стенде трассу
    // надо попросить осознанно, `PLAYWRIGHT_TRACE=1`.
    trace: DISPOSABLE_STAND ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
    video: DISPOSABLE_STAND ? 'retain-on-failure' : 'off',
  },
  webServer: undefined, // servers are managed externally (see header comment)
});

import { resolve } from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Сборка обязана быть ПРОДОВОЙ, и это проверяется здесь, а не доверяется вызывающему.
//
// `vite build` не выбирает режим React сам: он подставляет в бандл `process.env.NODE_ENV`
// ТЕМ значением, которое увидел в своём окружении, и только если его там нет — ставит
// `production` (vite 5.4.8, `resolveConfig`: `isNodeEnvSet` → `define`). React по этой
// строке и выбирает сборку: всё, кроме ровно `'production'`, даёт сборку РАЗРАБОТКИ, а в ней
// `<React.StrictMode>` вызывает каждый эффект ДВАЖДЫ — нарочно, чтобы показать разработчику
// неидемпотентный эффект.
//
// Так и случилось в приёмке: у джобы `NODE_ENV: test` (этого требует `assert-isolated.cjs`),
// значение доходило до `pnpm build`, а `vite preview` затем отдавал браузеру дев-сборку —
// то есть шаг, который должен мерить прод-сборку, не прогонял её НИ РАЗУ. Замерено на
// зелёном прогоне 42879226779: на 191 загрузке страницы `/auth/me` зван 336 раз, по ДВА раза
// в 168 загрузках из 168; `/categories`, `/departments`, `/suppliers/directory`,
// `/notifications`, `/settings/followup-plan`, `/events/:id/qna` — тоже по два. Один
// `POST /auth/refresh` на загрузку (181 из 181) — и только потому, что `api/client.ts`
// склеивает одновременные обновления в один промис; больше ничто в продукте от удвоения не
// защищено. Все цифры сводки `scripts/acceptance/api-log-summary.mjs` были тем самым завышены
// примерно вдвое: `/auth/me` показывался на 206/мин из своих 300 (69 % ведра) вместо ~103.
//
// Прод этим НЕ болел и не болеет: `apps/web/Dockerfile` собирает без `NODE_ENV`, то есть
// попадает в ветку «не задан → production». Поэтому проверка пропускает незаданный
// `NODE_ENV` — иначе она сломала бы ровно тот путь, который и так верен (проверено на всех
// четырёх случаях: не задан → собирает прод-бандл 141 812 Б, `test` и `development` →
// отказ, `production` → собирает).
//
// Отказ, а не молчаливая подстановка `production`: собранный не тем кем-то бандл отличается
// от прод-бандла вдвое по размеру и поведением эффектов, и узнать об этом надо в момент
// сборки, а не по удвоенным цифрам в чужой сводке через месяц.
export default defineConfig(({ command }) => {
  if (command === 'build' && process.env.NODE_ENV !== 'production') {
    throw new Error(
      `vite build: NODE_ENV=${process.env.NODE_ENV} — это сборка РАЗРАБОТКИ.\n`
        + 'React подставляет дев-сборку на всё, кроме NODE_ENV=production, и тогда StrictMode\n'
        + 'вызывает каждый эффект дважды — удваивая каждый запрос начальной загрузки.\n'
        + 'Соберите с NODE_ENV=production (или не задавайте NODE_ENV вовсе: vite сам поставит\n'
        + 'production для build). См. комментарий в apps/web/vite.config.ts.',
    );
  }
  return {
    plugins: [react()],
    resolve: {
      alias: {
        // Consume the shared package from source: its dist is CommonJS (built for the
        // NestJS API), which Rollup won't interop for a symlinked workspace package.
        '@leadprocure/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
      },
    },
    server: { port: 5173 },
  };
});

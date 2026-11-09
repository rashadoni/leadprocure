import { INestApplication } from '@nestjs/common';
import request from 'supertest';

// Segregation of duties: a request's creator can't approve it. Specs register a buyer
// (admin = creator) and use this to add a separate BUYER_APPROVER who does the approvals.
export async function addApprover(app: INestApplication, buyerToken: string, tag: string): Promise<string> {
  const http = () => request(app.getHttpServer());
  const email = `apprv-${tag}@t.test`;
  await http().post('/settings/users').set('Authorization', `Bearer ${buyerToken}`)
    .send({ email, fullName: 'Approver', password: 'password123', role: 'BUYER_APPROVER' }).expect(201);
  const r = await http().post('/auth/login').send({ email, password: 'password123' }).expect(201);
  return r.body.accessToken as string;
}

// Чистка за набором: закрыть соединение и приложение ОБЯЗАТЕЛЬНО, даже если удаление упало.
//
// Чем это оплачено. 9 ноября 2026 чистка `rfi-rfp` упала на первой же строке (удаление
// организаций споткнулось об FK без `ON DELETE`), и `db.end()` с `app.close()` под ней не
// выполнились. Остались открытыми соединение pg и приложение Nest, jest напечатал
// `Jest did not exit one second after the test run has completed` — и джоба висела до
// таймаута 30 минут. В логе при этом видно «отменено по таймауту», а не «упала чистка в
// rfi-rfp»: падение за 90 секунд превратилось в полчаса с потерянной причиной. Два прогона
// и полтора часа ушли на то, чтобы прочитать лог целиком.
//
// Ошибку чистки НЕ глотаем: набор обязан упасть громко и со своим текстом — иначе дефект,
// который чистка нашла (а она нашла настоящий, в схеме), остался бы незамеченным. Поэтому
// сначала закрываем всё, потом бросаем первую ошибку.
//
// `forceExit` в конфиг jest не добавлен нарочно: он лечит симптом одной строкой, но
// замаскировал бы и тот случай, на котором этот репозиторий уже обжигался — тик планировщика,
// доживший до `app.close()` и уронивший прогон при 374 зелёных тестах (см. `DISABLE_SCHEDULERS`
// в `setup-env.ts`). Симптом там был бы спрятан, а не вылечен.
// `finalize` — шаг, который обязан пройти ПОСЛЕДНИМ и всегда: восстановление переменной
// окружения, сдвинутой набором. Под `--runInBand` все файлы идут одним процессом, поэтому
// оставленный сдвинутым `APP_TIMEZONE` или `TZ` тихо переназначает день и год КАЖДОМУ
// следующему набору — то есть забытое восстановление не падает, а молча врёт. Первая
// редакция этой правки оставляла такой шаг за пределами защиты в `document-no-year` и
// `invoice-issue-date`: упавшая чистка съедала и его, и `app.close()`. Нашла это сессия,
// разбиравшая правку.
//
// Паузу перед закрытием приложения (пост-коммитная рассылка дочитывает получателей на своём
// соединении уже после ответа) передавайте ВНУТРИ `app`, а не до вызова:
// `{ close: async () => { await sleep(500); await app.close(); } }` — тогда она тоже
// защищена.
export async function teardown(
  db: { end(): Promise<void> } | undefined,
  app: { close(): Promise<unknown> } | undefined,
  cleanup?: () => Promise<unknown>,
  finalize?: () => unknown | Promise<unknown>,
): Promise<void> {
  const failures: unknown[] = [];
  for (const step of [
    async () => { if (cleanup) await cleanup(); },   // пока соединение ещё живо
    async () => { if (db) await db.end(); },
    async () => { if (app) await app.close(); },
    async () => { if (finalize) await finalize(); },
  ]) {
    try { await step(); } catch (e) { failures.push(e); }
  }
  if (failures.length) throw failures[0];
}

import { MigrationInterface, QueryRunner } from 'typeorm';

// Присуждение закрывало дверь в ту же секунду, в которую открывало.
//
// Контракт создаётся из присуждения (`contracts/from-award/:id`), и между этими двумя
// действиями не было ничего: ни паузы, ни уведомления проигравшим. Отмена присуждения
// существует (`awards.cancelled_at`), но после создания контракта она уже невозможна —
// значит у проигравшего не было ни повода узнать о проигрыше, ни времени возразить.
// Это не «не хватает фичи»: закупка, проведённая безупречно, всё равно не защищена от
// жалобы, потому что вторую сторону в ней не слышали.
//
// `standstill_until` — срок, до истечения которого из присуждения нельзя сделать контракт.
// Он ставится при присуждении из настройки `AWARD_STANDSTILL_HOURS`; ноль выключает паузу
// целиком, и это осознанный выход для тех, кому она не нужна.
//
// Колонка NULLABLE намеренно. У присуждений, сделанных до этой миграции, паузы не было —
// и задним числом её вводить нельзя: это запретило бы создавать контракты по тому, что
// присудили вчера. NULL читается как «паузы не было», ровно как и было в тот день.
//
// `standstill_waived_reason` — письменный отказ от паузы. Продукт уже умеет так делать с
// блокировкой по бюджету (`BUDGET_BLOCK_OVERRIDDEN`): срочную закупку нельзя остановить
// намертво, но объяснить, почему ждать не стали, обязан человек, а не система.
export class AwardStandstill1720000000047 implements MigrationInterface {
  name = 'AwardStandstill1720000000047';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE awards ADD COLUMN standstill_until timestamptz`);
    await q.query(`ALTER TABLE awards ADD COLUMN standstill_waived_reason text`);
    await q.query(`ALTER TABLE awards ADD COLUMN standstill_waived_by uuid REFERENCES organization_users(id)`);
    await q.query(`ALTER TABLE awards ADD COLUMN standstill_waived_at timestamptz`);
    // Отказ от паузы — это тройка «кто, когда, почему», и половины тройки быть не должно:
    // «отменил, но не сказал почему» ничем не лучше отсутствия паузы.
    await q.query(`
      ALTER TABLE awards ADD CONSTRAINT awards_waiver_complete CHECK (
        (standstill_waived_reason IS NULL AND standstill_waived_by IS NULL AND standstill_waived_at IS NULL)
        OR (length(btrim(standstill_waived_reason)) >= 10 AND standstill_waived_by IS NOT NULL AND standstill_waived_at IS NOT NULL)
      )`);

    // Снимок присуждения: кто победил, за сколько и в какой валюте.
    //
    // Победителя можно вывести из `winning_bid_id`, но ставку конкурента участник не видит
    // и видеть не должен — RLS на `bids` открывает поставщику только его собственную. А
    // итог закупки участнику знать положено: пауза на возражение без доступа к тому, что
    // оспаривать, — это пауза в тишине. Поэтому цифра победителя кладётся в само
    // присуждение, и участник читает её оттуда, не получая доступа к чужим ставкам.
    //
    // Сумма — по ЛОТУ, а не по всей ставке: в многолотовой закупке присуждают лот.
    // Формула та же, что в выгрузке OCDS, чтобы две цифры об одном событии не разошлись.
    await q.query(`
      ALTER TABLE awards
        ADD COLUMN winner_org_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
        ADD COLUMN winning_total_minor bigint,
        ADD COLUMN winning_currency char(3)`);
    await q.query(`
      UPDATE awards a SET
        winner_org_id = b.supplier_org_id,
        winning_currency = b.currency,
        winning_total_minor = COALESCE(
          (SELECT sum(bi.line_total_minor) FROM bid_items bi
             JOIN event_items ei ON ei.id = bi.event_item_id
           WHERE bi.bid_id = a.winning_bid_id AND ei.lot_id = a.lot_id),
          b.total_minor)
      FROM bids b WHERE b.id = a.winning_bid_id AND a.winner_org_id IS NULL`);

    // Участник закупки читает её присуждения. Политика добавочная: `awards_rls` остаётся
    // как есть, а разрешающие политики на SELECT складываются по ИЛИ — покупатель
    // по-прежнему видит свои, поставщик дополнительно видит те, в которых участвовал.
    //
    // Через `bids` цикла нет: ни одна политика на `bids` не ссылается на `awards`, и
    // подзапрос идёт под собственной RLS поставщика — он видит там только свои ставки,
    // то есть ровно «участвовал ли я».
    //
    // Отменённое присуждение не показывается: это отозванное решение, а не итог. Живое
    // видно всегда, а история отмен лежит в журнале.
    //
    // Видимость делегируется самой закупке — `EXISTS (… sourcing_events …)` поднимает
    // `se_select`, как это делают все остальные дочерние таблицы в `init`. Без этого право
    // давал сам факт ставки, и поставщик, у которого отозвали приглашение или чью закупку
    // вернули в DRAFT, на уровне БД продолжал видеть её присуждения.
    //
    // Отменённое присуждение видно: оно помечено отозванным, а не спрятано. Исчезнувшая
    // строка итогов читается как сбой продукта — тем же доводом, которым показывается
    // причина досрочного закрытия срока.
    //
    // Состояние ставки в условии НЕ участвует намеренно: итоги видят и дисквалифицированный,
    // и опоздавший. Они участвовали, и решение по закупке касается их так же.
    //
    // Политика отдаёт строку ЦЕЛИКОМ, а не выбранные колонки — построчных прав на колонки в
    // Postgres нет. Значит `justification`, `awarded_by` и `cancel_reason` на уровне БД
    // поставщику читаемы, и единственное, что отделяет обоснование покупателя от
    // конкурента, — список колонок в `detail()`. НИКОГДА не писать `SELECT * FROM awards` в
    // ветке поставщика; за этим следит отдельная проверка в `award-standstill.e2e-spec.ts`.
    await q.query(`
      CREATE POLICY awards_participant_select ON awards FOR SELECT USING (
        app_role() = 'SUPPLIER_USER'
        AND EXISTS (SELECT 1 FROM bids b
                    WHERE b.event_id = awards.event_id AND b.supplier_org_id = app_org_id())
        AND EXISTS (SELECT 1 FROM sourcing_events e WHERE e.id = awards.event_id)
      )`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP POLICY awards_participant_select ON awards`);
    await q.query(`ALTER TABLE awards DROP COLUMN winning_currency`);
    await q.query(`ALTER TABLE awards DROP COLUMN winning_total_minor`);
    await q.query(`ALTER TABLE awards DROP COLUMN winner_org_id`);
    await q.query(`ALTER TABLE awards DROP CONSTRAINT awards_waiver_complete`);
    await q.query(`ALTER TABLE awards DROP COLUMN standstill_waived_at`);
    await q.query(`ALTER TABLE awards DROP COLUMN standstill_waived_by`);
    await q.query(`ALTER TABLE awards DROP COLUMN standstill_waived_reason`);
    await q.query(`ALTER TABLE awards DROP COLUMN standstill_until`);
  }
}

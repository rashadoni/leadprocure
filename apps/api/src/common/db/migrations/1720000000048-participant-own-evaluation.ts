import { MigrationInterface, QueryRunner } from 'typeorm';

// Участник видел цену соседа — и не видел, почему не он.
//
// Страница итогов (0047) отвечала «кто победил и за сколько». Возразить на это нечего:
// проигравший оспаривает не чужую цену, а СВОЁ отклонение — свой балл по закреплённым
// критериям и причину, по которой выбрали не первого по рангу. Пауза на возражение без
// этого остаётся формальной: время есть, а предмета возражения нет.
//
// Критерии с весами участник уже получает — они лежат на самой закупке
// (`sourcing_events.evaluation_criteria`, закреплены при создании и после вскрытия не
// переписываются). Не хватало двух вещей: собственного балла и обоснования.
//
// Политика отдаёт поставщику оценки ТОЛЬКО его собственных ставок. Чужие баллы — это
// рейтинг конкурентов, он не его дело и для возражения не нужен.
//
// Через `bids`, а не через `evaluations`: `evaluations_rls` оставляет таблицу покупателю,
// и подзапрос к ней у поставщика вернул бы пусто, то есть политика была бы мертва.
// Заодно видимость делегируется закупке — `JOIN sourcing_events` поднимает `se_select`,
// как у остальных дочерних таблиц.
//
// Цикла нет: ни одна политика на `bids`, `sourcing_events` или `awards` не ссылается на
// `evaluation_scores` (проверено по всем миграциям).
//
// Срок раскрытия — живое присуждение по закупке. До решения оценка может ещё измениться
// (переоценка разрешена, 0020 закрепляет критерии, а не баллы), и показывать балл,
// который завтра другой, — хуже, чем не показывать: человек возразит на цифру, которой
// уже нет. После присуждения переоценка требует сначала отменить решение, и тогда строка
// итогов помечается отозванной — то есть участник видит, что разбор снова в движении.
export class ParticipantOwnEvaluation1720000000048 implements MigrationInterface {
  name = 'ParticipantOwnEvaluation1720000000048';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE POLICY es_participant_select ON evaluation_scores FOR SELECT USING (
        app_role() = 'SUPPLIER_USER'
        AND EXISTS (
          SELECT 1 FROM bids b
            JOIN sourcing_events e ON e.id = b.event_id
          WHERE b.id = evaluation_scores.bid_id
            AND b.supplier_org_id = app_org_id()
            AND EXISTS (SELECT 1 FROM awards a WHERE a.event_id = e.id AND a.cancelled_at IS NULL)
        )
      )`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP POLICY es_participant_select ON evaluation_scores`);
  }
}

import { MigrationInterface, QueryRunner } from 'typeorm';

// `awards.winning_bid_id` получает `ON DELETE CASCADE`.
//
// В `init` связь объявлена `winning_bid_id uuid NOT NULL REFERENCES bids(id)` — без
// `ON DELETE`, то есть `NO ACTION`. Это единственное место, где строка ПОКУПАТЕЛЯ ссылается
// на строку ПОСТАВЩИКА, а каскады у них разные: `bids` уходит от `organizations` поставщика,
// `awards` — от `sourcing_events`, то есть от покупателя. Удаление организации обходит эти
// ветви отдельными подоператорами, и `NO ACTION` проверяется в конце СВОЕГО подоператора —
// значит, если ветвь поставщика исполнится первой, проверка увидит присуждение, которое ещё
// не удалено, и заблокирует удаление целиком.
//
// Замерено на живой схеме (изолированная база, 9 ноября 2026), оба случая:
//
//   удалить только поставщика           → ERROR: update or delete on table "bids" violates
//                                         foreign key constraint "awards_winning_bid_id_fkey"
//   удалить покупателя и поставщика
//   ОДНИМ оператором                    → проходит
//
// То есть дефект не в «порядке удачи», а в конкретном условии: организация-поставщик
// удаляется, покупатель остаётся. Поймано это падением чистки в `rfi-rfp.e2e-spec.ts` на
// полном прогоне CI — там удаляются обе организации, так что точную пару, которая свела
// ветви, из лога восстановить не удалось; условие же воспроизводится детерминированно.
//
// **Кого это касается на самом деле.** Прод организации не удаляет — это делает только
// чистка e2e. То есть пользователям дефект не виден, а гейт он роняет случайно, и такое
// падение объясняют словами «перезапусти прогон». Правило этого репозитория («org FK —
// `ON DELETE CASCADE`») написано ровно против таких мин.
//
// CASCADE, а не SET NULL: колонка `NOT NULL`, и присуждение без победившей ставки
// бессмысленно — если ставки нет, нет и решения, которое на неё ссылалось.
//
// Соседнюю связь `awards.evaluation_id` НЕ трогаем: она тоже `NO ACTION`, но и `evaluations`,
// и `awards` висят на одном и том же `sourcing_events`, то есть лежат в ОДНОЙ ветви каскада.
// Замерено отдельно: удаление только покупателя проходит. Чинить по подозрению место, где
// измерение показывает исправность, значило бы менять схему на догадку.
export class AwardBidCascade1720000000053 implements MigrationInterface {
  name = 'AwardBidCascade1720000000053';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE awards DROP CONSTRAINT awards_winning_bid_id_fkey`);
    await q.query(`ALTER TABLE awards ADD CONSTRAINT awards_winning_bid_id_fkey
      FOREIGN KEY (winning_bid_id) REFERENCES bids(id) ON DELETE CASCADE`);
    await q.query(`INSERT INTO release_versions(version) VALUES ('1.9.2-award-bid-cascade')`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE awards DROP CONSTRAINT awards_winning_bid_id_fkey`);
    await q.query(`ALTER TABLE awards ADD CONSTRAINT awards_winning_bid_id_fkey
      FOREIGN KEY (winning_bid_id) REFERENCES bids(id)`);
  }
}

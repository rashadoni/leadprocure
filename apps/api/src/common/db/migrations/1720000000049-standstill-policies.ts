import { MigrationInterface, QueryRunner } from 'typeorm';

// Пауза на возражение жила переменной окружения — то есть одной на всех арендаторов.
//
// `AWARD_STANDSTILL_HOURS` читается процессом при старте. В мультиарендном продукте это
// значит, что одна выкладка обслуживает и регулируемого закупщика, и нерегулируемого, а
// первый не может получить свои 24 часа, не изменив паузу ВСЕМ и не перезапустив API.
// Фраза «регулируемой закупке ставят 24» в таком виде невыполнима буквально: ставят не
// закупке, а серверу.
//
// Аналогия с `budget_policies.block_pct`, которой я это обосновывал, не держалась: тот
// лежит в таблице, по организации, и меняется с экрана. Здесь теперь так же — и по МЕТОДУ
// закупки, потому что пауза нужна открытому тендеру и совершенно не нужна закупке из трёх
// предложений: `OPEN_TENDER` 24, `RFQ` 0, и это одна и та же организация.
//
// Строение намеренно повторяет `procurement_method_policies`: по организации покупателя,
// RLS по `buyer_org_id`, замена целым набором. Кто умеет править те, поймёт и эти.
//
// Переменная окружения остаётся УМОЛЧАНИЕМ: метод, для которого политики нет, берёт её.
// Ноль по-прежнему значит «паузы нет», и по-прежнему это умолчание — новый запрет,
// останавливающий закупщика посреди работы, включают осознанно.
//
// 720 часов (30 суток) сверху — про процедуру, а не про интерфейс.
//
// Паузы на возражение такой длины не бывает нигде: в ЕС это десять дней, здесь короче, и
// срок в месяц — не процедура, а ошибка ввода (лишний ноль). Это обоснование переживёт
// любую переделку экранов.
//
// Сначала я обосновал границу иначе — тем, что интерфейс не умеет ждать дольше ~24.8
// суток, потому что `setTimeout` держит задержку в 32 битах. Это уже неверно: в том же
// круге правок `useDeadlineTick` стал ограничивать задержку сутками и перевзводиться, то
// есть далёкий срок обходит сутками. Ограничение, обоснованное изъяном, которого больше
// нет, читается как «можно поднять, починив фронт» — а поднимать его не нужно.
//
// Та же граница зажата и на чтении `AWARD_STANDSTILL_HOURS` (`config.service.ts`): иначе
// она обходилась ровно тем путём, что остался умолчанием.
export class StandstillPolicies1720000000049 implements MigrationInterface {
  name = 'StandstillPolicies1720000000049';

  public async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE award_standstill_policies (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        buyer_org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        method procurement_method NOT NULL,
        hours int NOT NULL CHECK (hours >= 0 AND hours <= 720),
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (buyer_org_id, method)
      )`);
    await q.query(`ALTER TABLE award_standstill_policies ENABLE ROW LEVEL SECURITY`);
    await q.query(`ALTER TABLE award_standstill_policies FORCE ROW LEVEL SECURITY`);
    await q.query(`
      CREATE POLICY asp_rls ON award_standstill_policies FOR ALL
        USING (buyer_org_id = app_org_id())
        WITH CHECK (buyer_org_id = app_org_id())`);
    await q.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON award_standstill_policies TO app_user`);
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE award_standstill_policies`);
  }
}

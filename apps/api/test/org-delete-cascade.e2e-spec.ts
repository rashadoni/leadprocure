import { randomUUID } from 'crypto';
import { Client } from 'pg';

// Удаление организации-поставщика не блокируется присуждением покупателя.
//
// `bids` уходит каскадом от организации поставщика, `awards` — от `sourcing_events`, то есть
// от покупателя. Пока `awards.winning_bid_id` был объявлен без `ON DELETE` (`NO ACTION`),
// удаление поставщика при живом покупателе падало: `NO ACTION` проверяется в конце своего
// подоператора и видел присуждение, которое ещё не удалено.
//
// Это единственное место схемы, где строка ПОКУПАТЕЛЯ ссылается на строку ПОСТАВЩИКА, и
// поймано оно падением чистки `rfi-rfp.e2e-spec.ts` на полном прогоне CI. Прод организации не
// удаляет — значит цена дефекта не в данных, а в гейте: он ронял прогон так, что объяснением
// становилось «перезапусти».
//
// Набор идёт по схеме напрямую, соединением владельца: проверяется ограничение, а не ручка
// API, и поднимать для этого приложение Nest незачем.
describe('удаление организации: каскад не упирается в чужую ветвь', () => {
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const ids = () => ({
    buyer: randomUUID(), supplier: randomUUID(),
    buyerUser: randomUUID(), supplierUser: randomUUID(),
    event: randomUUID(), bid: randomUUID(), award: randomUUID(),
  });

  // Минимальная форма присуждения: покупатель, поставщик, событие, ставка, решение.
  const seed = async (o: ReturnType<typeof ids>) => {
    await db.query(
      `INSERT INTO organizations(id,kind,legal_name,voen) VALUES ($1,'BUYER',$3,'1234567890'),($2,'SUPPLIER',$4,'1234567891')`,
      [o.buyer, o.supplier, `Casc Buyer ${tag}`, `Casc Sup ${tag}`],
    );
    await db.query(
      `INSERT INTO organization_users(id,email,password_hash,full_name) VALUES ($1,$3,'x','B'),($2,$4,'x','S')`,
      [o.buyerUser, o.supplierUser, `cb-${o.buyerUser}@t.test`, `cs-${o.supplierUser}@t.test`],
    );
    await db.query(
      `INSERT INTO sourcing_events(id,buyer_org_id,created_by,type,title,status,visibility,evaluation_currency)
       VALUES ($1,$2,$3,'RFQ',$4,'AWARDED','PUBLIC','AZN')`,
      [o.event, o.buyer, o.buyerUser, `Casc event ${tag}`],
    );
    await db.query(
      `INSERT INTO bids(id,event_id,supplier_org_id,submitted_by,state) VALUES ($1,$2,$3,$4,'OPENED')`,
      [o.bid, o.event, o.supplier, o.supplierUser],
    );
    await db.query(
      `INSERT INTO awards(id,event_id,winning_bid_id,winner_org_id,awarded_by) VALUES ($1,$2,$3,$4,$5)`,
      [o.award, o.event, o.bid, o.supplier, o.buyerUser],
    );
  };

  beforeAll(async () => {
    db = new Client({ connectionString: process.env.DATABASE_OWNER_URL ?? process.env.DATABASE_URL });
    await db.connect();
  });

  afterAll(async () => {
    if (db) {
      // Чистим ТОЛЬКО организации, как и остальные наборы. Пользователей не трогаем: таблица
      // `organization_users` глобальная (в ней нет org_id), и на неё ссылаются девятнадцать
      // FK без `ON DELETE` и без индексов — удаление по широкому шаблону обходит их
      // последовательно для каждой строки. Первая редакция чистила `email LIKE 'c%@t.test'`,
      // то есть задевала пользователей ЧУЖИХ наборов и вешала прогон на минуты.
      await db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`Casc %${tag}`]);
      await db.end();
    }
  });

  // Тот самый случай. До миграции 0053 здесь падало
  // `violates foreign key constraint "awards_winning_bid_id_fkey"`.
  it('поставщика можно удалить, пока покупатель и его присуждение живы', async () => {
    const o = ids();
    await seed(o);
    await db.query(`DELETE FROM organizations WHERE id = $1`, [o.supplier]);
    // Ставка ушла вместе с поставщиком, а присуждение — вместе со ставкой: без победившей
    // ставки решения не бывает, поэтому CASCADE, а не осиротевшая строка.
    expect((await db.query(`SELECT 1 FROM bids WHERE id=$1`, [o.bid])).rowCount).toBe(0);
    expect((await db.query(`SELECT 1 FROM awards WHERE id=$1`, [o.award])).rowCount).toBe(0);
    // Покупатель и его событие на месте: удаляли поставщика, а не тендер.
    expect((await db.query(`SELECT 1 FROM organizations WHERE id=$1`, [o.buyer])).rowCount).toBe(1);
    expect((await db.query(`SELECT 1 FROM sourcing_events WHERE id=$1`, [o.event])).rowCount).toBe(1);
  });

  // Случай, который работал и до правки, — он здесь, чтобы правка его не сломала: обе
  // организации одним оператором. Именно так чистят за собой наборы e2e.
  it('обе организации одним оператором — как чистят за собой наборы', async () => {
    const o = ids();
    await seed(o);
    await db.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[o.buyer, o.supplier]]);
    for (const [table, id] of [['organizations', o.buyer], ['sourcing_events', o.event], ['bids', o.bid], ['awards', o.award]] as const) {
      expect((await db.query(`SELECT 1 FROM ${table} WHERE id=$1`, [id])).rowCount).toBe(0);
    }
  });

  // Обратная сторона: удаление ПОКУПАТЕЛЯ не должно задевать организацию поставщика — она
  // живёт сама по себе и может участвовать в тендерах других покупателей.
  it('покупателя можно удалить, и поставщик остаётся', async () => {
    const o = ids();
    await seed(o);
    await db.query(`DELETE FROM organizations WHERE id = $1`, [o.buyer]);
    expect((await db.query(`SELECT 1 FROM sourcing_events WHERE id=$1`, [o.event])).rowCount).toBe(0);
    expect((await db.query(`SELECT 1 FROM awards WHERE id=$1`, [o.award])).rowCount).toBe(0);
    expect((await db.query(`SELECT 1 FROM organizations WHERE id=$1`, [o.supplier])).rowCount).toBe(1);
    // Ставка уходит вместе с событием — это прежнее поведение (`bids.event_id` CASCADE).
    expect((await db.query(`SELECT 1 FROM bids WHERE id=$1`, [o.bid])).rowCount).toBe(0);
  });

  // Ограничение должно быть именно CASCADE, а не просто «не мешать»: если кто-то вернёт
  // `NO ACTION`, первый тест упадёт, но причину будет видно только здесь.
  it('связь присуждения со ставкой объявлена ON DELETE CASCADE', async () => {
    const r = await db.query(
      `SELECT c.confdeltype FROM pg_constraint c
       WHERE c.contype='f' AND c.conrelid='awards'::regclass AND c.conname='awards_winning_bid_id_fkey'`,
    );
    expect(r.rows[0]?.confdeltype).toBe('c');
  });
});

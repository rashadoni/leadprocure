import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { AppModule } from '../src/app.module';
import { addApprover } from './helpers';

// Пауза на возражение и итоги закупки глазами участника.
//
// Присуждение закрывало дверь в ту же секунду, в которую открывало: контракт создавался
// сразу, отмена присуждения после контракта невозможна, а проигравшему не говорили ничего.
// Здесь проверяются обе половины правила — и та, что запрещает (контракт в паузу), и та,
// что разрешает (письменный отказ и истёкший срок), — потому что запрет без выхода
// обходят мимо системы, а выход без запрета ничего не защищает.
describe('пауза на возражение и итоги для участника', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];

  let buyer: string, approver: string, buyerOrg: string;
  let s1: string, s2: string, s3: string, s4: string;
  let s1Org: string, s2Org: string, s3Org: string, s4Org: string;
  let s1Name: string;
  let eventId: string, lot1: string, lot2: string, itemA: string, itemB: string;
  let bid1: string, bid2: string, bid3: string;
  let award1: string, award2: string;
  const envBefore = process.env.AWARD_STANDSTILL_HOURS;

  beforeAll(async () => {
    // Пауза вооружается ДО подъёма приложения: AppConfig читает окружение один раз.
    process.env.AWARD_STANDSTILL_HOURS = '24';
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = new Client({ connectionString: process.env.DATABASE_URL });
    await db.connect();

    const reg = async (path: string, name: string, email: string) => {
      const r = await http().post(path).send({ legalName: name, email, password: 'password123', fullName: name })
        .expect(201);
      return { token: r.body.accessToken as string, org: r.body.org.id as string };
    };
    ({ token: buyer, org: buyerOrg } = await reg('/auth/register/buyer', `SS Buyer ${tag}`, `ssb-${tag}@t.test`));
    approver = await addApprover(app, buyer, tag);
    s1Name = `SS S1 ${tag}`;
    ({ token: s1, org: s1Org } = await reg('/auth/register/supplier', s1Name, `sss1-${tag}@t.test`));
    ({ token: s2, org: s2Org } = await reg('/auth/register/supplier', `SS S2 ${tag}`, `sss2-${tag}@t.test`));
    ({ token: s3, org: s3Org } = await reg('/auth/register/supplier', `SS S3 ${tag}`, `sss3-${tag}@t.test`));
    // S4 приглашён, но не подавал ставку: он проверяет, что итоги открывает участие, а не
    // приглашение.
    ({ token: s4, org: s4Org } = await reg('/auth/register/supplier', `SS S4 ${tag}`, `sss4-${tag}@t.test`));

    await http().put('/requests/method-policies').set(...bearer(buyer))
      .send({ policies: [{ category: '*', minAmountMinor: 0, maxAmountMinor: null, method: 'RFQ' }] }).expect(200);
  });

  afterAll(async () => {
    if (envBefore === undefined) delete process.env.AWARD_STANDSTILL_HOURS;
    else process.env.AWARD_STANDSTILL_HOURS = envBefore;
    try {
      if (buyerOrg) await db.query('DELETE FROM organizations WHERE id = $1', [buyerOrg]);
      await db.query(`DELETE FROM organizations WHERE legal_name LIKE $1`, [`SS %${tag}%`]);
    } finally {
      try { await db.end(); } finally { await app.close(); }
    }
  });

  it('двухлотовая закупка доходит до оценки: три ставки, одна снята', async () => {
    const req = await http().post('/requests').set(...bearer(buyer)).send({
      title: `SS ${tag}`,
      items: [
        { name: 'Item A', qty: 10, estUnitPriceMinor: 100_000 },
        { name: 'Item B', qty: 5, estUnitPriceMinor: 200_000 },
      ],
    }).expect(201);
    await http().post(`/requests/${req.body.id}/submit`).set(...bearer(buyer)).expect(201);
    await http().post(`/requests/${req.body.id}/approve`).set(...bearer(approver)).expect(201);

    const ev = await http().post(`/events/from-request/${req.body.id}`).set(...bearer(buyer))
      .send({ closeAt: new Date(Date.now() + 3600_000).toISOString(), visibility: 'INVITED' }).expect(201);
    eventId = ev.body.id;
    lot1 = ev.body.lots[0].id;
    itemA = ev.body.items.find((i: any) => i.name === 'Item A').id;
    itemB = ev.body.items.find((i: any) => i.name === 'Item B').id;
    const l2 = await http().post(`/events/${eventId}/lots`).set(...bearer(buyer)).send({ title: 'Lot 2' }).expect(201);
    lot2 = l2.body.id;
    await http().put(`/events/${eventId}/items/${itemB}/lot`).set(...bearer(buyer)).send({ lotId: lot2 }).expect(200);

    for (const org of [s1Org, s2Org, s3Org, s4Org]) {
      await http().post(`/events/${eventId}/invite`).set(...bearer(buyer)).send({ supplierOrgId: org }).expect(201);
    }
    await http().post(`/events/${eventId}/publish`).set(...bearer(buyer)).expect(201);

    const bid = async (token: string, a: number, b: number) => (await http().post(`/events/${eventId}/bid`)
      .set(...bearer(token))
      .send({ items: [{ eventItemId: itemA, unitPriceMinor: a }, { eventItemId: itemB, unitPriceMinor: b }] })
      .expect(201)).body.id;
    bid1 = await bid(s1, 90_000, 210_000);
    bid2 = await bid(s2, 110_000, 180_000);
    bid3 = await bid(s3, 95_000, 190_000);

    await db.query(`SELECT set_config('app.org_id',$1,false), set_config('app.role','BUYER_ADMIN',false)`, [buyerOrg]);
    await db.query(`UPDATE sourcing_events SET close_at = now() - interval '1 second' WHERE id=$1`, [eventId]);
    await db.query(`SELECT * FROM close_due_events()`);
    await http().post(`/events/${eventId}/open`).set(...bearer(buyer)).expect(201);
  });

  it('дисквалифицированному говорят отдельно и со своей причиной', async () => {
    await http().post(`/events/${eventId}/bids/${bid3}/disqualify`).set(...bearer(buyer))
      .send({ reason: 'нет сертификата на поставляемое оборудование' }).expect(201);
    const notes = (await http().get('/notifications').set(...bearer(s3)).expect(200)).body;
    const dq = notes.find((n: any) => n.type === 'BID_DISQUALIFIED');
    // Без этого письма поставщик узнавал о снятии ставки ниоткуда: присуждение его уже
    // не уведомляет — он выбыл.
    expect(dq).toBeTruthy();
    expect(dq.payload.reason).toContain('сертификата');
  });

  it('при присуждении пишут ВСЕМ участникам лота, а не одному победителю', async () => {
    await http().post(`/events/${eventId}/evaluate`).set(...bearer(buyer)).send({
      scores: [
        { bidId: bid1, key: 'price', score: 90 }, { bidId: bid1, key: 'delivery', score: 90 },
        { bidId: bid2, key: 'price', score: 70 }, { bidId: bid2, key: 'delivery', score: 70 },
      ],
    }).expect(201);
    const a1 = await http().post(`/events/${eventId}/award`).set(...bearer(buyer))
      .send({ lotId: lot1, bidId: bid1 }).expect(201);
    award1 = a1.body.award.id;
    // Срок возражения выставлен из настройки и попал в ответ.
    expect(a1.body.award.standstill_until).toBeTruthy();

    const typesOf = async (token: string) => (await http().get('/notifications').set(...bearer(token)).expect(200))
      .body.map((n: any) => n.type);
    expect(await typesOf(s1)).toContain('BID_AWARDED');
    const loser = (await http().get('/notifications').set(...bearer(s2)).expect(200)).body
      .find((n: any) => n.type === 'BID_NOT_AWARDED');
    // Проигравший раньше не узнавал исхода вовсе: его ставка навсегда оставалась «подана».
    expect(loser).toBeTruthy();
    // Срок — часть сообщения: без него «вы не выбраны» не говорит, есть ли смысл отвечать.
    expect(loser.payload.standstill_until).toBeTruthy();
    // Дисквалифицированному про присуждение не пишут — ему сказали своё и с причиной.
    expect(await typesOf(s3)).not.toContain('BID_NOT_AWARDED');
  });

  it('участник видит итог: кто победил и за сколько; посторонний — нет', async () => {
    const asLoser = (await http().get(`/events/${eventId}`).set(...bearer(s2)).expect(200)).body;
    expect(asLoser.results).toHaveLength(1);
    const r = asLoser.results[0];
    expect(r.winner_name).toBe(s1Name);
    expect(Number(r.winning_total_minor)).toBe(900_000); // 10 × 90k по лоту 1
    expect(r.won_by_me).toBe(false);
    expect(r.standstill_until).toBeTruthy();

    const asWinner = (await http().get(`/events/${eventId}`).set(...bearer(s1)).expect(200)).body;
    expect(asWinner.results[0].won_by_me).toBe(true);

    // S4 приглашён, видит закупку — но ставку не подавал, и итоги ему не принадлежат.
    const asBystander = (await http().get(`/events/${eventId}`).set(...bearer(s4)).expect(200)).body;
    expect(asBystander.results).toHaveLength(0);
  });

  it('в паузу контракт по лоту не создаётся', async () => {
    const refused = await http().post(`/contracts/from-award/${award1}`).set(...bearer(buyer)).expect(400);
    expect(refused.body.code).toBe('AWARD_STANDSTILL_ACTIVE');
    // Присуждение осталось отменяемым — в этом и смысл паузы.
    const rows = await db.query(`SELECT cancelled_at FROM awards WHERE id=$1`, [award1]);
    expect(rows.rows[0].cancelled_at).toBeNull();
  });

  it('отписка вместо причины не принимается, и дверь остаётся закрытой', async () => {
    await http().post(`/events/${eventId}/waive-standstill`).set(...bearer(buyer))
      .send({ lotId: lot1, reason: 'срочно' }).expect(400);
    const rows = await db.query(`SELECT standstill_waived_reason FROM awards WHERE id=$1`, [award1]);
    expect(rows.rows[0].standstill_waived_reason).toBeNull();
    await http().post(`/contracts/from-award/${award1}`).set(...bearer(buyer)).expect(400);
  });

  it('письменный отказ открывает дверь, попадает в журнал и в уведомление участникам', async () => {
    const reason = 'аварийная замена насоса, простой котельной с 12:00';
    await http().post(`/events/${eventId}/waive-standstill`).set(...bearer(buyer))
      .send({ lotId: lot1, reason }).expect(201);
    const audit = await db.query(
      `SELECT payload FROM audit_events WHERE action='AWARD_STANDSTILL_WAIVED' AND entity_id=$1`, [eventId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].payload.reason).toBe(reason);
    // Участникам обещали срок — и обязаны сказать, что он закончился раньше.
    const told = (await http().get('/notifications').set(...bearer(s2)).expect(200)).body
      .some((n: any) => n.type === 'AWARD_STANDSTILL_WAIVED');
    expect(told).toBe(true);
    const c = await http().post(`/contracts/from-award/${award1}`).set(...bearer(buyer)).expect(201);
    expect(Number(c.body.total_minor)).toBe(900_000);
    // Отказ виден участнику вместе с причиной: иначе исчезнувший срок читается как сбой.
    const asLoser = (await http().get(`/events/${eventId}`).set(...bearer(s2)).expect(200)).body;
    expect(asLoser.results[0].standstill_waived_reason).toBe(reason);
  });

  it('истёкший срок открывает дверь сам, без отказа', async () => {
    const a2 = await http().post(`/events/${eventId}/award`).set(...bearer(buyer))
      .send({ lotId: lot2, bidId: bid2, justification: 'лучшая цена по лоту 2' }).expect(201);
    award2 = a2.body.award.id;
    await http().post(`/contracts/from-award/${award2}`).set(...bearer(buyer)).expect(400);
    await db.query(`UPDATE awards SET standstill_until = now() - interval '1 minute' WHERE id=$1`, [award2]);
    const c = await http().post(`/contracts/from-award/${award2}`).set(...bearer(buyer)).expect(201);
    expect(Number(c.body.total_minor)).toBe(900_000); // 5 × 180k по лоту 2
  });
});

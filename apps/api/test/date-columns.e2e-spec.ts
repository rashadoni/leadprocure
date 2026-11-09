import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { teardown } from './helpers';

// A `date` column is a DAY. Read as a Date it lands on the host's LOCAL midnight, and the
// next `toISOString()` carries it to UTC — onto the previous day anywhere east of
// Greenwich. Production runs in UTC, which is the only reason this ever looked fine; this
// dev box runs Europe/Berlin and an installation in Baku is +04.
//
// So the fix is a driver-level one (src/common/db/pg-date-type.ts) and this suite guards
// both halves of it: that a day comes back as a day, and that the budget module — the one
// that slices everything by period — still names the right year with the clock moved east.
describe('date columns are days, not instants (API e2e)', () => {
  let app: INestApplication;
  let db: Client;
  const tag = randomUUID().slice(0, 8);
  const http = () => request(app.getHttpServer());
  const bearer = (t: string) => ['Authorization', `Bearer ${t}`] as [string, string];
  let buyer: string;
  // Next year, so the assertion does not depend on which year the suite runs in, and the
  // 1 January boundary — where a westward shift changes the YEAR, not just the day — is
  // the one under test.
  const YEAR = new Date().getFullYear() + 1;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = new Client({ connectionString: process.env.DATABASE_OWNER_URL ?? process.env.DATABASE_URL });
    await db.connect();
    buyer = (await http().post('/auth/register/buyer').send({
      legalName: `Dates ${tag}`, email: `dates-${tag}@t.test`, password: 'password123', fullName: 'Dates',
    }).expect(201)).body.accessToken;
  });

  afterAll(async () => {
    await teardown(db, app, () => db.query('DELETE FROM organizations WHERE legal_name LIKE $1', [`Dates %${tag}`]));
  });

  // The guard that cannot drift with the clock: a day is text. Remove the type parser and
  // this fails outright, whatever timezone the runner happens to be in. One cast covers
  // every `date` column in the schema — budget periods, phasing months, a contract's
  // validity, a shipment's ETA, an invoice due date — because they share OID 1082.
  it('hands a date column back as its ISO day, not as a Date', async () => {
    const [row] = await app.get(DataSource).query(
      `SELECT '2026-01-01'::date AS d, NULL::date AS empty`,
    );
    expect(typeof row.d).toBe('string');
    expect(row.d).toBe('2026-01-01');
    expect(row.empty).toBeNull();
  });

  // The guard above argues from the TYPE, so the type is what has to hold: this is the set of
  // columns that argument covers. Failing here is the point of the test — a day-shaped column
  // added as a `timestamptz` sits outside the parser and comes back as an instant, and one
  // quietly retyped away from `date` leaves it the same way. Add a new `date` column to this
  // list once you have checked that nothing reads it through `new Date()`.
  it('keeps every day-shaped column typed as `date`', async () => {
    const rows = await app.get(DataSource).query(
      `SELECT table_name || '.' || column_name AS col FROM information_schema.columns
       WHERE table_schema = 'public' AND data_type = 'date' ORDER BY col`,
    );
    expect(rows.map((r: any) => r.col)).toEqual([
      'bids.fx_date',
      'budget_phasing.month_start',
      'budgets.period_end',
      'budgets.period_start',
      'catalogs.valid_from',
      'catalogs.valid_to',
      'contracts.valid_from',
      'contracts.valid_to',
      'fx_rates.as_of',
      'invoices.due_date',
      'invoices.issue_date',
      'shipments.eta',
    ]);
  });

  // The product half, with the clock where the customers are. Under Asia/Baku this used to
  // answer periodStart `${YEAR - 1}-12-31`, periodYear `YEAR - 1` and the label
  // `${YEAR - 1} Q4` — a plan for next January filed under last year.
  describe('east of UTC', () => {
    const original = process.env.TZ;
    let budgetId: string;

    beforeAll(() => { process.env.TZ = 'Asia/Baku'; });
    afterAll(() => {
      // --runInBand shares one process across every spec file: leaving TZ moved would
      // quietly re-time every suite after this one.
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    });

    it('keeps a quarter in the year it was planned for', async () => {
      const made = (await http().post('/budgets').set(...bearer(buyer)).send({
        name: `Jan ${tag}`, category: `DATECAT-${tag}`, amountMinor: 1_200_000,
        periodType: 'QUARTER', periodYear: YEAR, periodQuarter: 1,
      }).expect(201)).body;
      budgetId = made.id;
      expect(made.periodStart).toBe(`${YEAR}-01-01`);
      expect(made.periodEnd).toBe(`${YEAR}-03-31`);
      expect(made.periodYear).toBe(YEAR);
      expect(made.periodLabel).toBe(`${YEAR} Q1`);
    });

    // The list is filtered by year in SQL, so a budget whose year was mis-read on the way
    // out would answer the `year=YEAR` filter and then print the year before it.
    it('reads back the same period from the list', async () => {
      const listed = (await http().get('/budgets').query({ year: YEAR }).set(...bearer(buyer)).expect(200)).body
        .find((b: any) => b.id === budgetId);
      expect(listed).toBeTruthy();
      expect([listed.periodStart, listed.periodEnd, listed.periodLabel])
        .toEqual([`${YEAR}-01-01`, `${YEAR}-03-31`, `${YEAR} Q1`]);
    });

    // What finance actually hands to the accounting system. A quarter is three months; the
    // shift made it four, the first of them in the previous December — a plan 1C would
    // book against the wrong year.
    it('exports a quarter as three months of the right year', async () => {
      const csv = (await http().get('/budgets/export/1c').query({ year: YEAR })
        .set(...bearer(buyer)).expect(200)).text;
      const mine = csv.trim().split('\r\n').slice(1).filter((r) => r.includes(`Jan ${tag}`));
      expect(mine).toHaveLength(3);
      expect(mine.map((r) => r.split(';')[0])).toEqual(
        [`"${YEAR}-01"`, `"${YEAR}-02"`, `"${YEAR}-03"`],
      );
      expect(mine[0]).toContain(`"${YEAR}-01-01"`);
      // The rows still total the plan exactly — the remainder lands on the last month.
      const sum = mine.reduce((n, r) => n + Math.round(Number(r.split(';')[7].replace(/"/g, '')) * 100), 0);
      expect(sum).toBe(1_200_000);
    });

    // Phasing is stored per month and must add up to 10000 bp. With the period read a day
    // early the editor offered a 13-month set for a year and a 4-month one for a quarter,
    // so a correct set was refused as "not 100%".
    it('phases a quarter month by month, and the set adds up', async () => {
      const months = [`${YEAR}-01`, `${YEAR}-02`, `${YEAR}-03`];
      await http().put(`/budgets/${budgetId}/phasing`).set(...bearer(buyer))
        .send({ months: [{ month: months[0], shareBp: 5000 }, { month: months[1], shareBp: 3000 }, { month: months[2], shareBp: 2000 }] })
        .expect(200);
      const back = (await http().get(`/budgets/${budgetId}/phasing`).set(...bearer(buyer)).expect(200)).body;
      expect(back.months.map((m: any) => m.month)).toEqual(months);
      expect(back.months.reduce((n: number, m: any) => n + m.shareBp, 0)).toBe(10000);
    });
  });
});

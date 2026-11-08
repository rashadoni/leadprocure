import { types } from 'pg';

// Postgres OID 1082 is `date` — a DAY, with no time and no zone. The driver's default
// parser turns it into a Date at LOCAL midnight, and every `toISOString()` after that
// carries it to UTC: four hours west in Baku, one in Berlin, i.e. onto the previous day.
//
// Nothing was ever wrong in the database; the shift happened on the way out, and it slept
// only because the production container runs in UTC. Measured under TZ=Asia/Baku, a budget
// for 2026 reported `periodYear: 2025`, its label read "2025 Q4" instead of "2026 Q1", the
// 1C export emitted THIRTEEN months starting the previous December, phasing refused a set
// that added up to 100%, and a period ending 31 December could be closed a day early.
// This dev box runs Europe/Berlin, so it already shows all of it.
//
// A day therefore comes back as the text Postgres already sends: `YYYY-MM-DD`. The web
// parses exactly that form as a local day on purpose (`fmtDate`, apps/web/src/api/client.ts
// — a `YYYY-MM-DD` taken as an instant is UTC midnight, which printed a 1 December due date
// as 30 November west of Greenwich), and string comparison on ISO days is chronological,
// which is what the budget engine does with periods. Fixing it here rather than query by
// query covers the `SELECT *` reads too — contracts' `valid_from`/`valid_to`, catalogs',
// shipments' `eta` — which no `to_char` at a call site can reach.
//
// Imported for its side effect, and it has to run before the first query: every entry point
// that opens a connection imports it (database.module.ts, data-source.ts, seed.ts) and so
// does the e2e setup file. Pinned by test/date-columns.e2e-spec.ts.
const DATE_OID = 1082;

types.setTypeParser(DATE_OID, (value: string) => value);

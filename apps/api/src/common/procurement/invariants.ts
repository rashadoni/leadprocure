import { BadRequestException, ForbiddenException } from '@nestjs/common';

// Advisory locks work for both buyer and supplier, unlike FOR UPDATE under buyer-only RLS.
export async function lockOrder(m: any, id: string) {
  await m.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 84))`, [id]);
}
export async function lockEvent(m: any, id: string) {
  await m.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 42))`, [id]);
}
export async function assertSupplierAllowed(m: any, buyer: string, supplier: string) {
  await m.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,85))`,[`${buyer}:${supplier}`]);
  const rows = await m.query(`SELECT supplier_is_blocked($1, $2) AS blocked`, [buyer, supplier]);
  if (rows[0]?.blocked) throw new ForbiddenException('Supplier is blocked for new procurement actions');
}
export function uniqueIds(items: any[], key: string) {
  if (new Set(items.map(i => i[key])).size !== items.length) throw new BadRequestException(`Duplicate ${key}`);
}
export function safeMoney(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new BadRequestException('Amount must be a non-negative safe integer');
  return n;
}
export function lineMoney(qty: number, price: number): number {
  safeMoney(qty); safeMoney(price);
  return safeMoney(qty * price);
}
// What a line stored in the database is worth, rounded the way Postgres rounds it.
// `qty` columns are `numeric`, and po_amendment_decide computes
// round(qty::numeric * price::bigint) — so JS replaying a stored line has to round too,
// instead of demanding an integer quantity the schema never promised and the SQL side
// contradicts. The guard stays on the money: a product JavaScript cannot hold exactly
// throws rather than quietly losing a minor unit.
export function storedLineMoney(qty: number, price: number): number {
  safeMoney(price);
  if (!Number.isFinite(qty) || qty < 0) {
    throw new BadRequestException('Quantity must be a non-negative number');
  }
  return safeMoney(Math.round(qty * price));
}
export function taxTotals(amount: number, rate: number, mode: string) {
  safeMoney(amount);
  if (!Number.isInteger(rate) || rate < 0 || rate > 10000) throw new BadRequestException('VAT rate must be 0..10000 basis points');
  const a = BigInt(amount), r = BigInt(rate);
  const round = (n: bigint, d: bigint) => (n + d / 2n) / d;
  const tax = Number(mode === 'INCLUSIVE' ? round(a * r, 10000n + r) : round(a * r, 10000n));
  const net = mode === 'INCLUSIVE' ? amount - tax : amount;
  return { net, tax, gross: safeMoney(net + tax) };
}
// TypeORM raw UPDATE/DELETE returns [rows, affectedCount], SELECT/INSERT returns rows.
export function returnedRows(raw: any): any[] {
  return Array.isArray(raw?.[0]) && typeof raw[1] === 'number' ? raw[0] : raw;
}

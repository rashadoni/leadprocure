// Human text for dashboard tasks and notifications: machine codes (INVOICE_SUBMITTED,
// APPROVE_REQUEST…) become i18n sentences with payload fields interpolated. Unknown
// codes fall back to the raw code so nothing silently disappears.
export const taskLabel = (t: (k: string) => string, kind: string): string => {
  const key = `task_${kind}`;
  const v = t(key);
  return v === key ? kind : v;
};

// Status enums inside payloads ({status}: DELIVERED, DISPUTED…) are localized through
// the same st_<STATUS> dictionary the badges use — short label, not the explanation.
export const statusLabel = (t: (k: string) => string, v: unknown): string => {
  const key = `st_${v}`;
  const full = t(key);
  return full === key ? String(v) : full.split(' — ')[0].split(' / ')[0].split(' (')[0];
};

export const notifText = (t: (k: string) => string, n: { type: string; payload?: Record<string, unknown> }): string => {
  const key = `ntf_${n.type}`;
  const tpl = t(key);
  if (tpl === key) return n.type;
  return tpl
    .replace(/\{(\w+)\}/g, (_, k: string) => {
      const v = n.payload?.[k];
      if (v == null) return '';
      return k === 'status' ? statusLabel(t, v) : String(v);
    })
    .replace(/\(\s*\)|«\s*»/g, '') // drop empty brackets when a payload field is missing
    .trim();
};

// The organisation's line under the department rollup. Only top-level rows are added: a
// parent department's figures already include its units (the ⤵ beside its name) and its
// units are listed under it, so adding every row would count that money twice. The browser
// stand has no nested departments at all, which is exactly why this lives here and is
// asked directly — the one case that matters is the one no screen in CI can show.
export interface RollupRow {
  depth?: number;
  amountMinor?: number | string;
  committedMinor?: number | string;
  actualMinor?: number | string;
  paidMinor?: number | string;
  remainingMinor?: number | string;
  forecastMinor?: number | string;
}
export function rollupTotals(rows: RollupRow[]): {
  plan: number; committed: number; actual: number; paid: number;
  remaining: number; forecast: number; utilizationPct: number | null;
} {
  const top = rows.filter((r) => (r.depth ?? 0) === 0);
  const sum = (pick: (r: RollupRow) => number | string | undefined) =>
    top.reduce((n, r) => n + (Number(pick(r)) || 0), 0);
  const plan = sum((r) => r.amountMinor);
  const committed = sum((r) => r.committedMinor);
  const actual = sum((r) => r.actualMinor);
  return {
    plan,
    committed,
    actual,
    paid: sum((r) => r.paidMinor),
    remaining: sum((r) => r.remainingMinor),
    forecast: sum((r) => r.forecastMinor),
    // Paid is never added in: it settles orders already counted as actual.
    utilizationPct: plan > 0 ? Math.round(((committed + actual) / plan) * 100) : null,
  };
}
// A change order's line printed both sides of both figures always, so an amendment that
// touched only the quantity read «40 → 60 × 7.00 AZN → 7.00 AZN»: half the sentence said
// that nothing happened. Both the supplier's list and the order's own card draw this line,
// so what counts as changed is decided once, here. Numbers come out of a jsonb snapshot and
// may be strings on one side and numbers on the other — compare as numbers.
export const amendedQty = (c: { oldQty: unknown; newQty: unknown }): boolean =>
  Number(c.oldQty) !== Number(c.newQty);
export const amendedPrice = (c: { oldUnitPriceMinor: unknown; newUnitPriceMinor: unknown }): boolean =>
  Number(c.oldUnitPriceMinor) !== Number(c.newUnitPriceMinor);

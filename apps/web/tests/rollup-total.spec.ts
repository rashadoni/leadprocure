import { test, expect } from '@playwright/test';
import { rollupTotals } from '../src/components/humanize';

// The organisation's line under the department rollup, asked directly rather than through a
// screen. Two reasons it lives here: the stand the browser suite runs on has ONE rollup row
// (the seed's budgets land in one group), so a page could never show the arithmetic at all;
// and the case that actually matters — a parent department whose figures already include
// its units — has no nested departments anywhere in CI to be made of.
//
// Without a total, the rollup's first row read as one: «Вся организация» stood above IT and
// OPS with a smaller plan than either, because it is the org-wide BUDGET, not a sum.
const row = (over: Partial<Parameters<typeof rollupTotals>[0][number]> = {}) => ({
  depth: 0, amountMinor: 0, committedMinor: 0, actualMinor: 0,
  paidMinor: 0, remainingMinor: 0, forecastMinor: 0, ...over,
});

test('adds the rows up, and keeps paid out of utilization', () => {
  const sums = rollupTotals([
    row({ amountMinor: 4_000_000, actualMinor: 14_400, remainingMinor: 3_985_600 }),
    row({ amountMinor: 9_500_000, committedMinor: 2_664_000, actualMinor: 5_194_000, paidMinor: 5_150_000, remainingMinor: 1_642_000 }),
  ]);
  expect(sums.plan).toBe(13_500_000);
  expect(sums.committed).toBe(2_664_000);
  expect(sums.actual).toBe(5_208_400);
  expect(sums.paid).toBe(5_150_000);
  expect(sums.remaining).toBe(5_627_600);
  // (committed + actual) / plan — paid settles orders already counted as actual, so adding
  // it would charge the same money twice.
  expect(sums.utilizationPct).toBe(58);
});

test('a parent already includes its units, so only the top level is added', () => {
  const sums = rollupTotals([
    row({ amountMinor: 1_000_000, actualMinor: 300_000 }),            // parent, ⤵
    row({ depth: 1, amountMinor: 600_000, actualMinor: 200_000 }),    // its unit
    row({ depth: 1, amountMinor: 400_000, actualMinor: 100_000 }),    // and another
  ]);
  expect(sums.plan, 'the units were counted a second time').toBe(1_000_000);
  expect(sums.actual).toBe(300_000);
});

test('strings out of the API are numbers here, and no plan means no percentage', () => {
  const sums = rollupTotals([row({ amountMinor: '0', actualMinor: '1500' as unknown as number })]);
  expect(sums.actual).toBe(1500);
  // a bare 0% would say the organisation is on plan; there is no plan
  expect(sums.utilizationPct).toBeNull();
});

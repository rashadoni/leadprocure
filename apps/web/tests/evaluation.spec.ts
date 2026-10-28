import { test, expect, type Locator } from '@playwright/test';
import { createRequire } from 'node:module';
const apiRequire = createRequire(new URL('../../api/package.json', import.meta.url));

// Real fixtures/API/auth/RLS. Keep one browser login for the entire scenario:
// the production login limiter remains enabled in acceptance.
test('current formal ranking and each lot survive re-evaluation and partial awards', async ({ page, request }) => {
  apiRequire('../../scripts/acceptance/assert-isolated.cjs')();
  const base = 'http://localhost:3000', tag = Date.now().toString(36), password = 'Audit-only-password123';
  const call = async (path: string, body: any, token?: string, method = 'post', status = 201) => {
    const r = await request.fetch(base + path, { method, data: body, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    expect(r.status(), await r.text()).toBe(status); return r.json();
  };
  const register = (kind: string, name: string) => call(`/auth/register/${kind}`, { legalName: `Browser audit ${name}`, email: `${name}-${tag}@audit.invalid`, password, fullName: name });
  const buyer = await register('buyer', 'buyer'), s1 = await register('supplier', 's1'), s2 = await register('supplier', 's2');
  await call('/settings/users', { email: `approver-${tag}@audit.invalid`, fullName: 'Approver', password, role: 'BUYER_APPROVER' }, buyer.accessToken);
  const approver = await call('/auth/login', { email: `approver-${tag}@audit.invalid`, password });
  const req = await call('/requests', { title: 'Browser custom criteria', items: [
    { name: 'Item A', qty: 1, estUnitPriceMinor: 10000 },
    { name: 'Item B', qty: 1, estUnitPriceMinor: 16000 },
  ] }, buyer.accessToken);
  await call(`/requests/${req.id}/submit`, {}, buyer.accessToken);
  await call(`/requests/${req.id}/approve`, {}, approver.accessToken);
  const event = await call(`/events/from-request/${req.id}`, { closeAt: new Date(Date.now() + 3600000).toISOString(), visibility: 'PUBLIC', criteria: [{ key: 'quality', weight: 60 }, { key: 'delivery', weight: 40 }] }, buyer.accessToken);
  const lotA = event.lots[0], lotB = await call(`/events/${event.id}/lots`, { title: 'Lot B' }, buyer.accessToken);
  const itemA = event.items.find((i: any) => i.name === 'Item A'), itemB = event.items.find((i: any) => i.name === 'Item B');
  await call(`/events/${event.id}/items/${itemB.id}/lot`, { lotId: lotB.id }, buyer.accessToken, 'put', 200);
  await call(`/events/${event.id}/publish`, {}, buyer.accessToken);
  const bids = [];
  for (const [supplier, priceA, priceB] of [[s1, 9000, 15000], [s2, 9500, 14000]] as const) {
    bids.push(await call(`/events/${event.id}/bid`, { items: [{ eventItemId: itemA.id, unitPriceMinor: priceA }, { eventItemId: itemB.id, unitPriceMinor: priceB }] }, supplier.accessToken));
  }
  const { Client } = apiRequire('pg'), db = new Client({ connectionString: process.env.DATABASE_OWNER_URL });
  await db.connect();
  try {
    await db.query(`UPDATE sourcing_events SET close_at=now()-interval '1 second' WHERE id=$1`, [event.id]);
    await db.query(`SELECT * FROM close_due_events()`);
  } finally { await db.end(); }
  await call(`/events/${event.id}/open`, {}, buyer.accessToken);
  await page.addInitScript(() => localStorage.setItem('lp_lang', 'en'));
  await page.goto('/login'); await page.fill('input[type=email]', `buyer-${tag}@audit.invalid`); await page.fill('input[type=password]', password);
  await page.click('form button.btn:not(.ghost):not([type=button])'); await page.waitForURL(/\/buyer\//);
  await page.goto(`/buyer/events/${event.id}`);
  const groupA = page.getByRole('group', { name: lotA.title, exact: true });
  const groupB = page.getByRole('group', { name: lotB.title, exact: true });
  // No cheapest-offer winner hint or actionable award before a real evaluation.
  await expect(groupA.getByRole('button', { name: /Browser audit s1/ })).toBeDisabled();
  await expect(groupA.getByRole('button', { name: /⭐/ })).toHaveCount(0);
  const quality = page.locator('label').filter({ hasText: 'quality · 60%' }).locator('input');
  const delivery = page.locator('label').filter({ hasText: 'delivery · 40%' }).locator('input');
  await expect(quality).toHaveCount(2);
  await quality.nth(0).fill('100'); await quality.nth(1).fill('100');
  await delivery.nth(0).fill('80'); await delivery.nth(1).fill('80');
  await page.getByRole('button', { name: 'Score', exact: true }).click();
  await expect(page.getByText('92.0', { exact: true })).toHaveCount(2);
  // Equal formal scores are a tie; a cheaper offer is not a unique score leader.
  await expect(groupA.getByRole('button', { name: /⭐/ })).toHaveCount(0);
  await expect(groupB.getByRole('button', { name: /⭐/ })).toHaveCount(0);
  await quality.nth(0).fill('50'); await quality.nth(1).fill('80'); await delivery.nth(1).fill('50');
  const evaluationResponse = page.waitForResponse(r => r.url().endsWith(`/events/${event.id}/evaluate`) && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Score', exact: true }).click();
  const currentEvaluation = await (await evaluationResponse).json();
  await expect(page.getByText('62.0', { exact: true })).toBeVisible();
  await expect(page.getByText('68.0', { exact: true })).toBeVisible();
  await expect(page.getByText('154.0', { exact: true })).toHaveCount(0);
  // S2's 68 points beat S1's 62 even on lot A, where S2 costs more.
  await expect(groupA.getByRole('button').first()).toHaveText(/Browser audit s2.*⭐/);
  await expect(groupB.getByRole('button').first()).toHaveText(/Browser audit s2.*⭐/);
  expect(currentEvaluation.ranking[0].bid_id).toBe(bids[1].id);
  const awardThrough = async (button: Locator, reason: string, targetEventId = event.id) => {
    const dialog = page.waitForEvent('dialog').then(async d => { expect(d.type()).toBe('prompt'); await d.accept(reason); });
    const response = page.waitForResponse(r => r.url().endsWith(`/events/${targetEventId}/award`) && r.request().method() === 'POST');
    await button.click(); await dialog;
    const r = await response; expect(r.status(), await r.text()).toBe(201);
  };
  await awardThrough(groupA.getByRole('button', { name: /Browser audit s2/ }), 'Best current formal evaluation');
  await expect(groupA.locator('.badge.AWARDED')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Score', exact: true })).toHaveCount(0);
  await expect(quality).toHaveCount(0); // server locks re-evaluation after any active award
  await expect(groupB.getByRole('button', { name: /Browser audit s1/ })).toBeEnabled();
  const aiCard = page.locator('.card').filter({ has: page.getByRole('heading', { name: /AI recommendation/ }) });
  await page.getByRole('combobox', { name: 'Lots', exact: true }).selectOption(lotB.id);
  await aiCard.getByRole('button', { name: 'Analyze', exact: true }).click();
  const aiRow = aiCard.locator('tr').filter({ hasText: 'Browser audit s1' });
  await expect(aiRow.getByRole('button', { name: 'Award winner', exact: true })).toBeVisible();
  // Choose the non-top bid on the second lot with the required written justification.
  await awardThrough(aiRow.getByRole('button', { name: 'Award winner', exact: true }), 'Distinct delivery requirement for lot B');
  await expect(groupB.locator('.badge.AWARDED')).toBeVisible();
  const detail = await call(`/events/${event.id}`, undefined, buyer.accessToken, 'get', 200);
  expect(detail.awards.filter((a: any) => !a.cancelled_at).map((a: any) => [a.lot_id, a.winning_bid_id, a.evaluation_id])).toEqual(expect.arrayContaining([
    [lotA.id, bids[1].id, currentEvaluation.evaluation_id], [lotB.id, bids[0].id, currentEvaluation.evaluation_id],
  ]));
  for (const name of ['s1', 's2']) {
    await expect(page.locator('tr').filter({ hasText: `Browser audit ${name}` }).locator('td').filter({ hasText: '🏆' })).toHaveCount(1);
  }
  await expect(page.getByRole('button', { name: /^Create contract ·/ })).toHaveCount(2);
  for (const [lot, supplier, total, itemName] of [[lotA, s2, 9500, 'Item A'], [lotB, s1, 15000, 'Item B']] as const) {
    await page.goto(`/buyer/events/${event.id}`);
    const response = page.waitForResponse(r => r.url().includes('/contracts/from-award/') && r.request().method() === 'POST');
    await page.getByRole('button', { name: `Create contract · ${lot.title}`, exact: true }).click();
    const r = await response; expect(r.status(), await r.text()).toBe(201);
    const contract = await r.json();
    await page.waitForURL('**/buyer/contracts');
    expect(contract.supplier_org_id).toBe(supplier.org.id); expect(Number(contract.total_minor)).toBe(total);
    const po = await call(`/contracts/${contract.id}/orders`, {}, buyer.accessToken);
    expect(po.items.map((i: any) => i.name)).toEqual([itemName]);
    expect(Number(po.total_minor)).toBe(total);
  }
  // The same UI change must preserve reverse-auction price ranking (LP-A04/A05).
  const auctionReq = await call('/requests', { title: `Browser auction ${tag}`, vatMode: 'INCLUSIVE', items: [{ name: 'Auction item', qty: 10, estUnitPriceMinor: 10000 }] }, buyer.accessToken);
  await call(`/requests/${auctionReq.id}/submit`, {}, buyer.accessToken);
  await call(`/requests/${auctionReq.id}/approve`, {}, approver.accessToken);
  const auctionCreated = await call(`/events/reverse/from-request/${auctionReq.id}`, { closeAt: new Date(Date.now() + 3600000).toISOString(), visibility: 'PUBLIC', startPriceMinor: 100000, minDecrementMinor: 1000 }, buyer.accessToken);
  const auction = await call(`/events/${auctionCreated.id}/publish`, {}, buyer.accessToken);
  for (const [supplier, price] of [[s1, 9000], [s2, 8000]] as const) {
    await call(`/events/${auction.id}/auction/bids`, { items: [{ eventItemId: auction.items[0].id, unitPriceMinor: price }] }, supplier.accessToken);
  }
  const clock = new Client({ connectionString: process.env.DATABASE_OWNER_URL });
  await clock.connect();
  try {
    await clock.query(`UPDATE sourcing_events SET close_at=now()-interval '1 second' WHERE id=$1`, [auction.id]);
    await clock.query(`SELECT * FROM close_due_events()`);
  } finally { await clock.end(); }
  await page.goto(`/buyer/events/${auction.id}`);
  const finalized = page.waitForResponse(r => r.url().endsWith(`/events/${auction.id}/auction/finalize`) && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Finalize', exact: true }).click();
  expect((await finalized).status()).toBe(201);
  const auctionLot = page.getByRole('group', { name: auction.lots[0].title, exact: true });
  await expect(auctionLot.getByRole('button').first()).toHaveText(/Browser audit s2.*⭐/);
  await expect(auctionLot.getByRole('button').first()).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Score', exact: true })).toHaveCount(0);
  await awardThrough(auctionLot.getByRole('button', { name: /Browser audit s2/ }), 'Best accepted auction price', auction.id);
  const auctionContractResponse = page.waitForResponse(r => r.url().includes('/contracts/from-award/') && r.request().method() === 'POST');
  await page.getByRole('button', { name: `Create contract · ${auction.lots[0].title}`, exact: true }).click();
  const auctionContract = await (await auctionContractResponse).json();
  await page.waitForURL('**/buyer/contracts');
  expect(auctionContract.supplier_org_id).toBe(s2.org.id);
  expect(Number(auctionContract.total_minor)).toBe(80000);
  const auctionPo = await call(`/contracts/${auctionContract.id}/orders`, {}, buyer.accessToken);
  expect(auctionPo.items).toHaveLength(1);
  expect(Number(auctionPo.items[0].unit_price_minor)).toBe(8000);
  expect(Number(auctionPo.total_minor)).toBe(80000);
  await call(`/orders/${auctionPo.id}/status`, { status: 'ISSUED' }, buyer.accessToken);
  for (const status of ['CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED']) {
    await call(`/orders/${auctionPo.id}/status`, { status }, s2.accessToken);
  }
  await call(`/orders/${auctionPo.id}/receipts`, { items: [{ poItemId: auctionPo.items[0].id, qty: 10 }] }, buyer.accessToken);
  const auctionInvoice = await call(`/invoices/from-po/${auctionPo.id}`, { items: [{ poItemId: auctionPo.items[0].id, qty: 10, unitPriceMinor: 8000 }] }, s2.accessToken);
  expect(auctionInvoice.status).toBe('MATCHED');
  expect(Number(auctionInvoice.gross_minor)).toBe(80000);

});

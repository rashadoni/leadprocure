import { test, expect, type Locator } from '@playwright/test';
import { createRequire } from 'node:module';
import { verifyRfiRfp } from './helpers/rfx';
import { answerDialog } from './helpers/dialogs';
const apiRequire = createRequire(new URL('../../api/package.json', import.meta.url));

// Real fixtures/API/auth/RLS. Keep one browser login for the entire scenario:
// the production login limiter remains enabled in acceptance.
test('current formal ranking and each lot survive re-evaluation and partial awards', async ({ page, request, browser }) => {
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
  await page.addInitScript(() => {
    // Set the initial language only: later native language selections must survive
    // full-page contract navigation and supplier/buyer reloads in the RFP flow.
    if (!localStorage.getItem('lp_lang')) localStorage.setItem('lp_lang', 'en');
  });
  await page.goto('/login'); await page.fill('input[type=email]', `buyer-${tag}@audit.invalid`); await page.fill('input[type=password]', password);
  await page.click('form button.btn:not(.ghost):not([type=button])'); await page.waitForURL(/\/buyer\//);
  await page.goto(`/buyer/events/${event.id}`);
  // The card used to name almost nothing it showed. The procedure is the chip the tender
  // LIST draws, out of the same component; the three facts under the title each carry their
  // own label (it read «Deadline: 8/12/2026 · INVITED · AZN» — a date and two nameless
  // values, one of them a word straight out of the database); and OCDS is written out in
  // the open, not only inside a hover bubble.
  // This tender was announced with visibility PUBLIC two dozen lines up, so it is an OPEN
  // tender — and the chip said «🔒 RFQ», sealed and by invitation. The assertion was
  // pinning the wrong label.
  await expect(page.locator('h1 .chip')).toHaveText(/🌐\s*Open tender/);
  const facts = page.locator('.fact');
  await expect(facts).toHaveCount(3);
  await expect(facts.filter({ hasText: 'Visibility' })).toHaveText(/Open/);
  await expect(facts.filter({ hasText: 'Evaluation currency' })).toHaveText(/AZN/);
  await expect(page.getByText(/^OCDS is the open international standard/)).toBeVisible();
  // A noun over the column and a verb on the button, out of the ONE key that used to do
  // both jobs — the heading read «Score!» — and the figure says out of what.
  // A PREFIX, not an exact name: `[data-tip]::after { content: attr(data-tip) }` puts the
  // tooltip into the accessible name, and Playwright reads pseudo-content (opacity:0 does
  // not hide it from the name). helpers/rfx.ts builds the same shape for the same reason.
  await expect(page.getByRole('columnheader', { name: /^Score \/ 100(?:\s|$)/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Score', exact: true })).toBeVisible();
  // Q&A: the field and the button no longer carry one and the same word.
  await expect(page.getByLabel('Clarification', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^📢 Publish(?:\s|$)/ })).toBeVisible();
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
  // The justification is a field in the product's own dialog now, not a browser prompt.
  const awardThrough = async (button: Locator, reason: string, targetEventId = event.id) => {
    const response = page.waitForResponse(r => r.url().endsWith(`/events/${targetEventId}/award`) && r.request().method() === 'POST');
    await button.click();
    await answerDialog(page, reason);
    const r = await response; expect(r.status(), await r.text()).toBe(201);
  };
  await awardThrough(groupA.getByRole('button', { name: /Browser audit s2/ }), 'Best current formal evaluation');
  await expect(groupA.locator('.badge.AWARDED')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Score', exact: true })).toHaveCount(0);
  await expect(quality).toHaveCount(0); // server locks re-evaluation after any active award
  await expect(groupB.getByRole('button', { name: /Browser audit s1/ })).toBeEnabled();
  const aiCard = page.locator('.card').filter({ has: page.getByRole('heading', { name: /AI recommendation/ }) });
  await page.getByRole('combobox', { name: 'Lots', exact: true }).selectOption(lotB.id);
  await aiCard.getByRole('button', { name: /^Analyze\b/ }).click();
  const aiRow = aiCard.locator('tr').filter({ hasText: 'Browser audit s1' });
  await expect(aiRow.getByRole('button', { name: /^Award winner\b/ })).toBeVisible();
  // Choose the non-top bid on the second lot with the required written justification.
  await awardThrough(aiRow.getByRole('button', { name: /^Award winner\b/ }), 'Distinct delivery requirement for lot B');
  await expect(groupB.locator('.badge.AWARDED')).toBeVisible();
  const detail = await call(`/events/${event.id}`, undefined, buyer.accessToken, 'get', 200);
  expect(detail.awards.filter((a: any) => !a.cancelled_at).map((a: any) => [a.lot_id, a.winning_bid_id, a.evaluation_id])).toEqual(expect.arrayContaining([
    [lotA.id, bids[1].id, currentEvaluation.evaluation_id], [lotB.id, bids[0].id, currentEvaluation.evaluation_id],
  ]));
  for (const name of ['s1', 's2']) {
    const row = page.locator('tr').filter({ hasText: `Browser audit ${name}` });
    await expect(row.locator('td').filter({ hasText: '🏆' })).toHaveCount(1);
    // In WORDS. A trophy next to the company name and a green outline on the row were the
    // only two marks, and the column they sit in is named after the supplier.
    await expect(row.locator('.badge.AWARDED')).toHaveText(/🏆\s*Winner/);
  }
  // Evidence that the card was looked at and not merely built: four screens were redesigned
  // in this audit before anybody had seen one, and a clipped month field on the analytics
  // page was found in a picture like this one, never in the code.
  await page.screenshot({ path: 'test-results/event-card.png', fullPage: true });
  await expect(page.getByRole('button', { name: /^Create contract ·/ })).toHaveCount(2);
  for (const [lot, supplier, total, itemName] of [[lotA, s2, 9500, 'Item A'], [lotB, s1, 15000, 'Item B']] as const) {
    await page.goto(`/buyer/events/${event.id}`);
    const response = page.waitForResponse(r => r.url().includes('/contracts/from-award/') && r.request().method() === 'POST');
    await page.getByRole('button', { name: `Create contract · ${lot.title}` }).click();
    const r = await response; expect(r.status(), await r.text()).toBe(201);
    const contract = await r.json();
    await page.waitForURL('**/buyer/contracts');
    // The OTHER half of the rule the smoke checks for a supplier: this contract was just
    // activated, so there IS something to press and the column is drawn. Without this
    // direction, hiding it unconditionally would keep both suites green.
    expect(await page.getByRole('columnheader', { name: 'Actions', exact: true }).count()).toBeGreaterThan(0);
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
  // Said the way the list says it. The card used to print the `type` column, so a SEALED
  // tender switched to live bidding would have called itself an RFQ with the auction panel
  // running underneath it; the chip reads `format` too.
  await expect(page.locator('h1 .chip')).toHaveText(/⚡\s*Auction/);
  const finalized = page.waitForResponse(r => r.url().endsWith(`/events/${auction.id}/auction/finalize`) && r.request().method() === 'POST');
  await page.getByRole('button', { name: /^Finalize\b/ }).click();
  expect((await finalized).status()).toBe(201);
  const auctionLot = page.getByRole('group', { name: auction.lots[0].title, exact: true });
  await expect(auctionLot.getByRole('button').first()).toHaveText(/Browser audit s2.*⭐/);
  await expect(auctionLot.getByRole('button').first()).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Score', exact: true })).toHaveCount(0);
  // Nothing is ever scored or disqualified in an auction, so the actions column — which
  // stood empty but took its width in every state but one — is not drawn at all. One lot,
  // so the lot picker that used to float between the cards is not drawn either.
  await expect(page.getByRole('columnheader', { name: 'Actions', exact: true })).toHaveCount(0);
  // Nor the score column: an auction has no criteria, so every row showed «—» under a
  // heading that promised a scale out of 100.
  await expect(page.getByRole('columnheader', { name: /^Score \/ 100(?:\s|$)/ })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Lots', exact: true })).toHaveCount(0);
  await awardThrough(auctionLot.getByRole('button', { name: /Browser audit s2/ }), 'Best accepted auction price', auction.id);
  const auctionContractResponse = page.waitForResponse(r => r.url().includes('/contracts/from-award/') && r.request().method() === 'POST');
  await page.getByRole('button', { name: `Create contract · ${auction.lots[0].title}` }).click();
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

  await verifyRfiRfp({ browser, buyerPage: page, call, buyerToken: buyer.accessToken, approverToken: approver.accessToken, foreignSupplierToken: s1.accessToken, tag });

});

import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
const apiRequire = createRequire(new URL('../../api/package.json', import.meta.url));

// A budget warning is addressed to ONE person — the department's owner — and
// `NotifyEmailer.fanOut` mails only ACTIVE users. Given a userId that filter does not widen
// back out to the organisation: it empties the recipient list. So naming somebody who has
// been switched off does not send the alarm to more people, it sends it to nobody, while
// the owner column goes on showing a name and reads as settled.
//
// This cannot be asserted on the ordinary browser stand, where every seeded member is
// active — which is exactly why it survived two reviews. The stand is built here instead,
// and the switch-off is done in SQL because the product has no screen for it: the state
// arrives through an admin tool or a departure script, and it is the state the picker has
// to answer for either way.
test('a switched-off department owner is never offered, never silently dropped, and says so', async ({ page, request }) => {
  apiRequire('../../scripts/acceptance/assert-isolated.cjs')();
  const base = 'http://localhost:3000', tag = Date.now().toString(36), password = 'Fixture-password123';
  const call = async (path: string, body: any, token?: string, method = 'post') => {
    const r = await request.fetch(base + path, { method, data: body, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    expect(r.ok(), await r.text()).toBe(true); return r.json();
  };

  // Its own organisation, so nothing here depends on, or disturbs, the seeded stand.
  const adminEmail = `dep-owner-admin-${tag}@audit.invalid`;
  const buyer = await call('/auth/register/buyer',
    { legalName: `Dept owner ${tag}`, fullName: 'Owning Admin', email: adminEmail, password });
  const leaverEmail = `dep-owner-leaver-${tag}@audit.invalid`;
  await call('/settings/users',
    { email: leaverEmail, fullName: 'Leaving Head', password, role: 'BUYER_APPROVER' }, buyer.accessToken);
  const members = await call('/settings/users', undefined, buyer.accessToken, 'get');
  const leaver = members.find((u: { email: string }) => u.email === leaverEmail);
  expect(leaver, 'the new member is missing from /settings/users').toBeTruthy();
  const code = `OWNED-${tag}`.toUpperCase();
  await call('/departments', { code, name: 'Has an owner', ownerUserId: leaver.id }, buyer.accessToken);

  await page.addInitScript(() => localStorage.setItem('lp_lang', 'en'));
  const login = await page.request.post(base + '/auth/login', { data: { email: adminEmail, password } });
  expect(login.ok(), await login.text()).toBe(true);

  const newOwner = () => page.getByTestId('dep-new-owner');
  const row = () => page.locator('tr').filter({ has: page.locator(`td:text-is("${code}")`) });
  const rowOwner = () => row().getByTestId('dep-owner').locator('select');
  const open = async () => {
    await page.goto('/buyer/settings');
    await expect(newOwner()).toBeVisible({ timeout: 20_000 });
    await expect(row()).toBeVisible();
  };

  // While they are an ordinary member: offered like anybody else, and named on their row.
  await open();
  await expect(newOwner().locator('option', { hasText: 'Leaving Head' })).toHaveCount(1);
  await expect(rowOwner()).toHaveValue(leaver.id);
  await expect(rowOwner().locator('option:checked')).toHaveText('Leaving Head');

  const { Client } = apiRequire('pg');
  const db = new Client({ connectionString: process.env.DATABASE_OWNER_URL });
  await db.connect();
  try {
    await db.query(`UPDATE organization_users SET status = 'DISABLED' WHERE id = $1`, [leaver.id]);
  } finally { await db.end(); }

  await open();
  // 1. Not offered any more — neither for a new department nor for one that has none. The
  //    alarm cannot reach this person, so the screen must not present them as a recipient.
  await expect(newOwner().locator('option', { hasText: 'Leaving Head' }),
    'somebody the budget warning cannot reach is still offered as its recipient').toHaveCount(0);
  // 2. And yet still shown as the owner of the department that already named them. Drop the
  //    option and the select falls back to its first one, so a department that HAS an owner
  //    reads «No owner» — a wrong reading in the other direction, and the natural fix for it
  //    (pick somebody) changes who gets told without anyone seeing that it had been pointed
  //    at a switched-off person all along.
  await expect(rowOwner(), 'the owner this department already has was dropped from the list')
    .toHaveValue(leaver.id);
  // 3. Said in words, because a name alone looks like a live recipient.
  await expect(rowOwner().locator('option:checked')).toHaveText('Leaving Head (deactivated)');

  // 4. An unrelated edit of that row must not take the owner with it. `PUT /departments/:id`
  //    replaces the whole row and reads an omitted field as «cleared», so the retire button
  //    sends every other field back as it stands — including an owner who is no longer in
  //    the list of people this screen offers.
  // «Archive», not «Retire»: the button's own text is `⏸ dep_retire`, and `dep_deactivate`
  // («Retire») is its tooltip. The two are different keys and only one is the accessible name.
  await row().getByRole('button', { name: /Archive/ }).click();
  await expect(row().locator('.badge')).toHaveText('Retired');
  await expect(rowOwner(), 'retiring the department cleared its owner').toHaveValue(leaver.id);
  await expect(rowOwner().locator('option:checked')).toHaveText('Leaving Head (deactivated)');
});

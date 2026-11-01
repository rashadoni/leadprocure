import { expect, test, type Locator, type Page } from '@playwright/test';
import { cancelDialog, expectToast } from './dialogs';

type Call = (path: string, body: any, token?: string, method?: string, status?: number) => Promise<any>;
const controlName = (label: string) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);

// A controlled frontend transport failure, not a simulated server transaction rollback.
// Real authenticated GETs establish that the stored invoice remains unchanged.
export async function verifyInvoiceMutationFailure({ page, row, heading, call, buyerToken, id, action, status, click }: {
  page: Page; row: Locator; heading: Locator; call: Call; buyerToken: string; id: string;
  action: 'approve' | 'pay' | 'reject'; status: 'MATCHED' | 'APPROVED' | 'DISPUTED'; click: () => Promise<void>;
}) {
  await test.step(`invoice ${action} failure preserves ${status} in row, open card and storage`, async () => {
    const path = `/invoices/${id}/${action}`, pattern = `**${path}`;
    const before = await call(`/invoices/${id}`, undefined, buyerToken, 'get', 200);
    expect(before.status).toBe(status);
    const rowBadge = await row.locator('.badge').textContent();
    const cardBadge = await heading.locator('.badge').textContent();
    expect(rowBadge).toBeTruthy(); expect(cardBadge).toBeTruthy();
    const message = `Controlled invoice ${action} failure`;
    const fail = async (route: import('@playwright/test').Route) => {
      expect(route.request().method()).toBe('POST');
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message }) });
    };
    await page.route(pattern, fail);
    try {
      const failed = page.waitForResponse(r => new URL(r.url()).pathname === path && r.request().method() === 'POST');
      await click(); expect((await failed).status()).toBe(503);
      await expectToast(page, message);
      await expect(row.locator('.badge')).toHaveText(rowBadge!);
      await expect(heading.locator('.badge')).toHaveText(cardBadge!);
      const after = await call(`/invoices/${id}`, undefined, buyerToken, 'get', 200);
      for (const key of ['status', 'net_minor', 'vat_minor', 'gross_minor', 'match']) expect(after[key]).toEqual(before[key]);
    } finally { await page.unroute(pattern, fail); }
  });
}

// The supplier API creates an intentionally disputed fixture (overpriced and already
// allocated quantity). Buyer cancellation and rejection are actual native UI actions.
export async function verifyInvoiceCancellationAndRejection({ page, supplierPage, call, buyerToken, supplierToken, poId, poNo, poItemId }: {
  page: Page; supplierPage: Page; call: Call; buyerToken: string; supplierToken: string;
  poId: string; poNo: string; poItemId: string;
}) {
  await test.step('disputed invoice: cancel override in AZ/RU/EN, reject failure, then actual rejection', async () => {
    const invoice = await call(`/invoices/from-po/${poId}`, { items: [{ poItemId, qty: 1, unitPriceMinor: 201 }] }, supplierToken);
    expect(invoice.status).toBe('DISPUTED'); expect(invoice.match.ok).toBe(false);
    expect(Number(invoice.gross_minor)).toBe(201);
    await page.goto('/buyer/invoices');
    const row = page.locator('tr').filter({ has: page.getByRole('link', { name: invoice.invoice_no, exact: true }) })
      .filter({ has: page.getByRole('cell', { name: poNo, exact: true }) });
    await row.getByRole('link', { name: invoice.invoice_no, exact: true }).click();
    const heading = page.getByRole('heading', { level: 3 }).filter({ hasText: invoice.invoice_no });
    const path = `/invoices/${invoice.id}/approve`, pattern = `**${path}`;
    let unexpectedApprovals = 0;
    const forbid = async (route: import('@playwright/test').Route) => {
      unexpectedApprovals++;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Unexpected cancelled approval' }) });
    };
    await page.route(pattern, forbid);
    try {
      for (const [lang, approve, prompt, disputed] of [
        ['AZ', 'Təsdiqlə', 'Qaimə 3 tərəfli uyğunluqdan keçmədi. Təsdiq üçün əsaslandırma yazın:', 'Qaimədə uyğunsuzluq'],
        ['RU', 'Утвердить', 'Счёт не прошёл 3-стороннюю сверку. Укажите обоснование для одобрения:', 'Расхождение в счёте'],
        ['EN', 'Approve', 'Invoice failed the 3-way match. Enter a justification to approve it:', 'Invoice discrepancy'],
      ]) {
        await page.locator('.lang').getByRole('button', { name: lang, exact: true }).click();
        await row.getByRole('button', { name: controlName(approve) }).click();
        // The reason is required: with nothing typed the confirm button is dead AND the
        // dialog says why — the native prompt simply took the empty string.
        await expect(page.getByTestId('dialog-confirm')).toBeDisabled();
        await expect(page.getByRole('dialog').locator('.error')).toBeVisible();
        // Backing out must send nothing — the native prompt's Cancel did the same, and that
        // is the behaviour under test.
        await cancelDialog(page, prompt);
        // Flush the cancelled handler's promise before checking that it made no request.
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
        expect(unexpectedApprovals).toBe(0);
        await expect(row.locator('.badge')).toContainText(disputed);
        await expect(heading.locator('.badge')).toContainText(disputed);
        const unchanged = await call(`/invoices/${invoice.id}`, undefined, buyerToken, 'get', 200);
        expect(unchanged.status).toBe('DISPUTED'); expect(Number(unchanged.gross_minor)).toBe(201);
      }
    } finally { await page.unroute(pattern, forbid); }
    await verifyInvoiceMutationFailure({ page, row, heading, call, buyerToken, id: invoice.id,
      action: 'reject', status: 'DISPUTED', click: () => row.getByRole('button', { name: controlName('Reject') }).click() });
    const rejected = page.waitForResponse(r => r.url().endsWith(`/invoices/${invoice.id}/reject`) && r.request().method() === 'POST');
    await row.getByRole('button', { name: controlName('Reject') }).click();
    expect((await rejected).status()).toBe(201);
    await expect(row.locator('.badge')).toContainText('Rejected');
    await expect(heading.locator('.badge')).toContainText('Rejected');
    for (const label of ['Approve', 'Reject', '💳 Pay']) await expect(row.getByRole('button', { name: controlName(label) })).toHaveCount(0);
    expect((await call(`/invoices/${invoice.id}`, undefined, buyerToken, 'get', 200)).status).toBe('REJECTED');
    await page.reload(); await expect(row.locator('.badge')).toContainText('Rejected');
    await supplierPage.goto('/supplier/invoices');
    const supplied = supplierPage.locator('tr').filter({ has: supplierPage.getByRole('link', { name: invoice.invoice_no, exact: true }) })
      .filter({ has: supplierPage.getByRole('cell', { name: poNo, exact: true }) });
    await expect(supplied.locator('.badge')).toContainText('Rejected');
  });
}

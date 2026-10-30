import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

const renderFinished = (page: Page) => page.evaluate(() => new Promise<void>(resolve =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

// Hold an actual authorized API response, rather than manufacture an old status.
// The browser's requestfinished event and rendering frames drain the released read.
async function holdDetail({ page, id, status, run }: {
  page: Page; id: string; status: string;
  run: (held: () => number, release: () => Promise<void>, requests: () => number) => Promise<void>;
}) {
  const path = `/invoices/${id}`, pattern = `**${path}`;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let held = 0, finished = 0, requests = 0;
  const handlers: Promise<void>[] = [];
  const onFinished = (request: any) => {
    if (new URL(request.url()).pathname === path && request.method() === 'GET') finished++;
  };
  const barrier = (route: Route) => {
    // A conflicted read is refreshed after confirmation; only the original
    // snapshot is delayed. Subsequent reads must reach the actual server.
    if (++requests > 1) return route.continue();
    const task = (async () => {
      expect(route.request().method()).toBe('GET');
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      expect((await response.json()).status).toBe(status);
      held++;
      await gate;
      await route.fulfill({ response });
    })();
    handlers.push(task); return task;
  };
  page.on('requestfinished', onFinished);
  await page.route(pattern, barrier);
  try {
    await run(() => held, async () => {
      release(); await Promise.all(handlers);
      await expect.poll(() => finished).toBeGreaterThanOrEqual(handlers.length);
      await renderFinished(page);
    }, () => requests);
  } finally {
    release(); await Promise.allSettled(handlers);
    await page.unroute(pattern, barrier); page.off('requestfinished', onFinished);
  }
}

async function verifyInvoiceDetailAcrossMutation({ page, row, heading, id, from, to, mutate }: {
  page: Page; row: Locator; heading: Locator; id: string; from: string; to: string; mutate: () => Promise<any>;
}) {
  await test.step(`late ${from} invoice detail cannot undo confirmed ${to}`, async () => {
    const link = row.getByRole('link');
    await link.click(); await expect(heading).toHaveCount(0);
    await holdDetail({ page, id, status: from, run: async (held, release) => {
      await link.click(); await expect.poll(held).toBe(1);
      await mutate(); await expect(row.locator(`.badge.${to}`)).toBeVisible();
      await expect(heading).toHaveCount(0); // detail is still in flight
      await release();
      await expect(heading.locator(`.badge.${to}`)).toBeVisible();
      await expect(heading.locator(`.badge.${from}`)).toHaveCount(0);
    } });
  });
}

async function verifyInvoiceDetailCloseAndRetry({ page, row, heading, id, error }: {
  page: Page; row: Locator; heading: Locator; id: string; error: string;
}) {
  const link = row.getByRole('link');
  await test.step('closing a pending invoice detail prevents its late response reopening the card', async () => {
    await link.click(); await expect(heading).toHaveCount(0);
    await holdDetail({ page, id, status: 'PAID', run: async (held, release, requests) => {
      await link.click(); await expect.poll(held).toBe(1);
      await link.click(); // cancel the pending open, without starting a second GET
      await release();
      expect(held()).toBe(1); expect(requests()).toBe(1);
      await expect(heading).toHaveCount(0);
    } });
  });
  await test.step('failed invoice detail shows the selected language and permits a real retry', async () => {
    const path = `/invoices/${id}`, pattern = `**${path}`;
    const fail = (route: Route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    await page.route(pattern, fail);
    try {
      const alert = page.waitForEvent('dialog').then(async d => {
        try { expect(d.type()).toBe('alert'); expect(d.message()).toBe(error); } finally { await d.accept(); }
      });
      const failed = page.waitForResponse(r => new URL(r.url()).pathname === path && r.request().method() === 'GET');
      await Promise.all([link.click(), alert]); expect((await failed).status()).toBe(503);
      await expect(heading).toHaveCount(0);
    } finally { await page.unroute(pattern, fail); }
    await link.click(); await expect(heading.locator('.badge.PAID')).toBeVisible();
  });
}


type Call = (path: string, body: any, token?: string, method?: string, status?: number) => Promise<any>;
const controlName = (label: string) => new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`);

// Separate real API fixture so every existing native RFP positive/negative chain
// remains unchanged. The partial-order setup already approved this supplier and
// configured DIRECT purchasing; no extra login or SPA session injection.
export async function verifyInvoiceDetailConcurrency({ page, supplierPage, call, buyerToken, approverToken, supplierToken, supplierOrgId, tag }: {
  page: Page; supplierPage: Page; call: Call; buyerToken: string; approverToken: string;
  supplierToken: string; supplierOrgId: string; tag: string;
}) {
  await test.step('invoice detail read races and load retry on a separate real fixture', async () => {
    const req = await call('/requests', {title:`Invoice detail race ${tag}`,items:[{name:'Race item',qty:2,estUnitPriceMinor:1200}]}, buyerToken);
    await call(`/requests/${req.id}/submit`,{},buyerToken);
    await call(`/requests/${req.id}/approve`,{},approverToken);
    const po=await call(`/orders/direct/from-request/${req.id}`,{supplierOrgId},buyerToken);
    await call(`/orders/${po.id}/status`,{status:'ISSUED'},buyerToken);
    for (const status of ['CONFIRMED','PACKED','SHIPPED','DELIVERED']) await call(`/orders/${po.id}/status`,{status},supplierToken);
    await call(`/orders/${po.id}/receipts`,{items:[{poItemId:po.items[0].id,qty:2}]},buyerToken);
    const invoice=await call(`/invoices/from-po/${po.id}`,{items:[{poItemId:po.items[0].id,qty:1,unitPriceMinor:1200}]},supplierToken);
    expect(invoice.status).toBe('MATCHED');
    expect([invoice.net_minor,invoice.vat_minor,invoice.gross_minor].map(Number)).toEqual([1200,216,1416]);
    const newer=await call(`/invoices/from-po/${po.id}`,{items:[{poItemId:po.items[0].id,qty:1,unitPriceMinor:1200}]},supplierToken);
    expect(newer.status).toBe('MATCHED');
    await page.goto('/buyer/invoices');
    const row=page.locator('tr').filter({has:page.getByRole('link',{name:invoice.invoice_no,exact:true})})
      .filter({has:page.getByRole('cell',{name:po.po_no,exact:true})});
    await row.getByRole('link').click();
    const heading=page.getByRole('heading',{level:3}).filter({hasText:invoice.invoice_no});
    await expect(heading.locator('.badge.MATCHED')).toBeVisible();
    const mutate=async(action:string,label:string)=>{
      const pending=page.waitForResponse(r=>r.url().endsWith(`/invoices/${invoice.id}/${action}`)&&r.request().method()==='POST');
      const [response]=await Promise.all([pending,row.getByRole('button',{name:controlName(label)}).click()]);
      expect(response.status(),await response.text()).toBe(201);
    };
    await page.locator('.lang').getByRole('button',{name:'AZ',exact:true}).click();
    await verifyInvoiceDetailAcrossMutation({page,row,heading,id:invoice.id,from:'MATCHED',to:'APPROVED',mutate:()=>mutate('approve','Təsdiqlə')});
    await page.locator('.lang').getByRole('button',{name:'RU',exact:true}).click();
    await verifyInvoiceDetailAcrossMutation({page,row,heading,id:invoice.id,from:'APPROVED',to:'PAID',mutate:()=>mutate('pay','💳 Оплатить')});
    for (const [lang,error] of [
      ['AZ','Qaimənin təfərrüatlarını yükləmək mümkün olmadı. Yenidən yoxlayın.'],
      ['RU','Не удалось загрузить сведения счёта. Повторите попытку.'],
      ['EN','Could not load invoice details. Please try again.'],
    ]) {
      await page.locator('.lang').getByRole('button',{name:lang,exact:true}).click();
      await verifyInvoiceDetailCloseAndRetry({page,row,heading,id:invoice.id,error});
    }
    const settled=await call(`/invoices/${invoice.id}`,undefined,buyerToken,'get',200);
    expect(settled.status).toBe('PAID');
    expect([settled.net_minor,settled.vat_minor,settled.gross_minor].map(Number)).toEqual([1200,216,1416]);
    expect(settled.match.ok).toBe(true);
    await supplierPage.goto('/supplier/invoices');
    const supplied=supplierPage.locator('tr').filter({has:supplierPage.getByRole('link',{name:invoice.invoice_no,exact:true})})
      .filter({has:supplierPage.getByRole('cell',{name:po.po_no,exact:true})});
    await expect(supplied.locator('.badge.PAID')).toBeVisible();
    await verifyNewerServerDetail({page,call,buyerToken,invoice:newer,poNo:po.po_no});
  });
}

// A request can begin before approval but execute after another authenticated
// client's payment. Its PAID response must never be overlaid with local APPROVED.
async function verifyNewerServerDetail({ page, call, buyerToken, invoice, poNo }: {
  page: Page; call: Call; buyerToken: string; invoice: any; poNo: string;
}) {
  await test.step('newer PAID detail wins over local APPROVED and a late old list response', async () => {
    await page.goto('/buyer/invoices');
    await page.locator('.lang').getByRole('button', { name: 'EN', exact: true }).click();
    const row = page.locator('tr').filter({ has: page.getByRole('link', { name: invoice.invoice_no, exact: true }) })
      .filter({ has: page.getByRole('cell', { name: poNo, exact: true }) });
    await expect(row.locator('.badge.MATCHED')).toBeVisible();
    const heading = page.getByRole('heading', { level: 3 }).filter({ hasText: invoice.invoice_no });
    const detailPath = `/invoices/${invoice.id}`;
    let executeDetail!: () => void, releaseList!: () => void;
    const detailGate = new Promise<void>(resolve => { executeDetail = resolve; });
    const listGate = new Promise<void>(resolve => { releaseList = resolve; });
    let detailRequests = 0, capturedDetailStatus: string | undefined, heldList = false, listFinished = 0;
    let heldListRequest: import('@playwright/test').Request | undefined;
    const isList = (url: URL) => url.pathname === '/invoices';
    const handlers: Promise<void>[] = [];
    const onFinished = (request: any) => {
      if (request === heldListRequest) listFinished++;
    };
    const detailBarrier = (route: Route) => {
      if (++detailRequests > 1) return route.continue();
      const task = (async () => {
        await detailGate; // delay actual execution, not a previously fetched snapshot
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        capturedDetailStatus = (await response.json()).status;
        expect(capturedDetailStatus).toBe('PAID');
        await route.fulfill({ response });
      })();
      handlers.push(task); return task;
    };
    const listBarrier = (route: Route) => {
      const task = (async () => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        const rows = await response.json();
        if (!heldList && rows.find((r: any) => r.id === invoice.id)?.status === 'APPROVED') {
          heldList = true; heldListRequest = route.request(); await listGate;
        }
        await route.fulfill({ response });
      })();
      handlers.push(task); return task;
    };
    page.on('requestfinished', onFinished);
    await page.route(`**${detailPath}`, detailBarrier);
    await page.route(isList, listBarrier);
    try {
      await row.getByRole('link').click(); await expect.poll(() => detailRequests).toBe(1);
      const approved = page.waitForResponse(r => r.url().endsWith(`${detailPath}/approve`) && r.request().method() === 'POST');
      const [response] = await Promise.all([approved, row.getByRole('button', { name: controlName('Approve') }).click()]);
      expect(response.status(), await response.text()).toBe(201);
      await expect(row.locator('.badge.APPROVED')).toBeVisible();
      await expect.poll(() => heldList).toBe(true);
      // Existing registration-token API client is separate from the native login
      // context. This is a real authorized concurrent client, not SPA injection.
      await call(`${detailPath}/pay`, {}, buyerToken);
      expect((await call(detailPath, undefined, buyerToken, 'get', 200)).status).toBe('PAID');
      executeDetail();
      await expect(heading.locator('.badge.PAID')).toBeVisible();
      await expect(row.locator('.badge.PAID')).toBeVisible();
      expect(capturedDetailStatus).toBe('PAID');
      releaseList(); await Promise.all(handlers);
      await expect.poll(() => listFinished).toBeGreaterThanOrEqual(1);
      await renderFinished(page);
      await expect(heading.locator('.badge.PAID')).toBeVisible();
      await expect(heading.locator('.badge.APPROVED')).toHaveCount(0);
      await expect(row.locator('.badge.PAID')).toBeVisible();
      const stored = await call(detailPath, undefined, buyerToken, 'get', 200);
      expect(stored.status).toBe('PAID');
      expect([stored.net_minor, stored.vat_minor, stored.gross_minor].map(Number)).toEqual([1200, 216, 1416]);
    } finally {
      executeDetail(); releaseList(); await Promise.allSettled(handlers);
      await page.unroute(`**${detailPath}`, detailBarrier);
      await page.unroute(isList, listBarrier);
      page.off('requestfinished', onFinished);
    }
  });
}

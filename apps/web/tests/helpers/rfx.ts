import { expect, test, type Browser, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
const apiRequire = createRequire(new URL('../../../api/package.json', import.meta.url));

type Call = (path: string, body: any, token?: string, method?: string, status?: number) => Promise<any>;

// Reuse the buyer/approver from the actual procurement scenario. The supplier
// registers in its own browser context, retaining that context's real httpOnly cookie.
// No copied session/token injection or extra password-login requests.
export async function verifyRfiRfp({ browser, buyerPage, call, buyerToken, approverToken, foreignSupplierToken, tag }: {
  browser: Browser; buyerPage: Page; call: Call; buyerToken: string;
  approverToken: string; foreignSupplierToken: string; tag: string;
}) {
  apiRequire('../../scripts/acceptance/assert-isolated.cjs')();
  const context = await browser.newContext({ baseURL: process.env.BASE_URL ?? 'http://localhost:5173', viewport: { width: 1280, height: 900 } });
  try {
    const registration = await context.request.post('http://localhost:3000/auth/register/supplier', { data: {
      legalName: `Rfx browser supplier ${tag}`, fullName: 'Rfx supplier',
      email: `rfx-browser-${tag}@audit.invalid`, password: 'Rfx-fixture-password123',
    } });
    expect(registration.status(), await registration.text()).toBe(201);
    const supplierPage = await context.newPage();
    await supplierPage.goto('/supplier/dashboard');
    await expect(supplierPage.locator('h1')).toBeVisible();
    const cases = [
      { type: 'RFI', lang: 'az', label: 'Cavab (mətn)', submit: 'Göndər', received: 'Təklif qəbul edildi' },
      { type: 'RFP', lang: 'ru', label: 'Техническое предложение', submit: 'Подать ставку', received: 'Предложение принято' },
      { type: 'RFP', lang: 'en', label: 'Technical proposal', submit: 'Place bid', received: 'Submission received' },
    ];
    for (const scenario of cases) await test.step(`${scenario.type} supplier/buyer native flow in ${scenario.lang}`, async () => {
      const title = `Rfx ${scenario.type} ${scenario.lang} ${tag}`, itemName = `Rfx item ${scenario.lang}`;
      const req = await call('/requests', { title, items: [{ name: itemName, qty: 1, estUnitPriceMinor: 10000 }] }, buyerToken);
      await call(`/requests/${req.id}/submit`, {}, buyerToken);
      await call(`/requests/${req.id}/approve`, {}, approverToken);
      const event = await call(`/events/from-request/${req.id}`, { type: scenario.type, visibility: 'PUBLIC', closeAt: new Date(Date.now() + 3600000).toISOString() }, buyerToken);
      await call(`/events/${event.id}/publish`, {}, buyerToken);
      await supplierPage.evaluate(lang => localStorage.setItem('lp_lang', lang), scenario.lang);
      await supplierPage.goto(`/supplier/events/${event.id}`);
      const marker = `Confidential ${scenario.type} ${scenario.lang} ${tag}`;
      const text = `${marker}\nSecond paragraph ${scenario.lang}`;
      await supplierPage.getByRole('textbox', { name: scenario.label, exact: true }).fill(text);
      if (scenario.type === 'RFP') {
        await supplierPage.locator('tr').filter({ hasText: itemName }).getByRole('spinbutton').fill('12.00');
      } else {
        await expect(supplierPage.getByRole('spinbutton')).toHaveCount(0);
      }
      const sent = supplierPage.waitForResponse(r => r.url().endsWith(`/events/${event.id}/bid`) && r.request().method() === 'POST');
      await supplierPage.getByRole('button', { name: `🔒 ${scenario.submit}`, exact: true }).click();
      const result = await sent;
      expect(result.status(), await result.text()).toBe(201);
      await expect(supplierPage.getByText(new RegExp(`^${scenario.received} · sha256`))).toBeVisible();
      await supplierPage.reload();
      await expect(supplierPage.getByRole('note', { name: scenario.label, exact: true })).toHaveText(text);
      // Actual authorized responses, not just hidden UI elements: buyer and another
      // supplier cannot obtain sealed technical text before the opening ceremony.
      const sealed = await call(`/events/${event.id}`, undefined, buyerToken, 'get', 200);
      expect(JSON.stringify(sealed)).not.toContain(marker);
      expect(sealed.bids[0].total_minor).toBeNull();
      const other = await call(`/events/${event.id}`, undefined, foreignSupplierToken, 'get', 200);
      expect(other.my_bid).toBeNull(); expect(JSON.stringify(other)).not.toContain(marker);
      await buyerPage.goto(`/buyer/events/${event.id}`);
      await expect(buyerPage.getByRole('heading', { level: 1 })).toContainText(title);
      await expect(buyerPage.getByText(marker, { exact: false })).toHaveCount(0);
      const { Client } = apiRequire('pg'), clock = new Client({ connectionString: process.env.DATABASE_OWNER_URL });
      await clock.connect();
      try {
        await clock.query(`UPDATE sourcing_events SET close_at=now()-interval '1 second' WHERE id=$1`, [event.id]);
        await clock.query(`SELECT * FROM close_due_events()`);
      } finally { await clock.end(); }
      await buyerPage.reload();
      const openedResponse = buyerPage.waitForResponse(r => r.url().endsWith(`/events/${event.id}/open`) && r.request().method() === 'POST');
      await buyerPage.getByRole('button', { name: /^Open bids\b/ }).click();
      expect((await openedResponse).status()).toBe(201);
      await expect(buyerPage.getByText(`📝 ${text}`, { exact: true })).toBeVisible();
      const opened = await call(`/events/${event.id}`, undefined, buyerToken, 'get', 200);
      expect(opened.bids[0].proposal_text).toBe(text);
      if (scenario.type === 'RFI') {
        expect(opened.bids[0].total_minor).toBeNull();
        await expect(buyerPage.getByRole('button', { name: 'Score', exact: true })).toHaveCount(0);
        await expect(buyerPage.getByRole('button', { name: /^Award winner\b/ })).toHaveCount(0);
        await expect(buyerPage.getByRole('button', { name: /^Analyze\b/ })).toHaveCount(0);
        await call(`/events/${event.id}/award`, { lotId: event.lots[0].id, bidId: opened.bids[0].id }, buyerToken, 'post', 400);
      } else {
        expect(Number(opened.bids[0].total_minor)).toBe(1200);
        await expect(buyerPage.getByRole('button', { name: 'Score', exact: true })).toBeVisible();
      }
      if (scenario.type === 'RFP' && scenario.lang === 'en') {
        await verifyRfpPayment({buyerPage,supplierPage,call,buyerToken,event,opened});
      }
      await supplierPage.reload();
      await expect(supplierPage.getByRole('note', { name: scenario.label, exact: true })).toHaveText(text);
      const otherAfter = await call(`/events/${event.id}`, undefined, foreignSupplierToken, 'get', 200);
      expect(otherAfter.my_bid).toBeNull(); expect(JSON.stringify(otherAfter)).not.toContain(marker);
    });
  } finally { await context.close(); }
}

// Every downstream write is made by an authenticated native browser click.
// API calls below only assert resulting state/price; clock adjustment remains
// confined to the isolated deadline fixture above. PAID is an application status.
async function verifyRfpPayment({buyerPage,supplierPage,call,buyerToken,event,opened}: {
  buyerPage:Page; supplierPage:Page; call:Call; buyerToken:string; event:any; opened:any;
}) {
  await test.step('RFP native scoring → award → contract → PO → GRN → invoice → PAID',async()=>{
    const clicked = async (page:Page,path:string,action:()=>Promise<void>) => {
      const pending=page.waitForResponse(r=>r.url().endsWith(path)&&r.request().method()==='POST');
      await action(); const response=await pending;
      expect(response.status(),await response.text()).toBe(201); return response.json();
    };
    const bid=buyerPage.locator('tr').filter({hasText:opened.bids[0].supplier_name});
    for(const criterion of event.evaluation_criteria ?? opened.evaluation_criteria) {
      await bid.locator('label').filter({hasText:`${criterion.key} · ${criterion.weight}%`}).locator('input').fill('90');
    }
    await clicked(buyerPage,`/events/${event.id}/evaluate`,()=>buyerPage.getByRole('button',{name:'Score',exact:true}).click());
    const group=buyerPage.getByRole('group',{name:event.lots[0].title,exact:true});
    const decision=buyerPage.waitForEvent('dialog').then(async d=>{expect(d.type()).toBe('prompt');await d.accept('Sole RFP proposal meets the published requirements');});
    await clicked(buyerPage,`/events/${event.id}/award`,()=>group.getByRole('button',{name:new RegExp(opened.bids[0].supplier_name)}).click());
    await decision;
    await expect(group.locator('.badge.AWARDED')).toBeVisible();
    const award=(await call(`/events/${event.id}`,undefined,buyerToken,'get',200)).awards.find((a:any)=>!a.cancelled_at);
    const activation=buyerPage.waitForResponse(r=>/\/contracts\/[^/]+\/activate$/.test(r.url())&&r.request().method()==='POST');
    const contract=await clicked(buyerPage,`/contracts/from-award/${award.id}`,
      ()=>buyerPage.getByRole('button',{name:`Create contract · ${event.lots[0].title}`}).click());
    // The click immediately performs a full-page navigation after activation;
    // Chromium can discard its body, but status/URL remain available.
    const activated=await activation;expect(activated.status()).toBe(201);
    expect(activated.url()).toContain(`/contracts/${contract.id}/activate`);
    await buyerPage.waitForURL('**/buyer/contracts');
    expect(Number(contract.total_minor)).toBe(1200);
    const contractRow=buyerPage.locator('tr').filter({hasText:contract.contract_no});
    await expect(contractRow.locator('.badge.ACTIVE')).toBeVisible();
    const po=await clicked(buyerPage,`/contracts/${contract.id}/orders`,()=>contractRow.getByRole('button',{name:/^Create PO\b/}).click());
    expect(Number(po.total_minor)).toBe(1200);
    const order=buyerPage.locator('tr').filter({hasText:po.po_no});
    await clicked(buyerPage,`/orders/${po.id}/status`,()=>order.getByRole('button',{name:'Issue',exact:true}).click());
    await supplierPage.goto('/supplier/orders');
    const supplied=supplierPage.locator('tr').filter({hasText:po.po_no});
    for(const label of ['Confirm','Packed','Ship','Delivered']) {
      await clicked(supplierPage,`/orders/${po.id}/status`,()=>supplied.getByRole('button',{name:`→ ${label}`,exact:true}).click());
    }
    await buyerPage.reload();
    await clicked(buyerPage,`/orders/${po.id}/receipts`,()=>order.getByRole('button',{name:/^Receive\b/}).click());
    await expect(order.locator('.badge.ACCEPTED')).toBeVisible();
    const receipt=await call(`/orders/${po.id}/receipts`,undefined,buyerToken,'get',200);
    expect(receipt.summary).toHaveLength(1);expect(Number(receipt.summary[0].received)).toBe(1);
    await supplierPage.reload();
    const invoice=await clicked(supplierPage,`/invoices/from-po/${po.id}`,()=>supplied.getByRole('button',{name:'🧾 Invoice',exact:true}).click());
    await supplierPage.waitForURL('**/supplier/invoices');
    expect(invoice.status).toBe('MATCHED');
    expect([invoice.net_minor,invoice.vat_minor,invoice.gross_minor].map(Number)).toEqual([1200,216,1416]);
    await expect(supplierPage.locator('tr').filter({hasText:invoice.invoice_no}).locator('.badge.MATCHED')).toBeVisible();
    await buyerPage.goto('/buyer/invoices');
    const invoiced=buyerPage.locator('tr').filter({hasText:invoice.invoice_no});
    await clicked(buyerPage,`/invoices/${invoice.id}/approve`,()=>invoiced.getByRole('button',{name:/^Approve\b/}).click());
    await clicked(buyerPage,`/invoices/${invoice.id}/pay`,()=>invoiced.getByRole('button',{name:/^💳 Pay\b/}).click());
    await expect(invoiced.locator('.badge.PAID')).toBeVisible();
    const settled=await call(`/invoices/${invoice.id}`,undefined,buyerToken,'get',200);
    expect(settled.status).toBe('PAID');
    expect([settled.net_minor,settled.vat_minor,settled.gross_minor].map(Number)).toEqual([1200,216,1416]);
    expect(settled.match.ok).toBe(true);
    await buyerPage.reload();
    await expect(invoiced.locator('.badge.PAID')).toBeVisible();
    await invoiced.getByRole('link',{name:invoice.invoice_no,exact:true}).click();
    for(const [lang,match,price,net,vat] of [
      ['EN','Three-way match','Invoice price','Net amount','VAT'],
      ['RU','Трёхсторонняя сверка','Цена в счёте','Без НДС','НДС'],
      ['AZ','Üçtərəfli uyğunlaşdırma','Qaimə qiyməti','ƏDV-siz məbləğ','ƏDV'],
    ]) {
      await buyerPage.locator('.lang').getByRole('button',{name:lang,exact:true}).click();
      await expect(buyerPage.getByRole('heading',{name:`${match} ✅`,exact:true})).toBeVisible();
      await expect(buyerPage.getByRole('columnheader',{name:price,exact:true})).toBeVisible();
      await expect(buyerPage.locator('.hint').filter({hasText:net}).filter({hasText:vat})).toBeVisible();
    }
    await buyerPage.locator('.lang').getByRole('button',{name:'EN',exact:true}).click();
    await supplierPage.reload();
    await expect(supplierPage.locator('tr').filter({hasText:invoice.invoice_no}).locator('.badge.PAID')).toBeVisible();
    await expect(supplierPage.getByRole('button',{name:/Approve|Pay/})).toHaveCount(0);
    // Return to the proposal page so existing own-response/secrecy assertions
    // still run after the entire commercial chain has completed.
    await supplierPage.goto(`/supplier/events/${event.id}`);
  });
}

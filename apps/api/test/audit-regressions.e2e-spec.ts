import {writeFileSync} from 'fs';
import { addApprover } from './helpers';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { Client } from 'pg';
import { randomUUID, createHash } from 'crypto';
import { AppModule } from '../src/app.module';
import { taxTotals } from '../src/common/procurement/invariants';

describe('datasheet audit: files, financial boundaries and concurrency', () => {
  let app: INestApplication, db: Client;
  let buyer: any, supplier: any, other: any;
  let approver: string;
  const tag=randomUUID().slice(0,8);
  const http=()=>request(app.getHttpServer());
  const auth=(u:any)=>['Authorization',`Bearer ${u.accessToken}`] as [string,string];
  beforeAll(async()=>{
    const mod=await Test.createTestingModule({imports:[AppModule]}).compile();
    app=mod.createNestApplication();app.use(cookieParser());app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true}));await app.init();
    db=new Client({connectionString:process.env.DATABASE_OWNER_URL});await db.connect();
    const reg=async(kind:string,n:string)=>(await http().post(`/auth/register/${kind}`).send({legalName:`Audit ${tag} ${n}`,email:`${n}-${tag}@audit.test`,password:'password123',fullName:n}).expect(201)).body;
    buyer=await reg('buyer','buyer');other=await reg('buyer','other');supplier=await reg('supplier','supplier');
    approver=await addApprover(app,buyer.accessToken,tag);
  });
  afterAll(async()=>{if(db){await db.end();}if(app)await app.close();});
  // Fixtures are confined to the disposable test DB. Keeping rows until DB disposal preserves audit history.
  const po=async(qty=10,price=100,mode='EXCLUSIVE',vat=0,uom='pcs')=>{
    const user=(await db.query(`SELECT user_id FROM memberships WHERE org_id=$1 LIMIT 1`,[buyer.org.id])).rows[0].user_id;
    const p=(await db.query(`INSERT INTO purchase_orders(buyer_org_id,supplier_org_id,po_no,status,total_minor,currency,created_by,vat_mode)
      VALUES($1,$2,$3,'DELIVERED',$4,'AZN',$5,$6) RETURNING id`,[buyer.org.id,supplier.org.id,randomUUID(),qty*price,user,mode])).rows[0].id;
    const i=(await db.query(`INSERT INTO purchase_order_items(po_id,buyer_org_id,supplier_org_id,line_no,name,qty,uom,unit_price_minor,line_total_minor,vat_rate_bp)
      VALUES($1,$2,$3,1,'Audit item',$4,$8,$5,$6,$7) RETURNING id`,[p,buyer.org.id,supplier.org.id,qty,price,qty*price,vat,uom])).rows[0].id;
    return {p,i};
  };
  const event=async()=>{
    const req=(await http().post('/requests').set(...auth(buyer)).send({title:`Audit RFQ ${randomUUID()}`,items:[{name:'Item',qty:1,estUnitPriceMinor:100}]}).expect(201)).body;
    await http().post(`/requests/${req.id}/submit`).set(...auth(buyer)).expect(201);
    await http().post(`/requests/${req.id}/approve`).set('Authorization',`Bearer ${approver}`).expect(201);
    const e=(await http().post(`/events/from-request/${req.id}`).set(...auth(buyer)).send({closeAt:new Date(Date.now()+3600000).toISOString(),visibility:'PUBLIC'}).expect(201)).body;
    await http().post(`/events/${e.id}/publish`).set(...auth(buyer)).expect(201);return e;
  };
  it('rejects another organization upload grant and prevents overwrite after confirmation',async()=>{
    const content=Buffer.from('original-audit-document');const sha=createHash('sha256').update(content).digest('hex');
    const pre=(await http().post('/documents/presign').set(...auth(buyer)).send({filename:'audit.txt',mime:'text/plain'}).expect(201)).body;
    expect((await fetch(pre.uploadUrl,{method:'PUT',body:content,headers:{'Content-Type':'text/plain'}})).ok).toBe(true);
    const payload={storageKey:pre.storageKey,filename:'audit.txt',mime:'text/plain',sizeBytes:content.length,sha256:sha,entityType:'audit'};
    await http().post('/documents/confirm').set(...auth(other)).send(payload).expect(400);
    const doc=(await http().post('/documents/confirm').set(...auth(buyer)).send(payload).expect(201)).body;
    await http().post('/documents/confirm').set(...auth(buyer)).send(payload).expect(400);
    await fetch(pre.uploadUrl,{method:'PUT',body:'changed',headers:{'Content-Type':'text/plain'}});
    const download=(await http().get(`/documents/${doc.id}/download`).set(...auth(buyer)).expect(200)).body;
    expect(await (await fetch(download.url)).text()).toBe(content.toString());
    const foreign=(await http().get(`/documents/${doc.id}/download`).set(...auth(other)).expect(200)).body;
    expect(foreign.url).toBeNull();
    const forged=(await db.query(`INSERT INTO documents(owner_org_id,entity_type,storage_key,filename,mime,size_bytes,sha256,av_status,created_by)
      SELECT $1,'audit',$2,'legacy.txt','text/plain',1,'legacy','SKIPPED',user_id FROM memberships WHERE org_id=$1 LIMIT 1 RETURNING id`,[buyer.org.id,`${other.org.id}/known-foreign-object`])).rows[0];
    await http().get(`/documents/${forged.id}/download`).set(...auth(buyer)).expect(403);
  });
  it('rejects repeated invoice lines instead of silently matching 20 against 10',async()=>{
    const {p,i}=await po();await http().post(`/orders/${p}/receipts`).set(...auth(buyer)).send({items:[{poItemId:i,qty:10}]}).expect(201);
    await http().post(`/invoices/from-po/${p}`).set(...auth(supplier)).send({items:[{poItemId:i,qty:10,unitPriceMinor:100},{poItemId:i,qty:10,unitPriceMinor:100}]}).expect(400);
  });
  it('concurrent invoices cannot both match the same received quantity',async()=>{
    const {p,i}=await po();await http().post(`/orders/${p}/receipts`).set(...auth(buyer)).send({items:[{poItemId:i,qty:10}]}).expect(201);
    const send=()=>http().post(`/invoices/from-po/${p}`).set(...auth(supplier)).send({items:[{poItemId:i,qty:10,unitPriceMinor:100}]});
    const result=await Promise.all([send(),send()]);expect(result.map(r=>r.status)).toEqual([201,201]);
    expect(result.map(r=>r.body.status).sort()).toEqual(['DISPUTED','MATCHED']);
  });
  it('concurrent receipts cannot receive the same remaining quantity twice',async()=>{
    const {p,i}=await po();const send=()=>http().post(`/orders/${p}/receipts`).set(...auth(buyer)).send({items:[{poItemId:i,qty:10}]});
    const result=await Promise.all([send(),send()]);expect(result.map(r=>r.status).sort()).toEqual([201,400]);
    expect(Number((await db.query(`SELECT sum(qty_received) q FROM goods_receipt_items WHERE po_item_id=$1`,[i])).rows[0].q)).toBe(10);
  });
  // LP-A02/R01: do not infer overlap just from Promise.all. Observe each
  // authenticated HTTP transaction waiting on the exact production order lock.
  async function queuedOrderWrites(poId: string, writes: Array<() => Promise<any>>) {
    const pending: Array<Promise<any>> = [];
    let results: PromiseSettledResult<any>[] = [];
    await db.query('BEGIN');
    try {
      const pid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,84))', [poId]);
      for (const write of writes) {
        pending.push(write());
        const deadline = Date.now() + 10000;
        let observed = false;
        while (Date.now() < deadline) {
          await db.query('SELECT pg_stat_clear_snapshot()');
          const n = (await db.query(`SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE wait_event='advisory' AND $1=ANY(pg_blocking_pids(pid))`, [pid])).rows[0].n;
          if (n >= pending.length) { observed = true; break; }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(observed).toBe(true);
      }
    } finally { await db.query('ROLLBACK'); results = await Promise.allSettled(pending); }
    return results.map(r => { if (r.status === 'rejected') throw r.reason; return r.value; });
  }
  it('R01 two observed queued invoices reserve the same received quantity only once', async () => {
    const { p, i } = await po();
    await http().post(`/orders/${p}/receipts`).set(...auth(buyer)).send({ items: [{ poItemId:i,qty:10 }] }).expect(201);
    const invoice = () => http().post(`/invoices/from-po/${p}`).set(...auth(supplier))
      .send({ items: [{ poItemId:i,qty:10,unitPriceMinor:100 }] }).then(r => r);
    const responses = await queuedOrderWrites(p, [invoice, invoice]);
    expect(responses.map(r => r.status)).toEqual([201,201]);
    expect(responses.map(r => r.body.status).sort()).toEqual(['DISPUTED','MATCHED']);
    expect(Number((await db.query(`SELECT sum(ii.qty) AS qty FROM invoice_items ii JOIN invoices v ON v.id=ii.invoice_id
      WHERE ii.po_item_id=$1 AND v.status IN ('MATCHED','APPROVED','PAID')`, [i])).rows[0].qty)).toBe(10);
  });
  it('R01 two observed queued receipts cannot both consume the same remaining quantity', async () => {
    const { p, i } = await po();
    const receipt = () => http().post(`/orders/${p}/receipts`).set(...auth(buyer))
      .send({ items: [{ poItemId:i,qty:10 }] }).then(r => r);
    const responses = await queuedOrderWrites(p, [receipt, receipt]);
    expect(responses.map(r => r.status).sort()).toEqual([201,400]);
    expect(Number((await db.query('SELECT sum(qty_received) AS qty FROM goods_receipt_items WHERE po_item_id=$1', [i])).rows[0].qty)).toBe(10);
  });
  for (const first of ['invoice','receipt']) {
    it(`R01 ${first} queued first yields the same final matched invoice and accepted quantity`, async () => {
      const { p, i } = await po();
      const invoice = () => http().post(`/invoices/from-po/${p}`).set(...auth(supplier))
        .send({ items: [{ poItemId:i,qty:10,unitPriceMinor:100 }] }).then(r => r);
      const receipt = () => http().post(`/orders/${p}/receipts`).set(...auth(buyer))
        .send({ items: [{ poItemId:i,qty:10 }] }).then(r => r);
      const responses = await queuedOrderWrites(p, first === 'invoice' ? [invoice,receipt] : [receipt,invoice]);
      expect(responses.map(r => r.status)).toEqual([201,201]);
      const invoiceId = responses[first === 'invoice' ? 0 : 1].body.id;
      const final = (await http().get(`/invoices/${invoiceId}`).set(...auth(buyer)).expect(200)).body;
      expect(final.status).toBe('MATCHED');
      expect(Number((await db.query('SELECT sum(qty_received) AS qty FROM goods_receipt_items WHERE po_item_id=$1', [i])).rows[0].qty)).toBe(10);
      expect((await db.query('SELECT count(*)::int AS n FROM invoices WHERE po_id=$1', [p])).rows[0].n).toBe(1);
    });
  }
  it('preserves inclusive VAT and emits the snapshot in generic UBL',async()=>{
    const {p,i}=await po(1,11800,'INCLUSIVE',1800);await http().post(`/orders/${p}/receipts`).set(...auth(buyer)).send({items:[{poItemId:i,qty:1}]}).expect(201);
    const inv=(await http().post(`/invoices/from-po/${p}`).set(...auth(supplier)).send({items:[{poItemId:i,qty:1,unitPriceMinor:11800}]}).expect(201)).body;
    expect([Number(inv.net_minor),Number(inv.vat_minor),Number(inv.gross_minor)]).toEqual([10000,1800,11800]);
    const xml=(await http().get(`/invoices/${inv.id}/ubl`).set(...auth(buyer)).expect(200)).text;
    expect(xml).toContain('<cbc:Percent>18</cbc:Percent>');expect(xml).toContain('>118.00</cbc:PayableAmount>');
    expect(xml).not.toContain('peppol.eu');
    if(process.env.AUDIT_EXPORT_DIR)writeFileSync(`${process.env.AUDIT_EXPORT_DIR}/inclusive.xml`,xml);
  });
  it('exports a zero VAT invoice without inventing 18 percent tax',async()=>{
    const {p,i}=await po(1,10000,'EXCLUSIVE',0,'kg');await http().post(`/orders/${p}/receipts`).set(...auth(buyer)).send({items:[{poItemId:i,qty:1}]}).expect(201);
    const inv=(await http().post(`/invoices/from-po/${p}`).set(...auth(supplier)).send({items:[{poItemId:i,qty:1,unitPriceMinor:10000}]}).expect(201)).body;
    const xml=(await http().get(`/invoices/${inv.id}/ubl`).set(...auth(buyer)).expect(200)).text;
    expect(xml).toContain('unitCode="KGM"');expect(xml).toContain('<cbc:Percent>0</cbc:Percent>');expect(xml).not.toContain('<cbc:Percent>18</cbc:Percent>');
    if(process.env.AUDIT_EXPORT_DIR)writeFileSync(`${process.env.AUDIT_EXPORT_DIR}/zero.xml`,xml);
  });
  for (const mode of ['INCLUSIVE', 'EXCLUSIVE']) {
    it(`preserves mixed 0/18 percent VAT through receipt, invoice and UBL (${mode})`, async () => {
      const price = mode === 'INCLUSIVE' ? 11800 : 10000;
      const { p, i } = await po(1, price, mode, 1800);
      const second = (await db.query(`INSERT INTO purchase_order_items
        (po_id,buyer_org_id,supplier_org_id,line_no,name,qty,uom,unit_price_minor,line_total_minor,vat_rate_bp)
        VALUES($1,$2,$3,2,'Zero VAT item',2,'pcs',5000,10000,0) RETURNING id`, [p,buyer.org.id,supplier.org.id])).rows[0].id;
      await db.query(`UPDATE purchase_orders SET total_minor=$2 WHERE id=$1`, [p,price+10000]);
      await http().post(`/orders/${p}/receipts`).set(...auth(buyer))
        .send({ items: [{ poItemId:i,qty:1 },{ poItemId:second,qty:2 }] }).expect(201);
      const inv = (await http().post(`/invoices/from-po/${p}`).set(...auth(supplier))
        .send({ items: [{ poItemId:i,qty:1,unitPriceMinor:price },{ poItemId:second,qty:2,unitPriceMinor:5000 }] }).expect(201)).body;
      expect([Number(inv.net_minor),Number(inv.vat_minor),Number(inv.gross_minor)]).toEqual([20000,1800,21800]);
      const xml = (await http().get(`/invoices/${inv.id}/ubl`).set(...auth(buyer)).expect(200)).text;
      expect(xml.match(/<cac:TaxSubtotal>/g)).toHaveLength(2);
      expect(xml).toContain('<cbc:Percent>0</cbc:Percent>');
      expect(xml).toContain('<cbc:Percent>18</cbc:Percent>');
      expect(xml).toContain('>200.00</cbc:TaxExclusiveAmount>');
      expect(xml).toContain('>218.00</cbc:PayableAmount>');
      if(process.env.AUDIT_EXPORT_DIR)writeFileSync(`${process.env.AUDIT_EXPORT_DIR}/mixed-${mode.toLowerCase()}.xml`,xml);
    });
  }
  it('disputed overbilling cannot displace a matched invoice when the final receipt arrives',async()=>{
    const {p,i}=await po(20);
    await http().post(`/orders/${p}/receipts`).set(...auth(buyer)).send({items:[{poItemId:i,qty:10}]}).expect(201);
    const submit=(qty:number)=>http().post(`/invoices/from-po/${p}`).set(...auth(supplier)).send({items:[{poItemId:i,qty,unitPriceMinor:100}]}).expect(201);
    const valid=(await submit(10)).body;expect(valid.status).toBe('MATCHED');
    const excess=(await submit(15)).body;expect(excess.status).toBe('DISPUTED');
    await http().post(`/orders/${p}/receipts`).set(...auth(buyer)).send({items:[{poItemId:i,qty:10}]}).expect(201);
    expect((await http().get(`/invoices/${valid.id}`).set(...auth(buyer)).expect(200)).body.status).toBe('MATCHED');
    expect((await http().get(`/invoices/${excess.id}`).set(...auth(buyer)).expect(200)).body.status).toBe('DISPUTED');
    expect((await submit(10)).body.status).toBe('MATCHED');
    expect((await submit(1)).body.status).toBe('DISPUTED');
  });
  it('handles zero and exclusive tax without floating point totals',()=>{
    expect(taxTotals(10000,0,'EXCLUSIVE')).toEqual({net:10000,tax:0,gross:10000});
    expect(taxTotals(10000,1800,'EXCLUSIVE')).toEqual({net:10000,tax:1800,gross:11800});
    expect(()=>taxTotals(Number.MAX_SAFE_INTEGER+1,1800,'EXCLUSIVE')).toThrow();
  });
  it('BLOCKED is enforced for invitation, bidding and catalog creation',async()=>{
    const e=await event();
    await http().post(`/suppliers/${supplier.org.id}/invite`).set(...auth(buyer)).expect(201);
    const rel=(await http().get('/suppliers').set(...auth(buyer)).expect(200)).body.find((r:any)=>r.supplier_org_id===supplier.org.id);
    const blocked=(await http().post(`/suppliers/relationships/${rel.id}/status`).set(...auth(buyer)).send({status:'BLOCKED'}).expect(201)).body;
    expect(blocked.id).toBe(rel.id);expect(blocked.status).toBe('BLOCKED');
    await http().post(`/events/${e.id}/invite`).set(...auth(buyer)).send({supplierOrgId:supplier.org.id}).expect(403);
    await http().post(`/events/${e.id}/bid`).set(...auth(supplier)).send({items:[{eventItemId:e.items[0].id,unitPriceMinor:100}]}).expect(403);
    await http().post('/catalogs').set(...auth(buyer)).send({supplierOrgId:supplier.org.id,title:'Blocked vendor'}).expect(403);
    await http().post(`/suppliers/relationships/${rel.id}/status`).set(...auth(buyer)).send({status:'APPROVED'}).expect(201);
  });
  it('rejects mixed currencies, late withdrawals and incomplete/duplicated evaluations',async()=>{
    const e=await event();const items=[{eventItemId:e.items[0].id,unitPriceMinor:100}];
    await http().post(`/events/${e.id}/bid`).set(...auth(supplier)).send({items,currency:'USD'}).expect(400);
    const bid=(await http().post(`/events/${e.id}/bid`).set(...auth(supplier)).send({items,deliveryDays:0}).expect(201)).body;
    await db.query(`UPDATE sourcing_events SET close_at=now()-interval '1 second' WHERE id=$1`,[e.id]);
    await http().post(`/events/${e.id}/withdraw`).set(...auth(supplier)).expect(400);
    await db.query(`SELECT * FROM close_due_events()`);
    await http().post(`/events/${e.id}/open`).set(...auth(buyer)).expect(201);
    await http().post(`/events/${e.id}/evaluate`).set(...auth(buyer)).send({scores:[]}).expect(400);
    await http().post(`/events/${e.id}/evaluate`).set(...auth(buyer)).send({scores:[{bidId:bid.id,key:'price',score:100},{bidId:bid.id,key:'price',score:100}]}).expect(400);
    await http().post(`/events/${e.id}/evaluate`).set(...auth(buyer)).send({scores:[{bidId:bid.id,key:'price',score:100},{bidId:bid.id,key:'delivery',score:80}]}).expect(201);
    await http().post(`/events/${e.id}/award`).set(...auth(buyer)).send({lotId:e.lots[0].id,bidId:bid.id,justification:'One eligible audited bid'}).expect(201);
    await http().post(`/events/${e.id}/cancel-award`).set(...auth(buyer)).send({lotId:e.lots[0].id,reason:'Audited cancellation'}).expect(201);
    const exp=(await http().get(`/events/${e.id}/ocds`).set(...auth(buyer)).expect(200)).body;
    expect(exp.releases[0].awards[0].status).toBe('cancelled');expect(exp.releases[0].awards[0].suppliers[0].id).toBe(supplier.org.id);
    expect(exp.releases[0].awards[0].value).toEqual({amount:1,currency:'AZN'});
    if(process.env.AUDIT_EXPORT_DIR)writeFileSync(`${process.env.AUDIT_EXPORT_DIR}/ocds.json`,JSON.stringify(exp));
  });
  it('lot-specific AI handles zero price and same-day delivery with finite scores',async()=>{
    const e=await event();await http().post(`/events/${e.id}/bid`).set(...auth(supplier)).send({items:[{eventItemId:e.items[0].id,unitPriceMinor:0}],deliveryDays:0}).expect(201);
    await db.query(`UPDATE sourcing_events SET close_at=now()-interval '1 second' WHERE id=$1`,[e.id]);await db.query(`SELECT * FROM close_due_events()`);
    await http().post(`/events/${e.id}/open`).set(...auth(buyer)).expect(201);
    const result=(await http().get(`/events/${e.id}/ai-recommendation?lotId=${e.lots[0].id}`).set(...auth(buyer)).expect(200)).body;
    const az=(await http().get(`/events/${e.id}/ai-recommendation?lotId=${e.lots[0].id}&language=az`).set(...auth(buyer)).expect(200)).body;
    expect(az.ranking[0].reasons[0]).toContain('Qiymət balı');
    expect(result.ranking[0].priceScore).toBe(100);expect(result.ranking[0].deliveryScore).toBe(100);expect(Number.isFinite(result.ranking[0].weightedTotal)).toBe(true);
  });

  it('analytics excludes cancelled awards, separates currencies and normalizes inclusive orders',async()=>{
    const before=(await http().get('/dashboard/spend-analytics').set(...auth(buyer)).expect(200)).body;
    expect(before.savings.awardedMinor).toBe(0);
    const {p,i}=await po(1,11800,'INCLUSIVE',1800);
    await http().post(`/orders/${p}/receipts`).set(...auth(buyer)).send({items:[{poItemId:i,qty:1}]}).expect(201);
    const usd=await po(1,5000);await db.query(`UPDATE purchase_orders SET status='ACCEPTED',currency='USD' WHERE id=$1`,[usd.p]);
    const azn=(await http().get('/dashboard/spend-analytics?currency=AZN').set(...auth(buyer)).expect(200)).body;
    const dollars=(await http().get('/dashboard/spend-analytics?currency=USD').set(...auth(buyer)).expect(200)).body;
    const sum=(d:any)=>d.monthly.reduce((n:number,m:any)=>n+m.totalMinor,0);
    expect(sum(azn)-sum(before)).toBe(10000);expect(sum(dollars)).toBe(5000);
    expect(azn.currency).toBe('AZN');expect(dollars.currency).toBe('USD');expect(azn.amountBasis).toBe('net');
    await http().get('/dashboard/spend-analytics?currency=INVALID').set(...auth(buyer)).expect(400);
  });

});

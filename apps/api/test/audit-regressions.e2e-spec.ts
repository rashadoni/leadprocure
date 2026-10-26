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
  const tag=randomUUID().slice(0,8);
  const http=()=>request(app.getHttpServer());
  const auth=(u:any)=>['Authorization',`Bearer ${u.accessToken}`] as [string,string];
  beforeAll(async()=>{
    const mod=await Test.createTestingModule({imports:[AppModule]}).compile();
    app=mod.createNestApplication();app.use(cookieParser());app.useGlobalPipes(new ValidationPipe({whitelist:true,transform:true}));await app.init();
    db=new Client({connectionString:process.env.DATABASE_OWNER_URL});await db.connect();
    const reg=async(kind:string,n:string)=>(await http().post(`/auth/register/${kind}`).send({legalName:`Audit ${tag} ${n}`,email:`${n}-${tag}@audit.test`,password:'password123',fullName:n}).expect(201)).body;
    buyer=await reg('buyer','buyer');other=await reg('buyer','other');supplier=await reg('supplier','supplier');
  });
  afterAll(async()=>{if(db){await db.end();}if(app)await app.close();});
  // Fixtures are confined to the disposable test DB. Keeping rows until DB disposal preserves audit history.
  const po=async(qty=10,price=100,mode='EXCLUSIVE',vat=0)=>{
    const user=(await db.query(`SELECT user_id FROM memberships WHERE org_id=$1 LIMIT 1`,[buyer.org.id])).rows[0].user_id;
    const p=(await db.query(`INSERT INTO purchase_orders(buyer_org_id,supplier_org_id,po_no,status,total_minor,currency,created_by,vat_mode)
      VALUES($1,$2,$3,'DELIVERED',$4,'AZN',$5,$6) RETURNING id`,[buyer.org.id,supplier.org.id,randomUUID(),qty*price,user,mode])).rows[0].id;
    const i=(await db.query(`INSERT INTO purchase_order_items(po_id,buyer_org_id,supplier_org_id,line_no,name,qty,uom,unit_price_minor,line_total_minor,vat_rate_bp)
      VALUES($1,$2,$3,1,'Audit item',$4,'pcs',$5,$6,$7) RETURNING id`,[p,buyer.org.id,supplier.org.id,qty,price,qty*price,vat])).rows[0].id;
    return {p,i};
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
  it('preserves inclusive VAT and emits the snapshot in generic UBL',async()=>{
    const {p,i}=await po(1,11800,'INCLUSIVE',1800);await http().post(`/orders/${p}/receipts`).set(...auth(buyer)).send({items:[{poItemId:i,qty:1}]}).expect(201);
    const inv=(await http().post(`/invoices/from-po/${p}`).set(...auth(supplier)).send({items:[{poItemId:i,qty:1,unitPriceMinor:11800}]}).expect(201)).body;
    expect([Number(inv.net_minor),Number(inv.vat_minor),Number(inv.gross_minor)]).toEqual([10000,1800,11800]);
    const xml=(await http().get(`/invoices/${inv.id}/ubl`).set(...auth(buyer)).expect(200)).text;
    expect(xml).toContain('<cbc:Percent>18</cbc:Percent>');expect(xml).toContain('>118.00</cbc:PayableAmount>');
    expect(xml).not.toContain('peppol.eu');
  });
  it('handles zero and exclusive tax without floating point totals',()=>{
    expect(taxTotals(10000,0,'EXCLUSIVE')).toEqual({net:10000,tax:0,gross:10000});
    expect(taxTotals(10000,1800,'EXCLUSIVE')).toEqual({net:10000,tax:1800,gross:11800});
    expect(()=>taxTotals(Number.MAX_SAFE_INTEGER+1,1800,'EXCLUSIVE')).toThrow();
  });
});

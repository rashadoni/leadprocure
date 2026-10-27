const path=require('node:path'),fs=require('node:fs'),assert=require('node:assert/strict');
require('./assert-isolated.cjs')();
const api=path.resolve(__dirname,'../../apps/api');
const ds=require(path.join(api,'src/common/db/data-source.ts')).default;
const classes=fs.readdirSync(path.join(api,'src/common/db/migrations')).filter(f=>f.endsWith('.ts')).sort().flatMap(f=>Object.values(require(path.join(api,'src/common/db/migrations',f))).filter(v=>typeof v==='function'));
const {randomUUID}=require('node:crypto');
(async()=>{
  ds.setOptions({migrations:classes.filter(c=>Number(c.name.match(/\d{13}$/)?.[0]||0)<=1720000000027)});
  await ds.initialize();await ds.runMigrations({transaction:'all'});
  const buyer=randomUUID(),supplier=randomUUID(),user=randomUUID(),po=randomUUID(),item=randomUUID(),invoice=randomUUID(),duplicate=randomUUID();
  await ds.query(`INSERT INTO organizations(id,kind,legal_name) VALUES($1,'BUYER','Upgrade fixture buyer'),($2,'SUPPLIER','Upgrade fixture supplier')`,[buyer,supplier]);
  await ds.query(`INSERT INTO organization_users(id,email,password_hash,full_name) VALUES($1,'upgrade-fixture@audit.invalid','not-a-login-hash','Upgrade fixture')`,[user]);
  await ds.query(`INSERT INTO purchase_orders(id,buyer_org_id,supplier_org_id,po_no,total_minor,created_by) VALUES($1,$2,$3,'UPGRADE-FIXTURE',1000,$4)`,[po,buyer,supplier,user]);
  await ds.query(`INSERT INTO purchase_order_items(id,po_id,buyer_org_id,supplier_org_id,line_no,name,qty,unit_price_minor,line_total_minor) VALUES($1,$2,$3,$4,1,'Fixture',10,100,1000)`,[item,po,buyer,supplier]);
  await ds.query(`INSERT INTO invoices(id,buyer_org_id,supplier_org_id,po_id,invoice_no,net_minor,vat_minor,gross_minor,status) VALUES($1,$2,$3,$4,'UPGRADE-INV',1000,180,1180,'MATCHED')`,[invoice,buyer,supplier,po]);
  for(const id of [randomUUID(),duplicate])await ds.query(`INSERT INTO invoice_items(id,invoice_id,po_item_id,buyer_org_id,supplier_org_id,qty,unit_price_minor,line_total_minor) VALUES($1,$2,$3,$4,$5,10,100,1000)`,[id,invoice,item,buyer,supplier]);
  ds.setOptions({migrations:classes});
  // setOptions does not rebuild TypeORM metadata: the second DataSource loads all migrations.
  await ds.destroy();
  const {DataSource}=require(require.resolve('typeorm',{paths:[api]}));
  const current=new DataSource({...ds.options,migrations:classes,logging:['error']});await current.initialize();
  let blocked=false;
  try{await current.runMigrations({transaction:'all'});}catch(e){if(e.code!=='23505')throw e;blocked=true;}
  assert(blocked,'Historical duplicates must block upgrade instead of being silently deleted');
  assert.equal((await current.query(`SELECT to_regclass('upload_grants') AS table_name`))[0].table_name,null,'Failed upgrade must roll back completely');
  // Only this intentionally invalid, synthetic fixture is reconciled. No customer data is changed.
  await current.query(`DELETE FROM invoice_items WHERE id=$1`,[duplicate]);
  await current.runMigrations({transaction:'all'});
  const inv=(await current.query(`SELECT net_minor,vat_minor,gross_minor FROM invoices WHERE id=$1`,[invoice]))[0];
  assert.deepEqual([inv.net_minor,inv.vat_minor,inv.gross_minor].map(Number),[1000,180,1180]);
  assert.equal((await current.query(`SELECT vat_rate_bp FROM invoice_items WHERE invoice_id=$1`,[invoice]))[0].vat_rate_bp,null,'Do not invent a legacy tax snapshot');
  assert.equal((await current.runMigrations()).length,0,'Upgrade must be idempotent');
  await current.destroy();console.log('PASS: baseline 0027 → rejected invalid data → transaction rollback → reconciled fixture → current schema; financial history preserved');
})().catch(e=>{console.error(e);process.exit(1)});

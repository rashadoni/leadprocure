/* Runs actual TypeScript service methods, with fake DB/external adapters.
 * No network, credentials, application bootstrap, or production writes.
 * NOT an HTTP / PostgreSQL / RLS integration test.
 * npm install --prefix /tmp/leadprocure-datasheet-audit --ignore-scripts typescript@5.6.3
 * node docs/audits/datasheet-2026-10-26/reproduce.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require(process.env.AUDIT_TYPESCRIPT || '/tmp/leadprocure-datasheet-audit/node_modules/typescript');
const root = path.resolve(__dirname, '../../..');
const noop = () => () => {};
const dummy = new Proxy({}, { get: (_, k) => k.endsWith('Exception') ? Error : k === 'Logger' ? class {log(){} warn(){} error(){}} : noop });
function load(file) {
  const source = fs.readFileSync(path.join(root, 'apps/api/src', file), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true } }).outputText;
  const mod = { exports: {} };
  const req = name => name === 'crypto' || name === 'fs' ? require(name) : dummy;
  vm.runInNewContext(js, { exports: mod.exports, module: mod, require: req, Buffer, console, Date, setTimeout, process }, {filename:file});
  return mod.exports;
}
const audit = { record: async () => {} }, notify = { notifyOrg: async () => {} };
const auth = {org_id:'buyer', sub:'user', role:'BUYER_ADMIN'};
const results = [];
async function check(id, fn) { try { const detail = await fn(); results.push({id, result:'CONFIRMED', detail}); } catch(e) { results.push({id,result:'FAILED',error:e.stack}); process.exitCode=1; } }
(async () => {
const {InvoicesService} = load('modules/invoices/invoices.module.ts');
await check('F01_duplicate_invoice_lines', async () => {
  let header, lines=[];
  const m={query:async(sql,p)=>{
    if(sql.includes('FROM purchase_orders')) return [{id:'po',buyer_org_id:'buyer',supplier_org_id:'supplier',currency:'AZN'}];
    if(sql.includes('FROM purchase_order_items')) return [{unit_price_minor:100,qty:10,vat_rate_bp:0}];
    if(sql.includes('FROM goods_receipt_items')) return [{r:10}];
    if(sql.includes('FROM invoice_items ii')) return [{q:0}];
    if(sql.includes('next_document_no')) return [{n:1}];
    if(sql.includes('INSERT INTO invoices(')) {header=p; return [{id:'inv'}];}
    if(sql.includes('INSERT INTO invoice_items')) {lines.push(p); return [];}
    throw Error(sql);
  }};
  const s=new InvoicesService({manager:m},audit,notify); s.get=async()=>({});
  await s.submit('po',{items:[{poItemId:'line',qty:10,unitPriceMinor:100},{poItemId:'line',qty:10,unitPriceMinor:100}]},{...auth,org_id:'supplier'});
  assert.equal(header[8],'MATCHED'); assert.equal(lines.reduce((s,l)=>s+l[4],0),20);
  return 'Received 10; one invoice bills 20 using duplicated poItemId; status MATCHED, net 2000. No unique invoice/PO-line constraint in migration 0016.';
});
await check('F02_ubl_zero_vat',async()=>{
  const m={query:async(sql)=>sql.includes('FROM invoices i')?[{currency:'AZN',invoice_no:'INV',issued_at:'2026-10-26',net_minor:10000,vat_minor:0,gross_minor:10000}]:[{name:'Exempt',qty:1,line_total_minor:10000,unit_price_minor:10000,vat_rate_bp:0}]};
  const xml=await new InvoicesService({manager:m},audit,notify).ublXml('inv');
  assert(xml.includes('<cbc:Percent>18</cbc:Percent>')); assert(xml.includes('>0.00</cbc:TaxAmount>'));
  return 'Actual generated XML: zero total VAT, line tax category S / 18%. No schema conformance claim made by this test.';
});
const {SourcingService}=load('modules/sourcing/sourcing.service.ts');
await check('F03_auction_awards_nonlowest',async()=>{
  const queries=[];
  const m={query:async(sql,p)=>{queries.push(sql);
    if(sql.startsWith('SELECT id FROM sourcing_events')) return [{id:'event'}];
    if(sql.startsWith('SELECT * FROM sourcing_events')) return [{buyer_org_id:'buyer',status:'EVALUATION',type:'AUCTION',format:'REVERSE'}];
    if(sql.includes('SELECT * FROM awards')) return [];
    if(sql.includes('SELECT id, state, total_minor FROM bids')) return [{id:'expensive',state:'OPENED',total_minor:20000}];
    if(sql.includes('INSERT INTO awards')) return [{id:'award'}];
    if(sql.includes('remaining')) return [{remaining:0}];
    if(sql.includes('supplier_org_id FROM bids')) return [{supplier_org_id:'supplier'}];
    if(sql.startsWith('UPDATE')) return [[],1];
    throw Error(sql);
  }};
  const s=new SourcingService({manager:m,orgId:'buyer'},audit,{sha256:x=>x},{sign:async()=>''},{},{},{emit(){}},{},{},{},notify);
  const r=await s.award('event',{lotId:'lot',bidId:'expensive'},auth);
  assert.equal(r.award.id,'award'); assert(!queries.some(q=>q.includes('auction_state')||q.includes('min(total_minor)')));
  return 'Requested OPENED bid awarded without any best-price query or justification. DB adapter contains no ranking enforcement; inspect migrations separately.';
});
await check('F04_empty_formal_evaluation',async()=>{
  const m={query:async(sql)=>sql.includes('SELECT * FROM sourcing_events')?[{buyer_org_id:'buyer',status:'EVALUATION',type:'RFQ',evaluation_criteria:[{key:'price',weight:100}]}]:sql.includes('FROM awards')?[]:sql.includes("state='OPENED'")?[{id:'a'},{id:'b'}]:sql.includes('INSERT INTO evaluations')?[{id:'eval'}]:(()=>{throw Error(sql)})()};
  const s=new SourcingService({manager:m,orgId:'buyer'},audit);
  const r=await s.evaluate('event',{scores:[]},auth); assert.equal(r.evaluation_id,'eval'); assert.equal(r.ranking.length,0);
  return 'Two eligible bids + zero scores creates a formal evaluation. No completeness guard.';
});
const {HeuristicScorer}=load('common/ai/ai-scorer.ts');
await check('F05_ai_zero_values',async()=>{
  const scorer=new HeuristicScorer({manager:{query:async sql=>sql.includes('FROM bids')?[{id:'free',supplier_org_id:'s',supplier_name:'S',total_minor:'0',delivery_days:0}]:[]}});
  const r=await scorer.recommend('e'); assert(Number.isNaN(r.ranking[0].priceScore)); assert(Number.isNaN(r.ranking[0].weightedTotal));
  return 'Valid zero unit price / zero delivery days => NaN scores (JSON null) and NaN rationale.';
});
await check('F06_ai_incomparable_currency',async()=>{
  const scorer=new HeuristicScorer({manager:{query:async sql=>sql.includes('FROM bids')?[{id:'usd',supplier_org_id:'s1',supplier_name:'USD',total_minor:'10000',currency:'USD',delivery_days:5},{id:'azn',supplier_org_id:'s2',supplier_name:'AZN',total_minor:'15000',currency:'AZN',delivery_days:5}]:[]}});
  const r=await scorer.recommend('e'); assert.equal(r.recommendedBidId,'usd');
  return '100 USD is ranked cheaper than 150 AZN purely by raw minor units; neither currency nor FX enters query/calculation. Same issue for unequal lot coverage.';
});
const {VerificationService}=load('modules/verification/verification.module.ts');
await check('F07_kyc_foreign_storage_key',async()=>{
  let stored;
  const m={query:async(sql,p)=>sql.includes('SELECT buyer_org_id')?[{buyer_org_id:'buyer',supplier_org_id:'supplier'}]:sql.includes('INSERT INTO supplier_verification_documents')?(stored=p[4],[{id:'doc'}]):(()=>{throw Error(sql)})()};
  const s=new VerificationService({manager:m},audit,notify,{signedGetUrl:async key=>'signed:'+key});s.getCase=async()=>({});
  await s.confirmDoc('case',{docType:'KYC',storageKey:'FOREIGN_ORG/known-object/private.pdf',filename:'x',sha256:'fake'},{...auth,org_id:'supplier'});
  assert.equal(stored,'FOREIGN_ORG/known-object/private.pdf');
  s.rc.manager.query=async()=>[{storage_key:stored}]; const r=await s.docDownload('doc');assert(r.url.includes('FOREIGN_ORG'));
  return 'Caller-supplied foreign object key accepted and handed to signer. Exploit requires knowledge of existing key; no live object downloaded.';
});
const {ContractsService}=load('modules/contracts/contracts.module.ts');
await check('F08_multilot_po_scope',async()=>{
  let itemSql, header;
  const s=new ContractsService({manager:{query:async(sql,p)=>{
    if(sql==='SELECT * FROM contracts WHERE id = $1') return [{id:'c',buyer_org_id:'buyer',supplier_org_id:'supplier',status:'ACTIVE',total_minor:100,currency:'AZN'}];
    if(sql.includes('JOIN bid_items')){itemSql=sql;return [{event_item_id:'won',qty:1,line_total_minor:100},{event_item_id:'lost',qty:1,line_total_minor:900}];}
    if(sql.includes('COALESCE(SUM'))return [{s:0}];if(sql.includes('next_document_no'))return [{n:1}];
    if(sql.includes('INSERT INTO purchase_orders')){header=p;return [{id:'po'}];}if(sql.includes('INSERT INTO purchase_order_items'))return [];
    throw Error(sql);
  }}},audit,notify);s.getOrder=async()=>({id:'po'});
  await s.createOrder('c',auth);assert.equal(header[4],1000);assert(!itemSql.includes('ei.lot_id'));
  return 'Actual query selects all winning-bid items, no award lot filter; won 100 + other lot 900 produces PO 1000. Same omission in catalog seeding; contract header uses entire bid total.';
});
const {FollowupsService}=load('modules/followups/followups.module.ts');
await check('F09_followup_stop_returning_shape',async()=>{
  const s=new FollowupsService({manager:{query:async()=>[[{id:'enrollment'}],1]}}, {record:async(a,t,id)=>assert.equal(id,undefined)});
  await s.stop('e','s',auth);
  return 'TypeORM PostgreSQL UPDATE shape [rows,count] gives undefined audit entityId; stop succeeds. [[],0] also has length and incorrectly reports success for absent enrollment.';
});
const {SealedCryptoService}=load('common/crypto/sealed.service.ts');
await check('PASS_crypto_roundtrip_tamper',async()=>{
  const s=new SealedCryptoService({bidMasterKeyB64:Buffer.alloc(32,7).toString('base64')});const b=s.seal({total:12345});assert.equal(s.open(b).total,12345);b.ciphertext[0]^=1;assert.throws(()=>s.open(b));return 'Actual AES-GCM round-trip works, altered ciphertext rejected.';
});
const {RequestsService}=load('modules/requests/requests.module.ts');
await check('PASS_self_approval_blocked',async()=>{
  const s=new RequestsService({manager:{query:async sql=>sql.includes('SELECT *')?[{status:'SUBMITTED',created_by:'user'}]:[{id:'r'}]}},audit,{});
  await assert.rejects(()=>s.approve('r',auth),/cannot approve/);return 'Creator cannot approve own request in real service method.';
});
const {CatalogsService}=load('modules/catalogs/catalogs.module.ts');
await check('PASS_catalog_moq',async()=>{
  const s=new CatalogsService({manager:{query:async sql=>sql.includes('FROM catalogs')?[{buyer_org_id:'buyer',status:'ACTIVE'}]:[{id:'i',moq:10,unit_price_minor:100}]}},audit,notify);
  await assert.rejects(()=>s.order('c',[{catalogItemId:'i',qty:9}],auth),/MOQ/);return 'Below-MOQ order rejected.';
});
await check('F10_auction_no_priced_lines_for_po',async()=>{
  const {AuctionService}=load('modules/sourcing/auction.service.ts');let queries=[];
  const m={query:async(sql,p)=>{queries.push(sql);
    if(sql.includes('pg_advisory'))return [];
    if(sql.includes('SELECT * FROM sourcing_events'))return [{status:'OPEN',close_at:new Date(Date.now()+3600000),evaluation_currency:'AZN',auction_start_price_minor:200,auction_min_decrement_minor:1}];
    if(sql.includes('SELECT id, qty FROM event_items'))return [{id:'line',qty:1}];
    if(sql.includes('auction_state'))return [{best_total_minor:null}];
    if(sql.includes('INSERT INTO auction_bids'))return [{id:'tick'}];
    if(sql.includes('INSERT INTO bids')||sql.includes('followup_mark_responded'))return [];
    if(sql.includes('auction_try_extend'))return [{extended:false}];throw Error(sql);
  }};
  const a=new AuctionService({manager:m},audit,{sign:async()=>''},{sha256:x=>x},{},{},{emit(){}});
  const tick=await a.placeBid('e',{items:[{eventItemId:'line',unitPriceMinor:100}]},{...auth,org_id:'supplier'});assert(tick.accepted);
  assert(!queries.some(q=>q.includes('INSERT INTO bid_items')));
  const c=new ContractsService({manager:{query:async sql=>sql.includes('SELECT * FROM contracts')?[{buyer_org_id:'buyer',status:'ACTIVE'}]:[]}},audit,notify);
  await assert.rejects(()=>c.createOrder('c',auth),/No priced items/);
  return 'Auction stores payload and bid total but no bid_items; normal contract-to-PO method rejects empty priced lines. Checked migrations: no trigger materializes these lines.';
});
await check('F04_duplicate_formal_scores',async()=>{
  const m={query:async(sql)=>sql.includes('SELECT * FROM sourcing_events')?[{buyer_org_id:'buyer',status:'EVALUATION',type:'RFQ',evaluation_criteria:[{key:'price',weight:100}]}]:sql.includes('FROM awards')?[]:sql.includes("state='OPENED'")?[{id:'a'}]:sql.includes('INSERT INTO evaluations')?[{id:'eval'}]:sql.includes('INSERT INTO evaluation_scores')?[]:(()=>{throw Error(sql)})()};
  const s=new SourcingService({manager:m,orgId:'buyer'},audit);const r=await s.evaluate('e',{scores:[{bidId:'a',key:'price',score:100},{bidId:'a',key:'price',score:100}]},auth);
  assert.equal(r.ranking[0].weighted_total,200);return 'Duplicate criterion for same bid yields 200/100 score; no unique constraint on evaluation_scores in migrations.';
});
await check('F13_ocds_cancelled_award_active',async()=>{
  const s=new SourcingService({},audit);s.detail=async()=>({status:'EVALUATION',awards:[{id:'cancelled',lot_id:'l',cancelled_at:'2026-10-25'}]});
  const r=await s.ocdsRelease('e',auth);assert.equal(r.releases[0].awards[0].status,'active');return 'Soft-cancelled award exported as active; supplier and award value omitted. Not a full schema-validation test.';
});
console.log(JSON.stringify({scope:'Real service code; mocked DB and external adapters. Not integration or production verification.',results},null,2));
})();

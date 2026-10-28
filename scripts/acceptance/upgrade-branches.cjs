// Run only on the disposable hosted acceptance cluster. Never copies runtime data.
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
require('./assert-isolated.cjs')();
const root = path.resolve(__dirname, '../..');
const api = path.join(root, 'apps/api');
const { DataSource } = require(require.resolve('typeorm', { paths: [api] }));
const { Client } = require(require.resolve('pg', { paths: [api] }));
const source = require(path.join(api, 'src/common/db/data-source.ts')).default;
const baselines = require('./migration-baselines.json');
const entries = fs.readdirSync(path.join(api, 'src/common/db/migrations')).filter(f => f.endsWith('.ts')).sort().map(f => {
  const relative = `apps/api/src/common/db/migrations/${f}`;
  return { relative, hash: createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex'),
    classes: Object.values(require(path.join(root, relative))).filter(v => typeof v === 'function') };
});
const all = entries.flatMap(e => e.classes);
(async () => {
  const admin = new Client({ connectionString: process.env.DATABASE_OWNER_URL });
  await admin.connect();
  const results = [];
  try {
    for (const [label, baseline] of Object.entries(baselines)) {
      const database = `leadprocure_${label}_upgrade_test_${randomUUID().slice(0, 8)}`;
      assert.match(database, /^leadprocure_[a-z_]+_test_[0-9a-f]{8}$/);
      // This exact database is newly created by this process, then removed in finally.
      await admin.query(`CREATE DATABASE "${database}"`);
      const url = new URL(process.env.DATABASE_OWNER_URL); url.pathname = `/${database}`;
      const options = { ...source.options, url: url.href, logging: ['error'] };
      const previous = entries.filter(e => baseline.files[e.relative]).flatMap(e => e.classes);
      for (const [file, hash] of Object.entries(baseline.files)) {
        assert.equal(entries.find(e => e.relative === file)?.hash, hash, `Applied migration changed: ${label} ${file}`);
      }
      let ds;
      try {
        ds = new DataSource({ ...options, migrations: previous });
        await ds.initialize(); await ds.runMigrations({ transaction: 'all' });
        const buyer = randomUUID(), supplier = randomUUID(), user = randomUUID(), budget = randomUUID();
        await ds.query(`INSERT INTO organizations(id,kind,legal_name) VALUES($1,'BUYER','Branch upgrade buyer'),($2,'SUPPLIER','Branch upgrade supplier')`, [buyer, supplier]);
        await ds.query(`INSERT INTO organization_users(id,email,password_hash,full_name) VALUES($1,$2,'not-a-login-hash','Upgrade fixture')`, [user, `${label}@acceptance.invalid`]);
        if (label === 'audit_main') {
          await ds.query(`INSERT INTO budgets(id,buyer_org_id,name,category,period_year,amount_minor,currency) VALUES($1,$2,'Existing plan','*',2026,123456,'AZN')`, [budget, buyer]);
        } else {
          await ds.query(`INSERT INTO budgets(id,buyer_org_id,name,category,period_type,period_start,period_end,amount_minor,currency,status) VALUES($1,$2,'Existing plan','*','YEAR','2026-01-01','2026-12-31',123456,'AZN','APPROVED')`, [budget, buyer]);
        }
        const applied = await ds.query('SELECT timestamp::text,name FROM migrations ORDER BY name');
        await ds.destroy();
        ds = new DataSource({ ...options, migrations: all });
        await ds.initialize();
        const pending = await ds.runMigrations({ transaction: 'all' });
        assert.equal(pending.length, all.length - previous.length);
        const after = await ds.query('SELECT timestamp::text,name FROM migrations ORDER BY name');
        for (const row of applied) assert.deepEqual(after.find(r => r.name === row.name), row);
        const plan = (await ds.query('SELECT amount_minor,status,period_start::text,period_end::text FROM budgets WHERE id=$1', [budget]))[0];
        assert.deepEqual(plan, { amount_minor: '123456', status: 'APPROVED', period_start: '2026-01-01', period_end: '2026-12-31' });
        const columns = await ds.query("SELECT column_name FROM information_schema.columns WHERE table_name='budgets' AND column_name='period_year'");
        assert.equal(columns.length, 0);
        assert.equal((await ds.query("SELECT to_regclass('upload_grants')::text AS name"))[0].name, 'upload_grants');
        assert.equal((await ds.runMigrations({ transaction: 'all' })).length, 0);
        results.push({ baseline: label, sha: baseline.sha, originalMigrations: previous.length, addedMigrations: pending.length, totalMigrations: all.length, appliedHistoryUnchanged: true, budgetPreserved: true, secondRunEmpty: true });
      } finally {
        if (ds?.isInitialized) await ds.destroy();
        await admin.query(`DROP DATABASE "${database}"`);
      }
    }
    const evidence = { status: 'PASS', syntheticDataOnly: true, results };
    if (process.env.AUDIT_EXPORT_DIR) {
      fs.mkdirSync(process.env.AUDIT_EXPORT_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.AUDIT_EXPORT_DIR, 'migration-branches.json'), JSON.stringify(evidence, null, 2));
    }
    console.log(JSON.stringify(evidence));
  } finally { await admin.end(); }
})().catch(e => { console.error(e); process.exitCode = 1; });

// Real HTTP actions against the loopback-only, freshly built production stack.
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { writeFileSync } = require('node:fs');
const api = 'http://127.0.0.1:39300';
const tag = randomUUID().slice(0, 8);
const password = `Isolated-${randomUUID()}`;
async function call(path, method = 'GET', body, token, expected = 200) {
  const r = await fetch(api + path, { method, headers: {
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) });
  assert.equal(r.status, expected, `${method} ${path}: HTTP ${r.status}`);
  return r.json();
}
const pause = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const health = await call('/health');
  assert.equal(health.deploymentMode, 'on_prem_isolated');
  assert.equal(health.licenseSource, 'file');
  assert.equal(health.licenseStatus, 'valid');
  const register = async suffix => (await call('/auth/register/buyer', 'POST', {
    legalName: `Install ${tag} ${suffix}`, fullName: 'Install acceptance',
    email: `${suffix}-${tag}@acceptance.invalid`, password,
  }, undefined, 201)).accessToken;
  const buyer = await register('buyer-a');
  const foreign = await register('buyer-b');
  const approverEmail = `approver-${tag}@acceptance.invalid`;
  await call('/settings/users', 'POST', { email: approverEmail, fullName: 'Second approver',
    password, role: 'BUYER_APPROVER' }, buyer, 201);
  const approver = (await call('/auth/login', 'POST', { email: approverEmail, password }, undefined, 201)).accessToken;
  assert.ok(approver);
  await call('/requests/method-policies', 'PUT', { policies: [
    { category: '*', minAmountMinor: 0, maxAmountMinor: null, method: 'DIRECT' },
  ] }, buyer);
  const budget = await call('/budgets', 'POST', { name: `IT ${tag}`, category: 'IT',
    periodYear: new Date().getUTCFullYear(), amountMinor: 50_000 }, buyer, 201);
  assert.ok(budget.id);
  assert.equal(budget.status, 'DRAFT');
  await call(`/budgets/${budget.id}/submit`, 'POST', undefined, buyer, 201);
  await call(`/budgets/${budget.id}/approve`, 'POST', undefined, buyer, 403);
  await call(`/budgets/${budget.id}/approve`, 'POST', undefined, approver, 201);
  if (process.env.FRESH_BROWSER_ACCOUNT_FILE) {
    writeFileSync(process.env.FRESH_BROWSER_ACCOUNT_FILE, JSON.stringify({
      email: `buyer-a-${tag}@acceptance.invalid`, password, budgetName: `IT ${tag}`,
    }), { mode: 0o600 });
  }
  const req = await call('/requests', 'POST', { title: `Procurement ${tag}`, category: 'IT',
    items: [{ name: 'Equipment', qty: 1, estUnitPriceMinor: 120_000 }] }, buyer, 201);
  await call(`/requests/${req.id}/submit`, 'POST', undefined, buyer, 201);
  await call(`/requests/${req.id}/approve`, 'POST', undefined, buyer, 403);
  const approved = await call(`/requests/${req.id}/approve`, 'POST', undefined, approver, 201);
  assert.equal(approved.status, 'APPROVED');
  assert.ok(approved.budgetWarnings.some(x => x.category === 'IT' && x.overByMinor > 0));
  const budgets = await call('/budgets', 'GET', undefined, buyer);
  const used = budgets.find(x => x.id === budget.id);
  assert.ok(used.committedMinor >= 120_000);
  assert.equal(used.remainingMinor, used.amountMinor - used.committedMinor);
  assert.deepEqual(await call('/budgets', 'GET', undefined, foreign), []);

  const upload = async (filename, content) => {
    const pre = await call('/documents/presign', 'POST', { filename, mime: 'text/plain' }, buyer, 201);
    const put = await fetch(pre.uploadUrl, { method: 'PUT', body: content,
      headers: { 'Content-Type': 'text/plain' }, signal: AbortSignal.timeout(20_000) });
    assert.ok(put.ok, `presigned PUT: HTTP ${put.status}`);
    const anonymous = new URL(pre.uploadUrl); anonymous.search = '';
    assert.equal((await fetch(anonymous, { signal: AbortSignal.timeout(20_000) })).status, 403);
    return call('/documents/confirm', 'POST', { storageKey: pre.storageKey, filename,
      mime: 'text/plain', sizeBytes: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'), entityType: 'request', entityId: req.id }, buyer, 201);
  };
  const cleanText = 'Fresh installation procurement attachment';
  const clean = await upload('clean.txt', cleanText);
  const eicar = await upload('eicar.txt', ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$',
    'EICAR-STANDARD-', 'ANTIVIRUS-TEST-', 'FILE!$H+H*'].join(''));
  assert.equal(clean.avStatus, 'PENDING'); assert.equal(eicar.avStatus, 'PENDING');
  const deadline = Date.now() + 180_000;
  let docs;
  do {
    docs = await call('/documents', 'GET', undefined, buyer);
    if (docs.find(x => x.id === clean.id)?.av_status === 'CLEAN' &&
        docs.find(x => x.id === eicar.id)?.av_status === 'INFECTED') break;
    await pause(3000);
  } while (Date.now() < deadline);
  assert.equal(docs.find(x => x.id === clean.id)?.av_status, 'CLEAN');
  assert.equal(docs.find(x => x.id === eicar.id)?.av_status, 'INFECTED');
  await call(`/documents/${eicar.id}/download`, 'GET', undefined, buyer, 400);
  assert.equal((await call(`/documents/${clean.id}/download`, 'GET', undefined, foreign)).url, null);
  const signed = (await call(`/documents/${clean.id}/download`, 'GET', undefined, buyer)).url;
  const download = await fetch(signed, { signal: AbortSignal.timeout(20_000) });
  assert.equal(download.status, 200); assert.equal(await download.text(), cleanText);
  const anonymous = new URL(signed); anonymous.search = '';
  assert.equal((await fetch(anonymous, { signal: AbortSignal.timeout(20_000) })).status, 403);
  const web = await fetch('http://127.0.0.1:39380', { signal: AbortSignal.timeout(20_000) });
  assert.equal(web.status, 200); assert.match(await web.text(), /<script[^>]+src=/);
  const evidence = { status: 'PASS', productionMode: true, signedFileLicense: true,
    separateApprover: true, budgetWarningStillApproves: true, budgetIsolation: true,
    privateStorage: true, presignedPutGet: true, realClamavCleanAndEicar: true,
    foreignDocumentDenied: true, webServed: true };
  writeFileSync(process.env.FRESH_EVIDENCE_FILE, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
})().catch(e => { console.error(e.message); process.exit(1); });

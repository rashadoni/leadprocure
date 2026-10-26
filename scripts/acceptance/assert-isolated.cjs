const assert = require('node:assert/strict');
module.exports = function assertIsolated(env = process.env) {
  assert.equal(env.LEADPROCURE_TEST_ISOLATED, '1', 'Refusing tests without explicit isolated environment');
  for (const key of ['DATABASE_URL', 'DATABASE_OWNER_URL']) {
    const u = new URL(env[key] || '');
    assert(['localhost', '127.0.0.1', 'postgres'].includes(u.hostname), `${key}: test host required`);
    assert.equal(u.pathname, '/leadprocure_audit_test', `${key}: disposable database required`);
  }
  assert.equal(env.NODE_ENV, 'test');
  for (const k of ['SMTP_HOST','WHATSAPP_API_URL','AI_ORCHESTRATOR_URL']) assert(!env[k], `Disable external integration ${k} in regression tests`);
};
if (require.main === module) module.exports();

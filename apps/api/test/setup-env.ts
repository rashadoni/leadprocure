import { loadRootEnv } from '../src/common/config/env';

require('../../../scripts/acceptance/assert-isolated.cjs')();

// The refresh reuse-leeway assertion (auth.e2e) compares wall-clock against a rotation
// timestamp. Under the full runInBand suite the connection pool can delay a single request
// by many seconds, which would flip a legitimate benign replay into a false theft signal.
// A generous leeway in the test env removes that flake; the theft path stays deterministic
// because it ages revoked_at by an hour, far beyond any leeway.
process.env.JWT_REFRESH_REUSE_LEEWAY_MS = process.env.JWT_REFRESH_REUSE_LEEWAY_MS ?? '120000';

// No wall-clock cron in the e2e apps. A tick that outlives its suite's app.close() logs
// after teardown and jest then exits non-zero with every test green — seen on main at
// run 41226454840, where 374 of 374 passed and the step still failed, from
// FollowupsScheduler.tick. Schedulers are exercised by calling the tick directly.
process.env.DISABLE_SCHEDULERS = '1';

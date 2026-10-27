import { loadRootEnv } from '../src/common/config/env';

require('../../../scripts/acceptance/assert-isolated.cjs')();

// The refresh reuse-leeway assertion (auth.e2e) compares wall-clock against a rotation
// timestamp. Under the full runInBand suite the connection pool can delay a single request
// by many seconds, which would flip a legitimate benign replay into a false theft signal.
// A generous leeway in the test env removes that flake; the theft path stays deterministic
// because it ages revoked_at by an hour, far beyond any leeway.
process.env.JWT_REFRESH_REUSE_LEEWAY_MS = process.env.JWT_REFRESH_REUSE_LEEWAY_MS ?? '120000';

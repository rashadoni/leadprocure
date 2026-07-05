import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { config as loadEnv } from 'dotenv';

// Walks up from a starting dir to find the monorepo-root .env, so CLI scripts
// (migrations, seed) work regardless of the cwd pnpm gives them.
export function loadRootEnv(start: string = __dirname): void {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      loadEnv({ path: candidate });
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  loadEnv(); // fall back to default resolution
}

import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { COURSE, COURSE_LESSONS } from '../src/guides';
import * as ROLES from '../src/roles';

// The course on /learn is a hand-written ORDER over files on disk and routes in the
// router, and nothing in the type system ties the three together. Each assertion below
// stands for a failure that has a shape in this repository:
//
//  · a key whose recording is missing gives the player a 404 — the note at the top of
//    guides.ts warns about exactly this, because a key is cheap to add and a recording
//    is not;
//  · a recording that no track lists is invisible, which is how `sup-auction` spent its
//    whole life before this page existed;
//  · a title key missing from a dictionary prints its own NAME on screen, since `t` falls
//    back to the key — in one language only, which is the kind of defect a walk in
//    English cannot see;
//  · a lesson whose `roles` drift from the route's own guard offers a door the router
//    shuts, landing the reader on the home page.
//
// Asked of the files rather than of the browser: all four are true or false before the app
// is even served, and this suite then needs no stand, no login and no quota from the
// throttled /auth/login.

// Resolved from the runner's working directory the way hint-of.spec.ts does it, so the
// suite survives being run from the repo root as well as from apps/web.
const roots = ['.', 'apps/web'].map((r) => join(process.cwd(), r));
const resolve = (rel: string) => {
  const hit = roots.map((r) => join(r, rel)).find(existsSync);
  if (!hit) throw new Error(`${rel} not found from ${process.cwd()}`);
  return hit;
};

const GUIDES_DIR = resolve('public/guides');
const I18N = readFileSync(resolve('src/i18n.tsx'), 'utf8');
const MAIN = readFileSync(resolve('src/main.tsx'), 'utf8');

test('every lesson in the course has its recording on disk', () => {
  const missing = COURSE_LESSONS
    .flatMap((l) => [`${l.key}.az.webm`, `${l.key}.az.png`])
    .filter((f) => !existsSync(join(GUIDES_DIR, f)));
  expect(missing, 'a lesson points at a file that does not exist — the player would 404')
    .toEqual([]);
});

test('every recording on disk is reachable from the course', () => {
  const onDisk = [...new Set(
    readdirSync(GUIDES_DIR).filter((f) => f.endsWith('.az.webm')).map((f) => f.replace('.az.webm', '')),
  )].sort();
  const listed = COURSE_LESSONS.map((l) => l.key).sort();
  expect(listed, 'a recording exists that no track lists — it is invisible, as sup-auction was')
    .toEqual(onDisk);
  // Twice in the course is as wrong as not at all: the progress count and «continue»
  // would both read one lesson twice.
  expect(new Set(listed).size, 'a key is listed twice').toBe(listed.length);
});

test('every lesson title is translated in all three languages', () => {
  const keys = [...COURSE.map((tr) => tr.titleKey), ...COURSE_LESSONS.map((l) => l.titleKey)];
  const short = keys.filter((k) => (I18N.match(new RegExp(`^    ${k}: '`, 'gm')) ?? []).length !== 3);
  expect(short, 'a title is missing from a dictionary — the screen would show the key itself')
    .toEqual([]);
});

test('a lesson offers only a section its own role may open', () => {
  // { path: '/buyer/budgets', element: <Protected roles={FINANCE_READ}>…
  const guard = new Map<string, string[]>();
  for (const m of MAIN.matchAll(/path: '([^']+)', element: <Protected(?: roles=\{(\w+)\})?>/g)) {
    const named = m[2];
    const list = named ? (ROLES as Record<string, string[]>)[named] : undefined;
    if (named) expect(list, `main.tsx guards ${m[1]} with ${named}, which src/roles.ts does not export`).toBeTruthy();
    guard.set(m[1], list ?? []);
  }
  // The parse itself has to be known to work: it reads the router, and a router whose
  // shape moved would leave this test quietly green over an empty map.
  expect(guard.size, 'the router parse found almost no routes — the pattern is stale')
    .toBeGreaterThan(15);

  const wrong = COURSE_LESSONS
    .filter((l) => l.to)
    .filter((l) => JSON.stringify(l.roles ?? []) !== JSON.stringify(guard.get(l.to!) ?? null))
    .map((l) => `${l.key} → ${l.to}`);
  expect(wrong, 'a lesson links to a route guarded by a different role list than the lesson claims')
    .toEqual([]);
});

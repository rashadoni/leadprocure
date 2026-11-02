import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hintOf } from '../src/components/hint';

// `hintOf` shortens a tooltip that is too long for a bubble. It must stop at the end of a
// sentence — a bubble that breaks off mid-thought reads as a bug, and the half it drops is
// usually the half that carries the rule.
//
// This is asked of the DICTIONARY rather than of the screen, for one reason: the defect is
// per-language. The em-dash bug that prompted this test was invisible in Azerbaijani and
// English, where the same sentence ends on a full stop, and the browser walk runs the
// interface in English — so the walk could not have caught it, at any width, on any page.
//
// The strings are read out of the file rather than imported: `i18n.tsx` carries JSX, and a
// Node test should not have to load React to read a list of strings. Both quote styles are
// matched on purpose — the English block uses double quotes wherever a string contains an
// apostrophe, and a pattern that only knows `'…'` silently skips those and looks like a
// missing translation.
// Resolved from the runner's working directory (Playwright sets it to the config's own
// folder) rather than from `__dirname`, which this file does not have: the specs are
// loaded as modules. Both candidates are tried so the test survives being run from the
// repo root, and a miss fails here rather than silently reading nothing.
const CANDIDATES = ['src/i18n.tsx', 'apps/web/src/i18n.tsx'];
const found = CANDIDATES.map((c) => join(process.cwd(), c)).find(existsSync);
if (!found) throw new Error(`i18n.tsx not found from ${process.cwd()}`);
const SRC = readFileSync(found, 'utf8');
const ENTRY = /\b([a-z0-9_]+):\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;

test('a shortened tooltip ends on a sentence, in every language', () => {
  const strings = [...SRC.matchAll(ENTRY)].map((m) => [m[1], m[2] ?? m[3]] as const);
  // A regex that matches nothing would make every assertion below pass on an empty list.
  // The dictionary holds three languages of several hundred keys; a floor well under that
  // fails loudly if the parse ever stops working, instead of going quietly green.
  expect(strings.length, 'the dictionary parse found almost nothing — the pattern is stale')
    .toBeGreaterThan(1500);

  const broken = strings
    .map(([key, text]) => [key, text, hintOf(text)] as const)
    .filter(([, text, short]) => short !== text)
    .filter(([, , short]) => !/[.!?…]$/.test(short))
    .map(([key, , short]) => `${key}: "…${short.slice(-45)}"`);
  expect(broken, `these tooltips break off mid-sentence — ${broken.join('; ')}`).toEqual([]);
});

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
// Uppercase belongs in the key name: every status key is spelled `st_APPROVED`,
// `delivery_SENT`, `vis_PUBLIC_tip`, `bud_st_CLOSED`. A pattern of `[a-z0-9_]+` cannot match
// one at all — see the guard below for what that cost.
const ENTRY = /\b([A-Za-z0-9_]+):\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g;

test('a shortened tooltip ends on a sentence, in every language', () => {
  const strings = [...SRC.matchAll(ENTRY)].map((m) => [m[1], m[2] ?? m[3]] as const);
  // A regex that matches nothing would make every assertion below pass on an empty list.
  // The dictionary holds three languages of several hundred keys; a floor well under that
  // fails loudly if the parse ever stops working, instead of going quietly green.
  expect(strings.length, 'the dictionary parse found almost nothing — the pattern is stale')
    .toBeGreaterThan(1500);

  // A floor only notices a pattern that DIED. The one that shipped here had gone partially
  // blind instead: it excluded uppercase from the key name, so it skipped every status key
  // — 1636 of the 1966 strings the dictionary held at 09d7570, and those 1636 cleared the
  // floor above without a word, while `bud_st_*` and `vis_*_tip` are rendered as `data-tip`
  // and so are exactly what this test exists to measure. Counting against a dumber pattern
  // is no good either: `key: '` occurs inside comments and inside the strings themselves.
  // So one name is pinned per class the pattern has to span, which is what a blind spot
  // looks like from the outside — coverage lost silently, not a parse that stopped.
  //
  // Read those two counts as a ratio and nothing else: the dictionary grows (1999 strings
  // by #105), and they are raw match counts, which is the only way to compare them. The
  // first telling of this gave «1622 of 1966» — a de-duplicated count of the blind pattern
  // against a raw count of the fixed one, two numbers that do not belong in one sentence.
  //
  // THREE classes, not one, and each name below is load-bearing for a different reason.
  // The first guard pinned four uppercase names and would itself have stayed green had the
  // pattern lost `0-9`: nine keys carry a digit (`bud_1c`, `bud_1c_tip`, `win_12m`,
  // `integ_1c`, `chain_p0`…`chain_p3`, `chain_p0_desc`), and `chain_p0_desc` stands for
  // them — not because it is long (69 characters at its longest, in Azerbaijani, well under
  // the threshold `hintOf` acts on) but because it carries the digit.
  //
  // `delivery_SENT` is NOT a third uppercase name beside `st_APPROVED` and `bud_st_CLOSED`,
  // and must not be dropped as a duplicate of them: its value is the only one of the five
  // written in DOUBLE quotes, so it is the whole guard on the pattern's `"…"` branch. Lose
  // that branch and 47 strings go unmeasured — among them both of the two over-threshold
  // strings, including `paid_basis_tip_budget_obligation` at 564 characters, the longest
  // tooltip in the product. The English block uses double quotes wherever a string holds an
  // apostrophe, which is why the branch exists at all (see the header).
  const keys = strings.map(([key]) => key);
  for (const k of ['st_APPROVED', 'delivery_SENT', 'vis_PUBLIC_tip', 'bud_st_CLOSED', 'chain_p0_desc'])
    expect(keys, `the pattern no longer sees ${k} — it is skipping a class of keys`).toContain(k);

  const broken = strings
    .map(([key, text]) => [key, text, hintOf(text)] as const)
    .filter(([, text, short]) => short !== text)
    .filter(([, , short]) => !/[.!?…]$/.test(short))
    .map(([key, , short]) => `${key}: "…${short.slice(-45)}"`);
  expect(broken, `these tooltips break off mid-sentence — ${broken.join('; ')}`).toEqual([]);
});

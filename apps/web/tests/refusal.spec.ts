import { test, expect } from '@playwright/test';
import { refusalText } from '../src/components/refusal';

// The rule the screens now follow when the server says no. Pure function, no browser: what
// matters is the ORDER of the three answers, and that the last one still works.
//
// Until this existed every refusal was printed in English, whatever language the reader had
// chosen — «Bid items required» on an Azerbaijani screen. The fix is a code beside the
// message, so the fallback is the half that must not break: a refusal nobody has translated
// yet has to read exactly as it did before, or adding a code to a throw would be a way of
// losing a sentence.
const dict: Record<string, string> = {
  err_BID_ITEMS_REQUIRED: 'Впишите цену хотя бы в одну позицию.',
  err_CATALOG_BELOW_MOQ: 'Минимальная партия — {moq} ({item}), а в заказе меньше.',
};
const t = (k: string) => dict[k] ?? k;
const refusal = (data: unknown) => ({ response: { data } });

test('a translated code wins over the English message', () => {
  expect(refusalText(t, refusal({ code: 'BID_ITEMS_REQUIRED', message: 'Bid items required' })))
    .toBe('Впишите цену хотя бы в одну позицию.');
});

test('the numbers the English sentence carried survive the translation', () => {
  // «Below MOQ (5) for A4 kağız» said WHICH minimum; a translation without it would be
  // poorer than the text it replaces, which is the one thing a translation must not be.
  expect(refusalText(t, refusal({ code: 'CATALOG_BELOW_MOQ', moq: 5, item: 'A4 kağız', message: 'Below MOQ (5) for A4 kağız' })))
    .toBe('Минимальная партия — 5 (A4 kağız), а в заказе меньше.');
  // a field the server did not send leaves no empty brackets behind
  expect(refusalText(t, refusal({ code: 'CATALOG_BELOW_MOQ', moq: 5, message: 'Below MOQ (5)' })))
    .toBe('Минимальная партия — 5, а в заказе меньше.');
});

test('a code with no translation yet falls back to the message, not to the key', () => {
  const said = refusalText(t, refusal({ code: 'SOMETHING_NEW', message: 'Order not found' }));
  expect(said).toBe('Order not found');
  expect(said).not.toContain('err_');
});

test('no code at all still says what the server said', () => {
  expect(refusalText(t, refusal({ message: 'Only the buyer records receipts' })))
    .toBe('Only the buyer records receipts');
  // validation errors arrive as a list
  expect(refusalText(t, refusal({ message: ['qty must be positive', 'name should not be empty'] })))
    .toBe('qty must be positive. name should not be empty');
});

test('nothing usable anywhere leaves the generic line', () => {
  expect(refusalText(t, {})).toBe('error_generic');
});

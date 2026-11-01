import { expect, type Page } from '@playwright/test';

// The product's own dialogs replaced the browser's alert / prompt / confirm, so the specs
// no longer wait for a `dialog` event: a message now arrives as a toast inside the page and
// a question is a form inside it.
//
// Addressed by testid rather than by label on purpose — these flows run in all three
// languages, and the buttons are translated now, which is the whole reason the native boxes
// had to go.

/** Answers the open question and confirms it. */
export async function answerDialog(page: Page, text: string, expectText?: string | RegExp) {
  const input = page.getByTestId('dialog-input');
  await expect(input).toBeVisible();
  if (expectText) await expect(page.getByRole('dialog')).toContainText(expectText);
  await input.fill(text);
  await page.getByTestId('dialog-confirm').click();
  await expect(input).toHaveCount(0);
}

/** Backs out of the open question; nothing must be sent. */
export async function cancelDialog(page: Page, expectText?: string | RegExp) {
  const input = page.getByTestId('dialog-input');
  await expect(input).toBeVisible();
  if (expectText) await expect(page.getByRole('dialog')).toContainText(expectText);
  await page.getByTestId('dialog-cancel').click();
  await expect(input).toHaveCount(0);
}

/**
 * Waits for the message and then closes it. Closing is part of the assertion: an error
 * toast never fades on its own (an error nobody saw is the one that mattered), so a stale
 * one would still be on screen for whatever the test checks next.
 */
export async function expectToast(page: Page, text: string | RegExp) {
  const toast = page.getByTestId('toast').filter({ hasText: text });
  await expect(toast).toBeVisible();
  await toast.getByRole('button').click();
  await expect(toast).toHaveCount(0);
}

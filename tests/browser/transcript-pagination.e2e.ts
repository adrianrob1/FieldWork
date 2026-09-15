import type { Locator } from '@playwright/test';

import { expect, test } from './server.js';
import { longChatId, longChatMessageCount } from './fixture.js';

async function topOf(locator: Locator): Promise<number> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('element has no bounding box');
  return box.y;
}

test.use({ fixtureOptions: { longChat: true } });

test('load earlier prepends older messages and keeps the viewport anchor', async ({
  page,
  sidecar,
}) => {
  await page.goto(sidecar.url(`/chats/${longChatId}`));
  const messages = page.getByTestId(/^msg-\d+$/);
  const loadEarlier = page.getByTestId('load-earlier');

  // Newest window only.
  await expect(messages).toHaveCount(14);
  await expect(
    page.getByTestId(`msg-${longChatMessageCount - 1}`),
  ).toBeVisible();
  await expect(page.getByTestId('msg-18')).toBeVisible();
  await expect(page.getByTestId('msg-17')).toHaveCount(0);

  // First prepend: an anchored middle message keeps its viewport position.
  await loadEarlier.scrollIntoViewIfNeeded();
  const before = await topOf(page.getByTestId('msg-20'));
  await loadEarlier.click();
  await expect(messages).toHaveCount(28);
  const after = await topOf(page.getByTestId('msg-20'));
  expect(Math.abs(after - before)).toBeLessThan(5);
  await expect(page.getByTestId('msg-4')).toBeVisible();

  // Second prepend reaches the beginning and retires the control.
  await loadEarlier.scrollIntoViewIfNeeded();
  await loadEarlier.click();
  await expect(messages).toHaveCount(longChatMessageCount);
  await expect(loadEarlier).toHaveCount(0);
  await expect(page.getByTestId('msg-0')).toBeVisible();
});

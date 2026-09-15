import { expect } from '@playwright/test';

import { test } from './server.js';

test('Ctrl+F navigates to search and focuses the input; the hint matches the platform', async ({
  page,
  sidecar,
}) => {
  await page.goto(sidecar.baseUrl, { waitUntil: 'networkidle' });

  const hint = await page.textContent('[data-testid="search-button"]');
  const mac = await page.evaluate(() =>
    /mac|iphone|ipad|ipod/i.test(
      `${navigator.platform} ${navigator.userAgent}`,
    ),
  );
  expect(hint).toContain(mac ? '⌘F' : 'Ctrl+F');

  await page.keyboard.press('Control+f');
  await page.waitForURL(/\/search$/);
  await expect(page.locator('[data-testid="search-input"]')).toBeFocused();

  await page.locator('[data-testid="search-input"]').fill('matrix');
  await page.keyboard.press('Escape');
  await page.mouse.click(20, 700);
  await expect(page.locator('[data-testid="search-input"]')).not.toBeFocused();
  await page.keyboard.press('Control+f');
  await expect(page.locator('[data-testid="search-input"]')).toBeFocused();
  await expect(page.locator('[data-testid="search-input"]')).toHaveValue(
    'matrix',
  );
});

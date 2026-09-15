import { expect } from '@playwright/test';

import { test } from './server.js';

test('editor keeps a back button at desktop and mobile widths', async ({
  page,
  sidecar,
}) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`${sidecar.baseUrl}/`, { waitUntil: 'networkidle' });
    await page.goto(
      `${sidecar.baseUrl}/edit?path=${encodeURIComponent('projects/evolutionary-optimization/README.md')}`,
      { waitUntil: 'networkidle' },
    );
    const back = page.locator('[data-testid="back-button"]');
    await expect(back).toBeVisible();
    // Full loads have no in-app history: back falls back to the parent.
    await back.click();
    await expect(page).toHaveURL(/\/$/);
  }
});

test('editor back returns to the in-app origin', async ({ page, sidecar }) => {
  await page.goto(`${sidecar.baseUrl}/search`, { waitUntil: 'networkidle' });
  await page.locator('[data-testid="search-input"]').fill('matrix');
  await page.locator('[data-testid="search-input"]').press('Enter');
  const hit = page.locator('[data-testid="search-hit"]').first();
  await hit.click();
  await expect(page).toHaveURL(/\/edit\?path=/);
  await page.locator('[data-testid="back-button"]').click();
  await expect(page).toHaveURL(/\/search\?/);
});

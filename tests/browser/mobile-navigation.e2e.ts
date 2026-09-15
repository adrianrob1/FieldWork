import { expect, test } from './server.js';

test.use({ viewport: { width: 390, height: 844 } });

test('mobile navigation: list/detail, drawer focus, single pane, and theme', async ({
  page,
  sidecar,
}) => {
  const listPane = page.getByTestId('list-pane');
  const drawer = page.getByTestId('drawer');

  // Projects are single-pane at this width: the side list is hidden and the
  // table is the navigation surface.
  await page.goto(sidecar.url('/projects'));
  await expect(listPane).toBeHidden();
  const projectRow = page.getByTestId('project-row-project_soap_bubbles');
  await expect(projectRow).toBeVisible();
  await projectRow.click();
  await page.waitForURL(/\/projects\/project_soap_bubbles$/);
  await expect(page.getByTestId('content-pane')).toBeVisible();
  await expect(listPane).toBeHidden();

  // Back returns to the projects list.
  await page.getByTestId('back-button').click();
  await page.waitForURL((url) => url.pathname === '/projects');

  // Drawer opens, Escape closes it, and focus returns to the hamburger.
  await expect(drawer).toHaveAttribute('aria-hidden', 'true');
  await page.getByTestId('drawer-button').click();
  await expect(drawer).toHaveAttribute('aria-hidden', 'false');
  // Search leads the drawer nav, and the removed Context view is absent.
  await expect(drawer.locator('.dgrp a').first()).toHaveAttribute(
    'href',
    '/search',
  );
  await expect(drawer.locator('a[href="/context"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveAttribute('aria-hidden', 'true');
  await expect
    .poll(() =>
      page.evaluate(
        () => document.activeElement?.getAttribute('data-testid') ?? null,
      ),
    )
    .toBe('drawer-button');

  // The drawer navigates to Tasks.
  await page.getByTestId('drawer-button').click();
  await expect(drawer).toHaveAttribute('aria-hidden', 'false');
  await drawer.locator('a[href="/tasks"]').click();
  await page.waitForURL((url) => url.pathname === '/tasks');

  // Chats are single-pane too: list visible on /chats, hidden on a detail.
  await page.goto(sidecar.url('/chats'));
  await expect(listPane).toBeVisible();
  await page.getByTestId('chat-row-chat_shared_curvature').click();
  await page.waitForURL(/\/chats\/chat_shared_curvature/);
  await expect(listPane).toBeHidden();

  // The theme toggle inside the drawer flips the document theme.
  await page.goto(sidecar.url('/tasks'));
  await page.getByTestId('drawer-button').click();
  await expect(drawer).toHaveAttribute('aria-hidden', 'false');
  const before = await page.evaluate(
    () => document.documentElement.dataset.theme,
  );
  await drawer.locator('[data-theme-toggle]').click();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.dataset.theme ?? null),
    )
    .not.toBe(before);
});

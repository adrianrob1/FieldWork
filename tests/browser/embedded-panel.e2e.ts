import { expect, test } from './server.js';

// The desktop /chats content pane embeds the new-chat start panel, so drafting
// does not require leaving the two-pane view. Below the mobile breakpoint the
// route stays a pure list and drafts open on the dedicated /chats/new route.

function pathnameOf(page: { url(): string }): string {
  return new URL(page.url()).pathname;
}

test('desktop /chats embeds the start panel and drafts in place', async ({
  page,
  sidecar,
}) => {
  await page.goto(sidecar.url('/chats'));

  // The old empty-state placeholder is gone; the start panel is the content.
  await expect(page.getByTestId('composer-input')).toBeVisible();
  await expect(page.getByText('Select a chat')).toHaveCount(0);

  const input = page.getByTestId('composer-input');
  await input.fill('Embedded panel draft');
  await page.waitForURL(/\/chats\?draft=/);
  expect(pathnameOf(page)).toBe('/chats');

  // Reload refetches the list (the draft row appears) and restores the draft
  // text inside the embedded panel.
  await page.reload();
  await expect(page.getByTestId('composer-input')).toHaveValue(
    'Embedded panel draft',
  );
  await expect(
    page.locator('[data-testid^="draft-row-"]').first(),
  ).toBeVisible();

  // A desktop draft-row click stays on /chats and keeps the panel loaded.
  await page.locator('[data-testid^="draft-row-"]').first().click();
  await expect(page.getByTestId('composer-input')).toHaveValue(
    'Embedded panel draft',
  );
  expect(pathnameOf(page)).toBe('/chats');
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('/chats stays a list and draft rows open /chats/new', async ({
    page,
    sidecar,
  }) => {
    await page.goto(sidecar.url('/chats'));

    // Nothing of the embedded panel is visible on the list route.
    await expect(page.getByTestId('composer-input')).toBeHidden();
    await expect(page.getByTestId('list-pane')).toBeVisible();

    // The New chat entry (drawer on mobile) still reaches /chats/new. The
    // hidden embedded panel can still auto-resume a leftover draft and
    // replace-navigate shortly after load; wait for the network to settle so
    // that search-only navigation cannot close the drawer mid-click.
    const drawer = page.getByTestId('drawer');
    await expect(drawer).toHaveAttribute('aria-hidden', 'true');
    await page.waitForLoadState('networkidle');
    await page.getByTestId('drawer-button').dispatchEvent('click');
    await expect(drawer).toHaveAttribute('aria-hidden', 'false');
    await drawer.locator('a[href="/chats/new"]').click();
    await page.waitForURL((url) => url.pathname === '/chats/new');
    await expect(page.getByTestId('composer-input')).toBeVisible();

    const input = page.getByTestId('composer-input');
    await input.fill('Mobile draft');
    await page.waitForURL(/\/chats\/new\?draft=/);
    const draftId = new URL(page.url()).searchParams.get('draft') ?? '';
    expect(draftId).not.toBe('');

    // Back on the list, the draft row opens the dedicated new-chat route.
    await page.goto(sidecar.url('/chats'));
    await page.getByTestId(`draft-row-${draftId}`).click();
    await page.waitForURL(new RegExp(`/chats/new\\?draft=${draftId}`));
    expect(pathnameOf(page)).toBe('/chats/new');
  });
});

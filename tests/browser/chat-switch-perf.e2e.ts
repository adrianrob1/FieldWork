import { expect, test } from './server.js';

// Switching chats keeps the app chrome: the AppShell and its list pane are
// mounted once per route, so the same list DOM node (and its fetch state)
// survives while only the conversation subtree swaps. These assertions cover
// node identity, zero list/drafts refetches, and the content swap.

test('switching chats keeps the list pane node and does not refetch the list', async ({
  page,
  sidecar,
}) => {
  await page.goto(sidecar.url('/chats/chat_lab_agenda'));
  await expect(page.getByTestId('chat-thread')).toBeVisible();
  await expect(page.getByTestId('chat-row-chat_lab_agenda')).toBeVisible();

  // Stash a reference to the list pane node. A remount would drop this
  // identity because the old document handle would be detached.
  await page.evaluate(() => {
    const node = document.querySelector('[data-testid="list-pane"]');
    (window as unknown as { __listPane?: Element | null }).__listPane = node;
  });

  const requests: string[] = [];
  page.on('request', (request) => {
    requests.push(request.url());
  });

  await page.getByTestId('chat-row-chat_shared_curvature').click();
  await page.waitForURL(/\/chats\/chat_shared_curvature$/);
  await expect(page.getByTestId('chat-header')).toContainText(
    'Shared curvature statistics',
  );

  // The list pane is the very same DOM node, still connected.
  const identity = await page.evaluate(() => {
    const stash = (window as unknown as { __listPane?: Element | null })
      .__listPane;
    return {
      same: stash === document.querySelector('[data-testid="list-pane"]'),
      connected: stash?.isConnected === true,
    };
  });
  expect(identity.same).toBe(true);
  expect(identity.connected).toBe(true);

  // The conversation refetched its own detail...
  expect(
    requests.some((url) => url.includes('/api/chats/chat_shared_curvature?')),
  ).toBe(true);
  // ...but the list and drafts resources did not refire.
  const refetches = requests.filter(
    (url) => url.includes('/api/chats?view=') || url.includes('/api/drafts'),
  );
  expect(refetches).toEqual([]);
});

test('the conversation content swaps with the route', async ({
  page,
  sidecar,
}) => {
  await page.goto(sidecar.url('/chats/chat_lab_agenda'));
  await expect(page.getByTestId('chat-thread')).toContainText(
    "Please draft the agenda for Thursday's lab meeting.",
  );

  await page.getByTestId('chat-row-chat_rank_diagnostics').click();
  await page.waitForURL(/\/chats\/chat_rank_diagnostics$/);
  await expect(page.getByTestId('chat-header')).toContainText(
    'Rank diagnostics',
  );
  await expect(page.getByTestId('chat-thread')).not.toContainText(
    "Please draft the agenda for Thursday's lab meeting.",
  );
});

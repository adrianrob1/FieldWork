import { expect, test } from './server.js';

// The chat thread's side pane is the same "All chats" list as /chats, with the
// current thread marked. These assertions cover the live rows, the draft-first
// ordering, and that the marker follows navigation.

test('chat thread list pane mirrors /chats and marks the current row', async ({
  page,
  sidecar,
}) => {
  // Create a stored draft so the draft-first ordering is deterministic.
  await page.goto(sidecar.url('/chats/new'));
  const input = page.getByTestId('composer-input');
  await expect(input).toBeVisible();
  await input.fill('List pane ordering draft');
  await page.waitForURL(/\/chats\/new\?draft=/);

  await page.goto(sidecar.url('/chats'));
  const listPane = page.getByTestId('list-pane');
  await expect(listPane).toBeVisible();

  const chatRows = listPane.locator('[data-testid^="chat-row-"]');
  const draftRows = listPane.locator('[data-testid^="draft-row-"]');
  await expect(chatRows.first()).toBeVisible();
  expect(await chatRows.count()).toBeGreaterThan(0);
  expect(await draftRows.count()).toBeGreaterThan(0);

  // Draft rows are rendered above every chat row.
  const order = await listPane.evaluate(() =>
    Array.from(
      document.querySelectorAll(
        '[data-testid^="draft-row-"], [data-testid^="chat-row-"]',
      ),
    ).map((element) => element.getAttribute('data-testid') ?? ''),
  );
  const firstChat = order.findIndex((id) => id.startsWith('chat-row-'));
  const lastDraft = order.reduce(
    (last, id, index) => (id.startsWith('draft-row-') ? index : last),
    -1,
  );
  expect(firstChat).toBeGreaterThan(-1);
  expect(lastDraft).toBeGreaterThan(-1);
  expect(lastDraft).toBeLessThan(firstChat);

  // Open a chat; the thread's pane keeps the rows and marks the current one.
  const firstId = (await chatRows.first().getAttribute('data-testid')) ?? '';
  const firstChatId = firstId.replace('chat-row-', '');
  await chatRows.first().click();
  await page.waitForURL(new RegExp(`/chats/${firstChatId}$`));
  await expect(listPane).toBeVisible();
  await expect(
    listPane.locator('[data-testid^="chat-row-"]').first(),
  ).toBeVisible();
  expect(
    await listPane.locator('[data-testid^="chat-row-"]').count(),
  ).toBeGreaterThan(0);
  await expect(page.getByTestId(`chat-row-${firstChatId}`)).toHaveClass(
    /\bon\b/,
  );

  // Switch to another chat from the pane; the marker moves with the route.
  const otherChatId =
    firstChatId === 'chat_lab_agenda'
      ? 'chat_shared_curvature'
      : 'chat_lab_agenda';
  await page.getByTestId(`chat-row-${otherChatId}`).click();
  await page.waitForURL(new RegExp(`/chats/${otherChatId}$`));
  await expect(page.getByTestId(`chat-row-${otherChatId}`)).toHaveClass(
    /\bon\b/,
  );
  await expect(page.getByTestId(`chat-row-${firstChatId}`)).not.toHaveClass(
    /\bon\b/,
  );
});

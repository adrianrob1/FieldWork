import { expect, test } from './server.js';
import { draftList } from './helpers.js';

const streamParts = ['Draft ', 'streamed ', 'assistant ', 'reply ', 'growing.'];
const finalReply = streamParts.join('');

test.use({
  fixtureOptions: {
    stubBackend: true,
    streamParts,
    streamDelayMs: 220,
  },
});

test('a fresh draft navigates to the chat before the reply finishes', async ({
  page,
  sidecar,
}) => {
  const leftovers = draftList((await sidecar.api.get('/api/drafts')).body);
  for (const draft of leftovers) {
    const id = draft.id;
    if (typeof id === 'string') {
      await sidecar.api.post(`/api/drafts/${encodeURIComponent(id)}/discard`);
    }
  }

  const message = 'Streaming draft first message';
  await page.goto(sidecar.url('/chats/new'));
  await page.getByTestId('composer-input').fill(message);
  await page.waitForURL(/\/chats\/new\?draft=/);
  await page.getByTestId('send-button').click();

  // The created event moves the user to the chat route immediately.
  await page.waitForURL(
    (url) =>
      url.pathname.startsWith('/chats/') && url.pathname !== '/chats/new',
  );
  const chatId = new URL(page.url()).pathname.split('/').pop() ?? '';
  expect(chatId).not.toBe('');

  const bubble = page.getByTestId('stream-bubble');
  await expect(bubble).toBeVisible();
  const first = await bubble.innerText();
  await expect
    .poll(async () => (await bubble.innerText()).length, {
      timeout: 10_000,
      intervals: [50, 100, 150],
    })
    .toBeGreaterThan(first.length);

  // The real transcript replaces the provisional view.
  await expect(page.getByTestId('stream-bubble')).toHaveCount(0);
  await expect(page.getByTestId('chat-thread')).toContainText(finalReply);
  await expect(
    page.getByTestId('chat-header').getByTestId('chat-title'),
  ).toHaveText(message);

  const detail = await sidecar.api.get(
    `/api/chats/${encodeURIComponent(chatId)}`,
  );
  expect(detail.status).toBe(200);

  // The chat appears in the list and the draft row is gone.
  await page.goto(sidecar.url('/chats'));
  await expect(page.getByTestId(`chat-row-${chatId}`)).toBeVisible();
  await expect
    .poll(
      async () => draftList((await sidecar.api.get('/api/drafts')).body).length,
      { timeout: 10_000 },
    )
    .toBe(0);
});

test('stopping a streaming draft submit restores the draft and creates no chat', async ({
  page,
  sidecar,
}) => {
  const leftovers = draftList((await sidecar.api.get('/api/drafts')).body);
  for (const draft of leftovers) {
    const id = draft.id;
    if (typeof id === 'string') {
      await sidecar.api.post(`/api/drafts/${encodeURIComponent(id)}/discard`);
    }
  }

  const message = 'Stop the streaming draft';
  await page.goto(sidecar.url('/chats/new'));
  await page.getByTestId('composer-input').fill(message);
  await page.waitForURL(/\/chats\/new\?draft=/);
  const draftId = new URL(page.url()).searchParams.get('draft') ?? '';
  expect(draftId).not.toBe('');
  await page.getByTestId('send-button').click();

  // The created event moves to the chat route while the reply is still
  // streaming; the provisional view owns a Stop that cancels the submit.
  await page.waitForURL(
    (url) =>
      url.pathname.startsWith('/chats/') && url.pathname !== '/chats/new',
  );
  const chatId = new URL(page.url()).pathname.split('/').pop() ?? '';
  expect(chatId).not.toBe('');
  await expect(page.getByTestId('stream-bubble')).toBeVisible();
  await page.getByTestId('draft-stop').click();

  // Back on the start screen with the draft text intact.
  await page.waitForURL(
    (url) => url.pathname === '/chats' || url.pathname === '/chats/new',
  );
  await expect(page.getByTestId('composer-input')).toHaveValue(message);

  // No chat was created and the draft is untouched.
  const detail = await sidecar.api.get(
    `/api/chats/${encodeURIComponent(chatId)}`,
  );
  expect(detail.status).toBe(404);
  const drafts = draftList((await sidecar.api.get('/api/drafts')).body);
  expect(drafts.some((entry) => entry.id === draftId)).toBe(true);
});

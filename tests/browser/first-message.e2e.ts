import { existsSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from './server.js';
import { stubReply } from './fixture.js';
import { chatPath, draftList } from './helpers.js';

test.use({ fixtureOptions: { stubBackend: true } });

test('first message starts a chat, the stub answers, and the draft is consumed', async ({
  sidecar,
  page,
}) => {
  // Isolate: the sample workspace has no drafts, but discard anything left over.
  const leftovers = draftList((await sidecar.api.get('/api/drafts')).body);
  for (const draft of leftovers) {
    const id = draft.id;
    if (typeof id === 'string') {
      await sidecar.api.post(`/api/drafts/${encodeURIComponent(id)}/discard`);
    }
  }

  const title = 'Stub backend smoke test';
  await page.goto(sidecar.url('/chats/new'));
  await page.getByTestId('composer-input').fill(title);
  await page.waitForURL(/\/chats\/new\?draft=/);
  await page.getByTestId('send-button').click();
  await page.waitForURL(
    (url) =>
      url.pathname.startsWith('/chats/') && url.pathname !== '/chats/new',
  );

  const chatId = new URL(page.url()).pathname.split('/').pop() ?? '';
  expect(chatId).not.toBe('');

  // The canonical chat shows the user message and the stub's answer.
  await expect(
    page.getByTestId('chat-header').getByTestId('chat-title'),
  ).toHaveText(title);
  await expect(page.getByTestId('msg-0')).toContainText(title);
  await expect(page.getByTestId('msg-1')).toContainText(stubReply);

  // The draft is consumed, so no leftovers remain.
  await expect
    .poll(
      async () => draftList((await sidecar.api.get('/api/drafts')).body).length,
    )
    .toBe(0);

  // The transcript exists on disk in the temp workspace.
  const detail = await sidecar.api.get(`/api/chats/${chatId}`);
  const storedPath = chatPath(detail.body);
  expect(storedPath).not.toBeNull();
  const absolute = path.join(sidecar.root, ...String(storedPath).split('/'));
  expect(existsSync(absolute)).toBe(true);
});

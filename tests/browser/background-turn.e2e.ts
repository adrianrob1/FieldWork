import { expect, test } from './server.js';

// Long enough that a mid-turn round trip through another route always lands
// while the reply is still streaming.
const streamParts = [
  'Background ',
  ...Array.from({ length: 30 }, (_, index) => `segment ${String(index)} `),
];
const lastSegment = 'segment 29';

test.use({
  fixtureOptions: {
    stubBackend: true,
    streamParts,
    streamDelayMs: 70,
  },
});

async function readTranscriptTexts(
  api: { get(route: string): Promise<{ status: number; body: unknown }> },
  chatId: string,
): Promise<string[]> {
  const detail = await api.get(`/api/chats/${chatId}`);
  const body = detail.body as { messages?: Array<{ text?: string }> };
  return (body.messages ?? []).map((message) => message.text ?? '');
}

test('mid-turn navigation re-attaches to the live stream and shows the committed turn', async ({
  page,
  sidecar,
}) => {
  await page.goto(sidecar.url('/chats/chat_lab_agenda'));
  await expect(page.getByTestId('chat-thread')).toBeVisible();

  const message = 'Keep answering while I wander.';
  await page.getByTestId('composer-input').fill(message);
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('stream-bubble')).toBeVisible();

  // In-app navigation only: a document unload aborts the fetch and the server
  // cancels the turn by design, so move by clicking the app's own links.
  await page.getByTestId('chat-row-chat_shared_curvature').click();
  await page.waitForURL(/\/chats\/chat_shared_curvature$/);
  await expect(page.getByTestId('stream-bubble')).toHaveCount(0);

  await page.getByTestId('chat-row-chat_lab_agenda').click();
  await page.waitForURL(/\/chats\/chat_lab_agenda$/);

  // The pending turn re-attaches: user text, live bubble, and the Stop button.
  await expect(page.getByTestId('stream-bubble')).toBeVisible();
  await expect(page.getByTestId('chat-thread')).toContainText(message);
  await expect(page.getByTestId('draft-stop')).toBeVisible();

  // The reply finishes under the re-attached view and the committed turn
  // replaces the provisional one.
  await expect(page.getByTestId('stream-bubble')).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page.getByTestId('chat-thread')).toContainText(lastSegment);

  // The exchange landed in the canonical transcript.
  await expect
    .poll(
      async () =>
        (await readTranscriptTexts(sidecar.api, 'chat_lab_agenda')).some(
          (text) => text === message,
        ),
      { timeout: 10_000 },
    )
    .toBe(true);
});

test('a turn sent before navigating away commits in the background', async ({
  page,
  sidecar,
}) => {
  await page.goto(sidecar.url('/chats/chat_lab_agenda'));
  await expect(page.getByTestId('chat-thread')).toBeVisible();

  const message = 'Finish this while I am elsewhere.';
  await page.getByTestId('composer-input').fill(message);
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('stream-bubble')).toBeVisible();

  await page.getByTestId('chat-row-chat_shared_curvature').click();
  await page.waitForURL(/\/chats\/chat_shared_curvature$/);

  // No UI observes the turn, yet the server still commits it.
  await expect
    .poll(
      async () => {
        const texts = await readTranscriptTexts(sidecar.api, 'chat_lab_agenda');
        return (
          texts.some((text) => text === message) &&
          texts.some((text) => text.includes(lastSegment))
        );
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  // Returning loads the committed exchange without any reload.
  await page.getByTestId('chat-row-chat_lab_agenda').click();
  await page.waitForURL(/\/chats\/chat_lab_agenda$/);
  const thread = page.getByTestId('chat-thread');
  await expect(thread).toContainText(message);
  await expect(thread).toContainText(lastSegment);
});

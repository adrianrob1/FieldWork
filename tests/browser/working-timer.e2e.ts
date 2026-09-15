import { expect, test } from './server.js';

const streamParts = ['Answer ', 'arrives ', 'after ', 'the ', 'delay.'];
const finalReply = streamParts.join('');

// A long pre-first-delta phase so the working timer can be observed before any
// answer text lands.
test.use({
  fixtureOptions: {
    stubBackend: true,
    streamParts,
    streamDelayMs: 120,
    streamFirstDelayMs: 4500,
  },
});

function secondsOf(label: string): number {
  const match = /(\d+)s/.exec(label);
  return match === null ? -1 : Number(match[1]);
}

test('the streaming bubble shows a working timer before the first delta', async ({
  page,
  sidecar,
}) => {
  await page.goto(sidecar.url('/chats/chat_lab_agenda'));
  await expect(page.getByTestId('chat-thread')).toBeVisible();

  const input = page.getByTestId('composer-input');
  const send = page.getByTestId('composer-send');
  await input.fill('Time this reply please.');
  await expect(send).toBeEnabled();
  await send.click();

  // The bubble and its timer appear at send, before the first delta.
  const bubble = page.getByTestId('stream-bubble');
  const timer = page.getByTestId('stream-working');
  await expect(bubble).toBeVisible();
  await expect(timer).toBeVisible();
  await expect(page.getByTestId('stream-message')).toHaveCount(0);

  const firstLabel = await timer.innerText();
  expect(firstLabel).toMatch(/^Working for \d+s$/);
  expect(secondsOf(firstLabel)).toBeGreaterThanOrEqual(0);

  // The timer advances while the first delta is still delayed.
  await expect
    .poll(async () => secondsOf(await timer.innerText()), {
      timeout: 4_000,
      intervals: [150, 200, 250],
    })
    .toBeGreaterThan(secondsOf(firstLabel));
  await expect(page.getByTestId('stream-message')).toHaveCount(0);

  // The committed reply replaces the bubble; the timer goes with it.
  await expect(page.getByTestId('stream-bubble')).toHaveCount(0, {
    timeout: 20_000,
  });
  await expect(page.getByTestId('chat-thread')).toContainText(finalReply);
  await expect(page.getByTestId('stream-working')).toHaveCount(0);
});

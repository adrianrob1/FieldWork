import type { Page } from '@playwright/test';

import { expect, test } from './server.js';
import { longChatId } from './fixture.js';

const streamParts = [
  'Counting ',
  'down ',
  'through ',
  'a ',
  'few ',
  'streamed ',
  'chunks ',
  'to ',
  'observe ',
  'sticking.',
];

test.use({
  fixtureOptions: {
    longChat: true,
    stubBackend: true,
    streamParts,
    streamDelayMs: 160,
  },
});

interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

async function metrics(page: Page): Promise<ScrollMetrics> {
  return page.evaluate(() => {
    const element = document.querySelector<HTMLElement>(
      '[data-testid="chat-thread-scroll"]',
    );
    if (element === null) throw new Error('missing thread scroller');
    return {
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    };
  });
}

function distanceFromBottom(value: ScrollMetrics): number {
  return value.scrollHeight - value.scrollTop - value.clientHeight;
}

async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>(
      '[data-testid="chat-thread-scroll"]',
    );
    if (element !== null) element.scrollTop = element.scrollHeight;
  });
}

async function scrollUpBy(page: Page, amount: number): Promise<void> {
  await page.evaluate((by) => {
    const element = document.querySelector<HTMLElement>(
      '[data-testid="chat-thread-scroll"]',
    );
    if (element !== null) {
      element.scrollTop = Math.max(0, element.scrollTop - by);
    }
  }, amount);
}

test('stays pinned at the bottom on append and on send, but not while reading', async ({
  page,
  sidecar,
}) => {
  await page.goto(sidecar.url(`/chats/${longChatId}`));
  await expect(page.getByTestId('chat-thread')).toBeVisible();
  await expect(page.getByTestId('load-earlier')).toBeVisible();

  // Land at the newest turn.
  await scrollToBottom(page);
  await expect
    .poll(async () => distanceFromBottom(await metrics(page)))
    .toBeLessThanOrEqual(5);

  const input = page.getByTestId('composer-input');
  const send = page.getByTestId('composer-send');

  // Send at the bottom: the reply lands and the viewport stays pinned.
  await input.fill('First scroll question.');
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByTestId('stream-bubble')).toBeVisible();
  await expect(page.getByTestId('stream-bubble')).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect
    .poll(async () => distanceFromBottom(await metrics(page)))
    .toBeLessThanOrEqual(5);

  // Scroll up, then send: sending jumps back to the reader's own message.
  await scrollUpBy(page, 400);
  await expect
    .poll(async () => distanceFromBottom(await metrics(page)))
    .toBeGreaterThan(300);
  await input.fill('Second scroll question.');
  await expect(send).toBeEnabled();
  await send.click();
  await expect
    .poll(async () => distanceFromBottom(await metrics(page)), {
      timeout: 5_000,
    })
    .toBeLessThanOrEqual(5);

  // While the reply streams, scroll up: deltas must not yank the viewport back.
  const bubble = page.getByTestId('stream-bubble');
  await expect(bubble).toBeVisible();
  await expect
    .poll(async () => (await bubble.innerText()).length, {
      timeout: 10_000,
    })
    .toBeGreaterThan(0);
  await scrollUpBy(page, 400);
  const reading = await metrics(page);
  expect(distanceFromBottom(reading)).toBeGreaterThan(300);
  await page.waitForTimeout(500);
  const afterDeltas = await metrics(page);
  expect(distanceFromBottom(afterDeltas)).toBeGreaterThan(250);
  // More content arrived below the viewport (distance grew) rather than the
  // viewport being pinned back to the bottom.
  expect(afterDeltas.scrollHeight).toBeGreaterThanOrEqual(reading.scrollHeight);
});

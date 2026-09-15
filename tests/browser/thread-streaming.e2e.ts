import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, test } from './server.js';

// Long enough that the streaming bubble overflows its capped viewport and a
// stop click always lands mid-stream.
const streamParts = [
  'Streaming ',
  ...Array.from(
    { length: 30 },
    (_, index) => `segment ${String(index)} ${'word '.repeat(40)}`,
  ),
];
const finalReply = streamParts.join('');
const thoughtParts = ['Pondering ', 'the ', 'options ', 'quietly. '];
const finalThought = thoughtParts.join('');

test.use({
  fixtureOptions: {
    stubBackend: true,
    streamParts,
    streamDelayMs: 70,
    thoughtParts,
    thoughtDelayMs: 120,
  },
});

test('thinking streams first, then message text, then the committed turn replaces both', async ({
  page,
  sidecar,
}) => {
  await page.goto(sidecar.url('/chats/chat_lab_agenda'));
  await expect(page.getByTestId('chat-thread')).toBeVisible();

  const input = page.getByTestId('composer-input');
  const send = page.getByTestId('composer-send');
  await input.fill('Stream this please.');
  await expect(send).toBeEnabled();
  await send.click();

  const bubble = page.getByTestId('stream-bubble');
  await expect(bubble).toBeVisible();

  // The reasoning phase renders in the Thinking region before any answer text.
  const thinking = page.getByTestId('stream-thought');
  await expect(thinking).toBeVisible();
  await expect(page.getByTestId('stream-thought-toggle')).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  // Message text has not started while only reasoning is arriving.
  await expect(page.getByTestId('stream-message')).toHaveCount(0);
  const firstThought = (await thinking.innerText()).length;
  await expect
    .poll(async () => (await thinking.innerText()).length, {
      timeout: 10_000,
      intervals: [50, 100, 150],
    })
    .toBeGreaterThan(firstThought);
  await expect(page.getByTestId('stream-message')).toHaveCount(0);

  // The answer then streams into the bubble while the Thinking region is still
  // mounted.
  await expect(page.getByTestId('stream-message')).toBeVisible();
  await expect(bubble).toContainText('Streaming');

  // The toggle collapses the region.
  await page.getByTestId('stream-thought-toggle').click({ force: true });
  await expect(page.getByTestId('stream-thought')).toHaveCount(0);

  // The committed assistant message replaces the provisional bubble; the
  // reasoning survives as a collapsed trace under the reply, so its text is
  // hidden until expanded.
  await expect(page.getByTestId('stream-bubble')).toHaveCount(0);
  await expect(page.getByTestId('stream-thought')).toHaveCount(0);
  await expect(page.getByTestId('chat-thread')).toContainText('segment 29');
  await expect(page.getByTestId('chat-thread')).not.toContainText(finalThought);
  await expect(page.getByTestId('chat-thread')).not.toContainText('Pondering');
  const committedTrace = page.locator(
    '[data-testid^="msg-thought-"][data-testid$="-toggle"]',
  );
  await expect(committedTrace).toHaveCount(1);
  await expect(committedTrace).toHaveAttribute('aria-expanded', 'false');

  // Expanding the collapsed trace shows the recorded reasoning.
  await committedTrace.click({ force: true });
  await expect(committedTrace).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('chat-thread')).toContainText(
    'Pondering the options quietly.',
  );

  // The composer adopted the new content hash, so a second send is accepted.
  await input.fill('Second question.');
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByTestId('stream-bubble')).toBeVisible();
  await expect(page.getByTestId('stream-bubble')).toHaveCount(0, {
    timeout: 15_000,
  });

  // The first user message is persisted in the canonical transcript.
  await expect
    .poll(
      async () => {
        const detail = await sidecar.api.get('/api/chats/chat_lab_agenda');
        const body = detail.body as {
          messages?: Array<{ text?: string }>;
        };
        return body.messages?.some(
          (message) => message.text === 'Stream this please.',
        );
      },
      { timeout: 10_000 },
    )
    .toBe(true);

  // The backend was asked for a streamed completion.
  expect(sidecar.stub?.streamRequests().some((entry) => entry)).toBe(true);
  expect(finalReply.length).toBeGreaterThan(0);
});

test('caps the streaming bubble at the scroller and follows its inner growth', async ({
  page,
  sidecar,
}) => {
  await page.goto(sidecar.url('/chats/chat_lab_agenda'));
  await expect(page.getByTestId('chat-thread')).toBeVisible();

  await page.getByTestId('composer-input').fill('Stream a long answer.');
  await page.getByTestId('composer-send').click();

  const content = page.getByTestId('stream-bubble-content');
  await expect(content).toBeVisible();

  // Wait until the bubble's own content is taller than its capped box.
  await expect
    .poll(
      () =>
        content.evaluate(
          (element) => element.scrollHeight > element.clientHeight,
        ),
      { timeout: 10_000, intervals: [50, 100, 150] },
    )
    .toBe(true);

  const metrics = await content.evaluate((element) => {
    const scroller = document.querySelector(
      '[data-testid="chat-thread-scroll"]',
    );
    const style = getComputedStyle(element);
    return {
      maxHeight: Number.parseFloat(style.maxHeight),
      overflowY: style.overflowY,
      scrollerHeight: scroller === null ? 0 : scroller.clientHeight,
      atBottom:
        element.scrollTop + element.clientHeight >= element.scrollHeight - 2,
      scrollTop: element.scrollTop,
    };
  });

  expect(Number.isFinite(metrics.maxHeight)).toBe(true);
  expect(metrics.maxHeight).toBeGreaterThanOrEqual(160);
  expect(metrics.maxHeight).toBeLessThanOrEqual(metrics.scrollerHeight + 1);
  expect(metrics.overflowY).toBe('auto');
  // The pinned inner scroller followed its own growth.
  expect(metrics.scrollTop).toBeGreaterThan(0);
  expect(metrics.atBottom).toBe(true);
});

test('shows attachment chips on the optimistic user block before the turn commits', async ({
  page,
  sidecar,
}) => {
  await page.goto(sidecar.url('/chats/chat_lab_agenda'));
  await expect(page.getByTestId('chat-thread')).toBeVisible();

  await page.getByTestId('composer-attach').click();
  await expect(
    page.getByTestId('attach-item-resource_soap_scaling'),
  ).toBeVisible();
  await page.getByTestId('attach-item-resource_soap_scaling').click();
  await expect(page.getByTestId('composer-chip-0')).toContainText(
    'Scaling notes',
  );

  await page.getByTestId('composer-input').fill('Attach the scaling notes.');
  await page.getByTestId('composer-send').click();

  // The pending block carries the chip while the assistant is still streaming.
  await expect(page.getByTestId('stream-bubble')).toBeVisible();
  const pendingChip = page.getByTestId('pending-attachment-chip-0');
  await expect(pendingChip).toBeVisible();
  await expect(pendingChip).toContainText('Scaling notes');
  expect(
    await page
      .getByTestId('pending-attachment-chip-0')
      .getAttribute('aria-disabled'),
  ).toBe('true');

  // Once committed, the persistent chip replaces the pending one.
  await expect(page.getByTestId('stream-bubble')).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page.getByTestId('pending-attachment-chip-0')).toHaveCount(0);
  await expect(
    page.locator('[data-testid^="attachment-chip-"]').last(),
  ).toContainText('Scaling notes');
  expect(finalReply.length).toBeGreaterThan(0);
});

test('stop aborts the stream, restores the text, and persists nothing', async ({
  page,
  sidecar,
}) => {
  const chatFile = path.join(sidecar.root, 'chats', '2026-09-10-lab-agenda.md');
  const before = await readFile(chatFile, 'utf8');

  await page.goto(sidecar.url('/chats/chat_lab_agenda'));
  await expect(page.getByTestId('chat-thread')).toBeVisible();

  const input = page.getByTestId('composer-input');
  await input.fill('Stop this long answer.');
  await page.getByTestId('composer-send').click();

  const stop = page.getByTestId('composer-stop');
  await expect(stop).toBeVisible();
  await expect(page.getByTestId('stream-bubble')).toBeVisible();
  await stop.click();

  // The bubble is gone, the typed text is restored, and the composer notes the
  // stop rather than showing a failure panel.
  await expect(page.getByTestId('stream-bubble')).toHaveCount(0);
  await expect(page.getByTestId('composer-error')).toHaveCount(0);
  await expect(page.getByTestId('composer-stopped')).toContainText('Stopped.');
  await expect(input).toHaveValue('Stop this long answer.');

  // Nothing reached disk: the transcript file is byte-identical.
  expect(await readFile(chatFile, 'utf8')).toBe(before);

  // A reload shows no new turn.
  await page.reload();
  await expect(page.getByTestId('chat-thread')).toBeVisible();
  await expect(page.getByTestId('chat-thread')).not.toContainText(
    'Stop this long answer.',
  );

  // The restored text can be resent and now commits.
  await input.fill('Resend after stop.');
  await page.getByTestId('composer-send').click();
  await expect(page.getByTestId('stream-bubble')).toBeVisible();
  await expect(page.getByTestId('stream-bubble')).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(page.getByTestId('chat-thread')).toContainText(
    'Resend after stop.',
  );
});

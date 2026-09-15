import { expect, test } from './server.js';
import { draftRecord } from './helpers.js';

// The inbox's unassigned-chat cards now stage the chat into a draft and open
// the composer, and the loose-files half is gone. The workspace overview swaps
// its stat/validation cards for recent chats, priority tasks, and projects.

test('inbox card button stages the chat in a new draft and opens the composer', async ({
  page,
  sidecar,
}) => {
  await page.goto(sidecar.url('/inbox'));
  await expect(page.getByTestId('inbox-chats')).toBeVisible();

  // The old attach dropdown is gone; the card carries the single attach button.
  await expect(page.locator('[data-testid^="attach-project-"]')).toHaveCount(0);
  const attach = page.getByTestId('inbox-attach-chat_lab_agenda');
  await expect(attach).toBeVisible();
  await expect(attach).toHaveText('Attach in chat');

  await attach.click();
  await page.waitForURL(/\/chats\/new\?draft=/);

  const chip = page.getByTestId('attachment-chip-chat_lab_agenda');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('Lab meeting agenda');
  const chipText = (await chip.innerText()).replace(/\s+/g, ' ');
  expect(chipText).not.toContain('chats/');
  expect(chipText).not.toContain('.md');
});

test('inbox no longer renders the loose-files section', async ({
  page,
  sidecar,
}) => {
  await page.goto(sidecar.url('/inbox'));
  await expect(page.getByTestId('inbox-chats')).toBeVisible();

  await expect(page.getByTestId('inbox-files')).toHaveCount(0);
  await expect(page.getByText('Loose files', { exact: false })).toHaveCount(0);
  await expect(page.getByText('.gitkeep', { exact: false })).toHaveCount(0);
});

test('inbox attach button is right-aligned on desktop and full-row on mobile', async ({
  page,
  sidecar,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(sidecar.url('/inbox'));
  const card = page.getByTestId('inbox-chat-chat_lab_agenda');
  const title = card.locator('.ct');
  const attach = page.getByTestId('inbox-attach-chat_lab_agenda');
  await expect(attach).toBeVisible();

  const cardBox = await card.boundingBox();
  const titleBox = await title.boundingBox();
  const desktopBox = await attach.boundingBox();
  expect(cardBox).not.toBeNull();
  expect(titleBox).not.toBeNull();
  expect(desktopBox).not.toBeNull();
  if (cardBox && titleBox && desktopBox) {
    // Right half of the card, vertically aligned with the title row.
    expect(desktopBox.x).toBeGreaterThan(cardBox.x + cardBox.width / 2);
    expect(Math.abs(desktopBox.y - titleBox.y)).toBeLessThan(24);
  }

  await page.setViewportSize({ width: 600, height: 900 });
  await expect(attach).toBeVisible();
  const mobileCardBox = await card.boundingBox();
  const mobileTitleBox = await title.boundingBox();
  const mobileBox = await attach.boundingBox();
  expect(mobileCardBox).not.toBeNull();
  expect(mobileTitleBox).not.toBeNull();
  expect(mobileBox).not.toBeNull();
  if (mobileCardBox && mobileTitleBox && mobileBox) {
    // Full row: the button spans the card and sits below the title.
    expect(mobileBox.width).toBeGreaterThan(mobileCardBox.width * 0.8);
    expect(mobileBox.y).toBeGreaterThan(mobileTitleBox.y);
  }
});

test('chat open-chat endpoint stages the chat in a draft', async ({
  sidecar,
}) => {
  const response = await sidecar.api.post(
    '/api/chats/chat_lab_agenda/open-chat',
    {},
  );
  expect(response.status).toBe(200);
  const record = draftRecord(response.body);
  expect(record?.attachments).toEqual([{ id: 'chat_lab_agenda' }]);
  expect(String(record?.message)).toBe('');

  const unknown = await sidecar.api.post(
    '/api/chats/chat_unknown/open-chat',
    {},
  );
  expect(unknown.status).toBe(404);
});

test('workspace overview shows recent chats, priority tasks, then projects', async ({
  page,
  sidecar,
}) => {
  await page.goto(sidecar.url('/'));
  const recent = page.getByTestId('workspace-recent-chats');
  const tasks = page.getByTestId('workspace-priority-tasks');
  const projects = page.getByTestId('workspace-projects');
  await expect(recent).toBeVisible();
  await expect(tasks).toBeVisible();
  await expect(projects).toBeVisible();

  const recentBox = await recent.boundingBox();
  const tasksBox = await tasks.boundingBox();
  const projectsBox = await projects.boundingBox();
  expect(recentBox).not.toBeNull();
  expect(tasksBox).not.toBeNull();
  expect(projectsBox).not.toBeNull();
  if (recentBox && tasksBox && projectsBox) {
    expect(recentBox.y).toBeLessThan(tasksBox.y);
    expect(tasksBox.y).toBeLessThan(projectsBox.y);
  }

  // Recent chats: the newest sample chat and its project tag.
  await expect(
    page.getByTestId('workspace-recent-chat-chat_lab_agenda'),
  ).toBeVisible();
  await expect(
    page.getByTestId('workspace-recent-chat-chat_lab_agenda'),
  ).toContainText('Lab meeting agenda');

  // Priority tasks: active only, ordered by deadline with undated last.
  const baseline = page.getByTestId(
    'workspace-priority-task-task_baseline_notes',
  );
  const writers = page.getByTestId('workspace-priority-task-task_writers_room');
  const undated = page.getByTestId('workspace-priority-task-task_lab_refresh');
  await expect(baseline).toBeVisible();
  await expect(writers).toBeVisible();
  await expect(undated).toBeVisible();
  await expect(
    page.getByTestId('workspace-priority-task-task_scaling_review'),
  ).toHaveCount(0);

  const baselineBox = await baseline.boundingBox();
  const writersBox = await writers.boundingBox();
  const undatedBox = await undated.boundingBox();
  if (baselineBox && writersBox && undatedBox) {
    expect(baselineBox.y).toBeLessThan(writersBox.y);
    expect(writersBox.y).toBeLessThan(undatedBox.y);
  }

  // The retired stat and validation blocks are gone.
  await expect(page.getByTestId('workspace-stats')).toHaveCount(0);
  await expect(page.getByText('At a glance', { exact: false })).toHaveCount(0);
});

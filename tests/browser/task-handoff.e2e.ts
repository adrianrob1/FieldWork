import { expect, test } from './server.js';
import { taskList, taskRecord } from './helpers.js';

test('task handoff stages task context in a fresh draft without a chat field', async ({
  page,
  sidecar,
}) => {
  // "Open chat" on a fixture task stages that task in a new draft.
  await page.goto(sidecar.url('/tasks'));
  await expect(page.getByTestId('task-list')).toBeVisible();
  await page.getByTestId('task-open-chat-task_lab_refresh').click();
  await page.waitForURL(/\/chats\/new\?draft=/);

  const chip = page.getByTestId('attachment-chip-task_lab_refresh');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('Refresh the lab whiteboard');
  const chipText = (await chip.innerText()).replace(/\s+/g, ' ');
  expect(chipText).not.toContain('tasks/');
  expect(chipText).not.toContain('.md');
  // Do not send: the composer has no message text yet.
  await expect(page.getByTestId('send-button')).toBeDisabled();

  // "Add & open chat" from quick-add creates a task and opens a staged draft.
  await page.goto(sidecar.url('/tasks'));
  const createdTitle = 'Follow up on scaling review';
  await page.getByTestId('task-quickadd').fill(createdTitle);
  await page.getByTestId('task-add-open-chat').click();
  await page.waitForURL(/\/chats\/new\?draft=/);
  await expect(
    page.locator('[data-testid^="attachment-chip-task_"]'),
  ).toBeVisible();

  // The new task shows up in the task list.
  await page.goto(sidecar.url('/tasks'));
  await expect(page.getByText(createdTitle)).toBeVisible();

  // The task view carries no chat field on either endpoint.
  const list = await sidecar.api.get('/api/tasks');
  const created = taskList(list.body).find(
    (task) => task.title === createdTitle,
  );
  expect(created).toBeDefined();
  expect(Object.prototype.hasOwnProperty.call(created, 'chat')).toBe(false);
  const rawId = created?.id;
  const id = typeof rawId === 'string' ? rawId : '';
  expect(id).not.toBe('');
  const detail = await sidecar.api.get(`/api/tasks/${encodeURIComponent(id)}`);
  const record = taskRecord(detail.body);
  expect(record).not.toBeNull();
  expect(Object.prototype.hasOwnProperty.call(record, 'chat')).toBe(false);
});

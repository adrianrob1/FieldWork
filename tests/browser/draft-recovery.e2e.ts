import { expect, test, type Sidecar } from './server.js';
import { draftRecord, recordOf, stringListOf } from './helpers.js';

type DraftPredicate = (record: Record<string, unknown>) => boolean;

// Poll the draft API until the stored record satisfies the predicate, so a
// reload or restart never races the debounced autosave.
async function expectDraftField(
  sidecar: Sidecar,
  draftId: string,
  predicate: DraftPredicate,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const reply = await sidecar.api.get(`/api/drafts/${draftId}`);
        const record = draftRecord(reply.body);
        return record !== null && predicate(record);
      },
      { timeout: 10_000 },
    )
    .toBe(true);
}

function attachmentsInclude(
  record: Record<string, unknown>,
  id: string,
): boolean {
  const attachments = record.attachments;
  if (!Array.isArray(attachments)) return false;
  return attachments.some((entry) => recordOf(entry)?.id === id);
}

test('a draft discarded mid-edit is recreated from local state', async ({
  page,
  sidecar,
}) => {
  // Open a chat from a task: the task is staged into a draft and the composer
  // opens on it.
  await page.goto(sidecar.url('/tasks'));
  await page.getByTestId('task-open-chat-task_lab_refresh').click();
  await page.waitForURL(/\/chats\/new\?draft=/);
  const firstId = new URL(page.url()).searchParams.get('draft');
  expect(firstId).not.toBeNull();

  // Discard the stored draft out from under the mounted editor.
  const discarded = await sidecar.api.post(
    `/api/drafts/${String(firstId)}/discard`,
  );
  expect(discarded.status).toBe(200);

  // Typing triggers a save against the missing draft; recovery recreates it
  // and reroutes to the new id.
  const message = 'Recovered after the draft was discarded';
  const input = page.getByTestId('composer-input');
  await input.fill(message);
  await page.waitForURL((url) => {
    const id = url.searchParams.get('draft');
    return id !== null && id !== firstId;
  });
  const secondId = new URL(page.url()).searchParams.get('draft');
  expect(secondId).not.toBeNull();

  await expect(input).toHaveValue(message);
  await expect(page.getByTestId('submit-error')).toHaveCount(0);
  await expect(page.getByTestId('draft-start-fresh')).toHaveCount(0);

  await expect
    .poll(
      async () => {
        const reply = await sidecar.api.get(`/api/drafts/${String(secondId)}`);
        return draftRecord(reply.body)?.message;
      },
      { timeout: 10_000 },
    )
    .toBe(message);
});

test('draft survives SPA navigation, reload, edits, and a server restart', async ({
  sidecar,
  page,
}) => {
  const message = 'Draft recovery: keep me visible';
  await page.goto(sidecar.url('/chats/new'));
  const input = page.getByTestId('composer-input');
  await expect(input).toBeVisible();
  await input.fill(message);
  await page.waitForURL(/\/chats\/new\?draft=/);
  const draftParam = new URL(page.url()).searchParams.get('draft');
  expect(draftParam).not.toBeNull();
  const draftId = String(draftParam);
  const draftRoute = `/chats/new?draft=${draftId}`;
  await expectDraftField(
    sidecar,
    draftId,
    (record) => record.message === message,
  );

  // (1) SPA navigation away and back through the amber draft row on /chats.
  await page.getByTestId('nav-item-chats').click();
  await page.waitForURL((url) => url.pathname === '/chats');
  const draftRow = page.getByTestId(`draft-row-${draftId}`);
  await expect(draftRow).toBeVisible();
  await expect(draftRow).toHaveClass(/draft/);
  await draftRow.click();
  await page.waitForURL((url) => url.searchParams.get('draft') === draftId);
  await expect(page.getByTestId('composer-input')).toHaveValue(message);

  // Project pick + attachment stage.
  await page.getByTestId('project-multi-select').click();
  await page.getByTestId('menu-item-project_soap_bubbles').click();
  await page.getByTestId('attachment-picker').click();
  await page.getByTestId('attach-item-resource_soap_scaling').click();
  await expectDraftField(sidecar, draftId, (record) =>
    stringListOf(record.projects).includes('project_soap_bubbles'),
  );
  await expectDraftField(sidecar, draftId, (record) =>
    attachmentsInclude(record, 'resource_soap_scaling'),
  );
  const chip = page.getByTestId('attachment-chip-resource_soap_scaling');
  await expect(chip).toBeVisible();
  const chipText = (await chip.innerText()).replace(/\s+/g, ' ');
  expect(chipText).toContain('Scaling notes');
  expect(chipText).not.toContain('.md');

  // (2) Full page reload keeps the message, project, and staged attachment.
  await page.reload();
  await expect(page.getByTestId('composer-input')).toHaveValue(message);
  await expect(page.getByTestId('project-multi-select')).toContainText('1');
  await expect(
    page.getByTestId('attachment-chip-resource_soap_scaling'),
  ).toBeVisible();

  // (3) Server restart preserves the stored draft in the same workspace.
  await sidecar.restart();
  await page.goto(sidecar.url(draftRoute));
  await expect(page.getByTestId('composer-input')).toHaveValue(message);
  await expect(
    page.getByTestId('attachment-chip-resource_soap_scaling'),
  ).toBeVisible();
  await expectDraftField(sidecar, draftId, (record) =>
    stringListOf(record.projects).includes('project_soap_bubbles'),
  );
});

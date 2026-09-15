import { expect, test } from './server.js';
import { fileBody, fileHash } from './helpers.js';

const filePath = 'projects/soap-bubbles/context/scaling.md';
const fileRoute = `/api/file?path=${encodeURIComponent(filePath)}`;

test('autosave persists, detects an out-of-band write, and recovers', async ({
  page,
  sidecar,
}) => {
  await page.goto(sidecar.url(`/edit?path=${encodeURIComponent(filePath)}`));
  const body = page.getByTestId('editor-body');
  await expect(body).toBeVisible();
  const original = await body.inputValue();

  // Autosave a local change and prove it reached disk.
  const firstEdit = `${original}\n\nAutosave check.`;
  await body.fill(firstEdit);
  await expect
    .poll(async () => fileBody((await sidecar.api.get(fileRoute)).body))
    .toContain('Autosave check.');
  const saved = await sidecar.api.get(fileRoute);
  const hash = fileHash(saved.body);
  expect(hash).not.toBeNull();

  // Another writer edits the same file with the correct current hash.
  const external = `${firstEdit}\n\nExternal writer.`;
  const write = await sidecar.api.post('/api/edit/body', {
    path: filePath,
    body: external,
    expectedHash: hash,
  });
  expect(write.status).toBe(200);

  // Typing again autosaves against the stale hash and surfaces a conflict.
  await body.fill(`${external}\n\nLocal again.`);
  await expect(page.getByTestId('editor-conflict')).toBeVisible();
  await page.getByTestId('editor-keep-editing').click();
  await expect(page.getByTestId('editor-conflict')).toHaveCount(0);

  // Keeping the local edit adopts the fresh hash and the next autosave lands.
  await expect
    .poll(async () => fileBody((await sidecar.api.get(fileRoute)).body))
    .toContain('Local again.');
  await expect(page.getByTestId('editor-status')).toContainText('autosaved');
});

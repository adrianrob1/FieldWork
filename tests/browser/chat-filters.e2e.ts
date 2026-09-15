import { expect, test } from './server.js';

// The "All / Unassigned / By project" tabs filter the list in place. They must
// never navigate to /inbox or a project page, and the same pane filters work
// from a chat thread's side list.

function pathnameOf(page: { url(): string }): string {
  return new URL(page.url()).pathname;
}

const chatRow = '[data-testid^="chat-row-"]';

test('/chats filter tabs narrow the list without leaving the route', async ({
  page,
  sidecar,
}) => {
  await page.goto(sidecar.url('/chats'));

  const allTab = page.getByTestId('chat-filter-all');
  const unassignedTab = page.getByTestId('chat-filter-unassigned');
  const projectTab = page.getByTestId('chat-filter-project');
  const rows = page.getByTestId('chat-list').locator(chatRow);

  await expect(allTab).toHaveClass(/\bon\b/);
  await expect(allTab).toHaveText('All · 3');
  await expect(unassignedTab).toHaveText('Unassigned · 1');
  await expect(rows).toHaveCount(3);

  // Unassigned filters in place: only the project-less chat remains.
  await unassignedTab.click();
  await expect(unassignedTab).toHaveClass(/\bon\b/);
  await expect(allTab).not.toHaveClass(/\bon\b/);
  expect(pathnameOf(page)).toBe('/chats');
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId('chat-row-chat_lab_agenda')).toBeVisible();

  // All restores the full list and moves the active class back.
  await allTab.click();
  await expect(allTab).toHaveClass(/\bon\b/);
  await expect(unassignedTab).not.toHaveClass(/\bon\b/);
  await expect(rows).toHaveCount(3);

  // By project opens a searchable dropdown; picking a project filters the list.
  await projectTab.click();
  await expect(page.getByTestId('chat-filter-project-menu')).toBeVisible();
  await page.getByTestId('chat-filter-project-option-project_evon').click();
  await expect(projectTab).toHaveClass(/\bon\b/);
  await expect(allTab).not.toHaveClass(/\bon\b/);
  expect(pathnameOf(page)).toBe('/chats');
  await expect(rows).toHaveCount(2);
  await expect(
    page.getByTestId('chat-row-chat_rank_diagnostics'),
  ).toBeVisible();
  await expect(
    page.getByTestId('chat-row-chat_shared_curvature'),
  ).toBeVisible();
  await expect(page.getByTestId('chat-row-chat_lab_agenda')).toHaveCount(0);

  // Choosing All again clears the project filter.
  await allTab.click();
  await expect(rows).toHaveCount(3);
});

test('a chat thread list pane filters in place too', async ({
  page,
  sidecar,
}) => {
  await page.goto(sidecar.url('/chats/chat_shared_curvature'));

  const listPane = page.getByTestId('list-pane');
  await expect(listPane).toBeVisible();
  const rows = listPane.locator(chatRow);
  await expect(rows).toHaveCount(3);

  await listPane.getByTestId('chat-filter-unassigned').click();
  expect(pathnameOf(page)).toBe('/chats/chat_shared_curvature');
  await expect(rows).toHaveCount(1);
  await expect(listPane.getByTestId('chat-row-chat_lab_agenda')).toBeVisible();

  await listPane.getByTestId('chat-filter-all').click();
  await expect(rows).toHaveCount(3);
});

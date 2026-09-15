import { expect, test } from './server.js';

// The shared GET cache coalesces identical reads fired by independent hooks
// (the shell counts hook, the page hooks, the nav projects hook) and drops them
// after any successful write.

function countRequests(
  requests: string[],
  pathname: string,
  search?: string,
): number {
  return requests.filter((url) => {
    const parsed = new URL(url);
    if (parsed.pathname !== pathname) return false;
    if (search !== undefined && parsed.search !== search) return false;
    return true;
  }).length;
}

test('a workspace load fires each shell-count URL exactly once', async ({
  page,
  sidecar,
}) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    requests.push(request.url());
  });

  await page.goto(sidecar.url('/'));
  await expect(page.getByTestId('workspace-recent-chats')).toBeVisible();
  await expect(page.getByTestId('workspace-priority-tasks')).toBeVisible();
  // Give a late, duplicated request time to show up before counting.
  await page.waitForTimeout(400);

  expect(countRequests(requests, '/api/tasks')).toBe(1);
  expect(countRequests(requests, '/api/chats', '?view=unassigned')).toBe(1);
  expect(countRequests(requests, '/api/workspace')).toBe(1);
});

test('a task created in the UI is visible without a manual reload', async ({
  page,
  sidecar,
}) => {
  await page.goto(sidecar.url('/tasks'));
  await expect(page.getByTestId('task-quickadd')).toBeVisible();

  const title = 'Cache invalidation follow-up';
  await page.getByTestId('task-quickadd').fill(title);
  await page.getByTestId('task-add').click();

  // The post-mutation reload must refetch the list, not serve the cached one.
  await expect(page.getByText(title, { exact: false })).toBeVisible();
});

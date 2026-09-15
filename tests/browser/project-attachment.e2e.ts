import { expect, test } from './server.js';
import { longChatId } from './fixture.js';
import { chatProjects } from './helpers.js';

test.use({ fixtureOptions: { longChat: true } });

test('attach a project from the header and detach it from the sticky bar', async ({
  page,
  sidecar,
}) => {
  const chatId = longChatId;
  await page.goto(sidecar.url(`/chats/${chatId}`));
  const header = page.getByTestId('chat-header');
  await expect(header).toBeVisible();

  // Attach an unattached project; the chip updates with no reload.
  const headerChip = header.getByTestId('project-chip');
  await expect(headerChip).toContainText('Attach project');
  await headerChip.click();
  await header.getByTestId('project-item-project_soap_bubbles').click();
  await expect(headerChip).toContainText('SOAP-Bubbles');
  await expect
    .poll(async () =>
      chatProjects((await sidecar.api.get(`/api/chats/${chatId}`)).body),
    )
    .toContain('project_soap_bubbles');

  // Scroll the header out so the sticky bar takes over, then detach there.
  const scroll = page.getByTestId('chat-thread-scroll');
  await scroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const sticky = page.getByTestId('sticky-bar');
  await expect(sticky).toHaveClass(/show/);
  const stickyChip = sticky.getByTestId('project-chip');
  await stickyChip.click();
  await sticky.getByTestId('project-item-project_soap_bubbles').click();
  await expect(stickyChip).toContainText('Attach project');

  // Final state is confirmed by the API, and no 409 notice appeared.
  await expect
    .poll(async () =>
      chatProjects((await sidecar.api.get(`/api/chats/${chatId}`)).body),
    )
    .toEqual([]);
  await expect(page.getByTestId('chat-notice')).toHaveCount(0);
});

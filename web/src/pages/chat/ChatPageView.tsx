import { useEffect, useMemo, useState } from 'react';

import { toProjectListEntries } from '../../shared/projects/catalog.js';
import type { OptionItem } from '../../shared/controls/index.js';
import { AppShell } from '../../shared/shell/AppShell.js';
import { ChatListPane } from '../chats/ChatListPane.js';
import { useChatList } from '../chats/useChatList.js';
import { useApiResource } from '../useApiResource.js';
import { ChatConversation } from './ChatConversation.js';

// The route-level chat page owns the stable chrome: AppShell and its list pane
// are mounted once per route and never keyed by chat, so switching chats keeps
// the same list DOM (and its fetch state) while only the conversation subtree
// remounts.
export function ChatPageView({ chatId }: { chatId: string }) {
  const chatList = useChatList();
  const projectsResource = useApiResource<unknown>('/api/projects');
  const [title, setTitle] = useState<string | null>(null);

  useEffect(() => {
    setTitle(null);
  }, [chatId]);

  const projectOptions = useMemo<OptionItem[]>(() => {
    if (projectsResource.state.status !== 'ready') return [];
    return toProjectListEntries(projectsResource.state.data).map((project) => ({
      id: project.id,
      label: project.title,
    }));
  }, [projectsResource.state]);

  const listTitle =
    chatList.chats.find((entry) => entry.id === chatId)?.title ?? null;
  const resolvedTitle = title ?? listTitle ?? 'Chat';

  return (
    <AppShell
      breadcrumb={[
        { label: 'Chats', href: '/chats' },
        { label: resolvedTitle, href: `/chats/${chatId}` },
      ]}
      title={resolvedTitle}
      parentPath="/chats"
      contentClassName="chatpane"
      list={<ChatListPane activeChatId={chatId} list={chatList} />}
    >
      <ChatConversation
        key={chatId}
        chatId={chatId}
        projects={projectOptions}
        onTitleChange={setTitle}
      />
    </AppShell>
  );
}

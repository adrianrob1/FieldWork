import { AppShell } from '../shared/shell/AppShell.js';
import { NewChatPanel } from './chats/NewChatPanel.js';
import { ChatListPane } from './chats/ChatListPane.js';
import { useChatList } from './chats/useChatList.js';

// Desktop /chats is a two-pane view: the list on the left and the embedded
// new-chat start panel on the right, so drafting is one click away. Below the
// mobile breakpoint the content pane is hidden and the list is the whole page;
// the New chat button still opens the dedicated /chats/new route.
export function ChatsPage() {
  const chatList = useChatList();

  return (
    <AppShell
      breadcrumb={[]}
      title="Chats"
      parentPath="/"
      list={<ChatListPane list={chatList} />}
    >
      <NewChatPanel basePath="/chats" />
    </AppShell>
  );
}

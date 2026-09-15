import { useRoute } from '../shared/router.js';
import { ChatPage } from '../pages/ChatPage.js';
import { ChatsPage } from '../pages/ChatsPage.js';
import { EditPage } from '../pages/EditPage.js';
import { InboxPage } from '../pages/InboxPage.js';
import { NewChatPage } from '../pages/NewChatPage.js';
import { NotFoundPage } from '../pages/NotFoundPage.js';
import { ProjectDetailPage } from '../pages/ProjectDetailPage.js';
import { ProjectsPage } from '../pages/ProjectsPage.js';
import { SearchPage } from '../pages/SearchPage.js';
import { SettingsPage } from '../pages/SettingsPage.js';
import { TasksPage } from '../pages/TasksPage.js';
import { WorkspacePage } from '../pages/WorkspacePage.js';

export function App() {
  const route = useRoute();
  switch (route.name) {
    case 'workspace':
      return <WorkspacePage />;
    case 'projects':
      return <ProjectsPage />;
    case 'project':
      return <ProjectDetailPage />;
    case 'chats':
      return <ChatsPage />;
    case 'chat-new':
      return <NewChatPage />;
    case 'chat':
      return <ChatPage />;
    case 'inbox':
      return <InboxPage />;
    case 'search':
      return <SearchPage />;
    case 'edit':
      return <EditPage />;
    case 'settings':
      return <SettingsPage />;
    case 'tasks':
      return <TasksPage />;
    default:
      return <NotFoundPage />;
  }
}

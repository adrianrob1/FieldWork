import { useRoute } from '../shared/router.js';
import { ChatPageView } from './chat/index.js';

export function ChatPage() {
  const route = useRoute();
  const chatId = route.params.id ?? '';
  return <ChatPageView chatId={chatId} />;
}

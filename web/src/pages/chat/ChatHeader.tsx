import type { RefObject } from 'react';

import { RenameTitle, type OptionItem } from '../../shared/controls/index.js';
import { ChatActionsMenu, ProjectChipMenu } from './ChatMenus.js';
import type { ChatDetail } from './chatThread.js';

export interface ChatHeaderProps {
  chat: ChatDetail;
  projects: readonly OptionItem[];
  sentinelRef: RefObject<HTMLElement | null>;
  onToggleProject: (projectId: string) => void;
  onCommitTitle: (title: string) => Promise<void>;
  disabled?: boolean | undefined;
}

function topicLabel(id: string): string {
  return id.replace(/^topic_/, '');
}

export function ChatHeader({
  chat,
  projects,
  sentinelRef,
  onToggleProject,
  onCommitTitle,
  disabled = false,
}: ChatHeaderProps) {
  const providerModel = [chat.provider, chat.model]
    .filter((part): part is string => part !== null && part !== '')
    .join(' · ');
  return (
    <header className="chead" data-testid="chat-header" ref={sentinelRef}>
      <h1>
        <RenameTitle
          value={chat.title}
          titleKey={`chat:${chat.id}`}
          ariaLabel="Chat title"
          testId="chat-title"
          onCommit={onCommitTitle}
        />
      </h1>
      <div className="meta" data-testid="chat-header-meta">
        <ProjectChipMenu
          projects={projects}
          attached={chat.projects}
          onToggle={onToggleProject}
          disabled={disabled}
        />
        {providerModel !== '' && <span className="mono">{providerModel}</span>}
        {chat.topics.map((id) => (
          <span className="chip" key={id}>
            #{topicLabel(id)}
          </span>
        ))}
        <ChatActionsMenu chatPath={chat.path} disabled={disabled} />
      </div>
    </header>
  );
}

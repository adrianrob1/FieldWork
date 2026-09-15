import { useCallback, useEffect, useState, type RefObject } from 'react';

import { RenameTitle, type OptionItem } from '../../shared/controls/index.js';
import { navigate } from '../../shared/router.js';
import { stickyBarFromIntersection } from './chatComposer.js';
import { ChatActionsMenu, ProjectChipMenu } from './ChatMenus.js';
import type { ChatDetail } from './chatThread.js';

export interface ChatStickyBarProps {
  chat: ChatDetail;
  projects: readonly OptionItem[];
  sentinelRef: RefObject<HTMLElement | null>;
  rootRef: RefObject<HTMLDivElement | null>;
  onToggleProject: (projectId: string) => void;
  onCommitTitle: (title: string) => Promise<void>;
  disabled?: boolean | undefined;
}

// Compact bar that slides in once the full header scrolls out of view. Both
// this bar and the header share the chat title key, so their titles stay in
// sync. On mobile the CSS turns this into the page's only header.
export function ChatStickyBar({
  chat,
  projects,
  sentinelRef,
  rootRef,
  onToggleProject,
  onCommitTitle,
  disabled = false,
}: ChatStickyBarProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (sentinel === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry === undefined) return;
        setVisible(stickyBarFromIntersection(entry));
      },
      { root: rootRef.current ?? null, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
    };
  }, [sentinelRef, rootRef]);

  const openDrawer = useCallback(() => {
    document
      .querySelector<HTMLButtonElement>('[data-testid="drawer-button"]')
      ?.click();
  }, []);

  return (
    <div
      className={visible ? 'chatbar-top show' : 'chatbar-top'}
      data-testid="sticky-bar"
    >
      <button
        className="mbtn"
        type="button"
        aria-label="Back to chats"
        onClick={() => {
          navigate('/chats');
        }}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
      </button>
      <button
        className="mbtn"
        type="button"
        aria-label="Open menu"
        onClick={openDrawer}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      <RenameTitle
        value={chat.title}
        titleKey={`chat:${chat.id}`}
        ariaLabel="Chat title"
        testId="chat-title"
        className="cbt-t"
        inputClassName="cbt-inp"
        onCommit={onCommitTitle}
      />
      <ProjectChipMenu
        projects={projects}
        attached={chat.projects}
        onToggle={onToggleProject}
        disabled={disabled}
      />
      <ChatActionsMenu chatPath={chat.path} disabled={disabled} />
    </div>
  );
}

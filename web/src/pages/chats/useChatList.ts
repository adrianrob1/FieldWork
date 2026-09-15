import { useState } from 'react';

import { postJson, type ApiFailure } from '../../shared/api.js';
import {
  toChatListEntries,
  type ChatListEntry,
} from '../../shared/projects/catalog.js';
import { errorTextOf } from '../../shared/responses.js';
import { parseDraftList, type DraftEntry } from '../draftFlow.js';
import { useApiResource, type ApiResource } from '../useApiResource.js';
import {
  chatFilterCounts,
  chatListViewUrl,
  projectOptionsOf,
  projectTitlesOf,
  type ChatFilterView,
  type ChatProjectOption,
} from './chatListModel.js';

// The "All chats" data both the list page and a chat thread's side pane need:
// stored drafts and every chat, plus the in-place filter view, the discard
// action, and the project options that feed the "By project" dropdown. Each
// mounted page runs its own fetch lifecycle.
//
// Two views are always fetched so the All and Unassigned tab counts stay live
// regardless of the active filter; the project view is fetched on demand. The
// API for every view also returns the full project list, so the dropdown needs
// no separate /api/projects request.

export interface ChatListController {
  drafts: readonly DraftEntry[];
  chats: readonly ChatListEntry[];
  titles: ReadonlyMap<string, string>;
  total: number;
  loading: boolean;
  failed: boolean;
  failure: ApiFailure | null;
  discardingId: string | null;
  notice: string | null;
  discard: (id: string) => void;
  reload: () => void;
  view: ChatFilterView;
  setView: (view: ChatFilterView) => void;
  allCount: number;
  unassignedCount: number;
  projects: readonly ChatProjectOption[];
}

export function useChatList(): ChatListController {
  const draftsResource = useApiResource<unknown>('/api/drafts');
  const allResource = useApiResource<unknown>(chatListViewUrl({ kind: 'all' }));
  const unassignedResource = useApiResource<unknown>(
    chatListViewUrl({ kind: 'unassigned' }),
  );
  const [view, setView] = useState<ChatFilterView>({ kind: 'all' });
  const projectResource = useApiResource<unknown>(
    view.kind === 'project' ? chatListViewUrl(view) : null,
  );
  const [discardingId, setDiscardingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const entriesOf = (resource: ApiResource<unknown>): ChatListEntry[] =>
    resource.state.status === 'ready'
      ? toChatListEntries(resource.state.data)
      : [];

  const allChats = entriesOf(allResource);
  const unassignedChats = entriesOf(unassignedResource);
  const activeResource =
    view.kind === 'all'
      ? allResource
      : view.kind === 'unassigned'
        ? unassignedResource
        : projectResource;
  const chats = entriesOf(activeResource);

  const drafts =
    draftsResource.state.status === 'ready'
      ? parseDraftList(draftsResource.state.data).filter(
          (entry) => !entry.draft.consumed,
        )
      : [];
  const titles =
    allResource.state.status === 'ready'
      ? projectTitlesOf(allResource.state.data)
      : new Map<string, string>();
  const projects =
    allResource.state.status === 'ready'
      ? projectOptionsOf(allResource.state.data)
      : [];
  const counts = chatFilterCounts({
    all: allChats,
    unassigned: unassignedChats,
  });

  const loading =
    draftsResource.state.status === 'loading' ||
    activeResource.state.status === 'loading';
  const failed =
    draftsResource.state.status === 'error' ||
    activeResource.state.status === 'error';
  const failure =
    draftsResource.state.status === 'error'
      ? draftsResource.state.failure
      : activeResource.state.status === 'error'
        ? activeResource.state.failure
        : null;

  const discard = (id: string) => {
    setDiscardingId(id);
    setNotice(null);
    void postJson<unknown>(
      `/api/drafts/${encodeURIComponent(id)}/discard`,
      {},
    ).then((outcome) => {
      setDiscardingId(null);
      if (!outcome.ok) {
        setNotice(
          errorTextOf(outcome.failure.body) ??
            'The draft could not be discarded.',
        );
        return;
      }
      draftsResource.reload();
    });
  };

  const reload = () => {
    draftsResource.reload();
    allResource.reload();
    unassignedResource.reload();
    projectResource.reload();
  };

  return {
    drafts,
    chats,
    titles,
    total: drafts.length + chats.length,
    loading,
    failed,
    failure,
    discardingId,
    notice,
    discard,
    reload,
    view,
    setView,
    allCount: counts.all,
    unassignedCount: counts.unassigned,
    projects,
  };
}

import { useState, type MouseEvent } from 'react';

import {
  FilterMenu,
  MenuItem,
  type OptionItem,
} from '../../shared/controls/index.js';
import type { ChatListEntry } from '../../shared/projects/catalog.js';
import { Link, navigate } from '../../shared/router.js';
import {
  draftRowPreview,
  firstLineTitle,
  type DraftEntry,
} from '../draftFlow.js';
import { relativeTime } from '../workspaceModel.js';
import {
  chatFilterTabActive,
  draftRoute,
  filterTabLabel,
  mobileDraftMediaQuery,
  toProjectOptionItems,
} from './chatListModel.js';
import type { ChatListController } from './useChatList.js';

// The shared "All chats" list pane: drafts first, then chats, with the current
// chat marked. The data, filter view, and discard action come from useChatList
// so /chats and a chat thread's side pane render the exact same rows.

function projectTagLabel(
  id: string,
  titles: ReadonlyMap<string, string>,
): string {
  const title = titles.get(id);
  if (title !== undefined) return title;
  return id.replace(/^project_/, '');
}

// Decided at click time: below the mobile breakpoint /chats is a pure list, so
// a draft opens on the dedicated /chats/new route; at or above it the embedded
// panel shows the draft without leaving /chats.
function openDraft(id: string): void {
  const mobile =
    typeof window !== 'undefined' &&
    window.matchMedia(mobileDraftMediaQuery).matches;
  navigate(draftRoute(id, mobile));
}

function draftRowClick(id: string, event: MouseEvent<HTMLElement>): void {
  if (event.defaultPrevented) return;
  openDraft(id);
}

function FilterTabs({ list }: { list: ChatListController }) {
  const { view, setView, allCount, unassignedCount, projects } = list;
  const [open, setOpen] = useState(false);
  const selected =
    view.kind === 'project'
      ? projects.find((project) => project.id === view.projectId)
      : undefined;
  const items: OptionItem[] = toProjectOptionItems(projects);

  return (
    <div className="ftabs">
      <button
        type="button"
        className={chatFilterTabActive(view, 'all') ? 'ftab on' : 'ftab'}
        data-testid="chat-filter-all"
        onClick={() => {
          setView({ kind: 'all' });
        }}
      >
        {filterTabLabel('all', allCount)}
      </button>
      <button
        type="button"
        className={chatFilterTabActive(view, 'unassigned') ? 'ftab on' : 'ftab'}
        data-testid="chat-filter-unassigned"
        onClick={() => {
          setView({ kind: 'unassigned' });
        }}
      >
        {filterTabLabel('unassigned', unassignedCount)}
      </button>
      <FilterMenu
        items={items}
        open={open}
        onOpenChange={setOpen}
        ariaLabel="Filter by project"
        align="left"
        placeholder="Filter projects"
        menuTestId="chat-filter-project-menu"
        emptyText="No projects"
        trigger={(props) => (
          <button
            {...props}
            type="button"
            className={
              chatFilterTabActive(view, 'project') ? 'ftab on' : 'ftab'
            }
            data-testid="chat-filter-project"
          >
            {selected?.label ?? 'By project'} <span className="ct">▾</span>
          </button>
        )}
        renderItem={(item) => (
          <MenuItem
            key={item.id}
            label={item.label}
            selected={view.kind === 'project' && view.projectId === item.id}
            role="menuitemradio"
            testId={`chat-filter-project-option-${item.id}`}
            onSelect={() => {
              setView({ kind: 'project', projectId: item.id });
              setOpen(false);
            }}
          />
        )}
      />
    </div>
  );
}

function DraftRows({
  drafts,
  discardingId,
  onDiscard,
  now,
}: {
  drafts: readonly DraftEntry[];
  discardingId: string | null;
  onDiscard: (id: string) => void;
  now: Date;
}) {
  return (
    <>
      {drafts.map((entry) => {
        const id = entry.draft.id;
        return (
          <div
            className="row draft"
            key={id}
            data-testid={`draft-row-${id}`}
            style={{ cursor: 'pointer' }}
            onClick={(event) => {
              draftRowClick(id, event);
            }}
          >
            <p className="rt">
              <Link
                to={draftRoute(id, false)}
                onClick={(event) => {
                  if (event.button !== 0) return;
                  if (
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  ) {
                    return;
                  }
                  event.preventDefault();
                  openDraft(id);
                }}
              >
                {firstLineTitle(entry.draft.message)}
              </Link>
            </p>
            <p className="rd">
              {entry.draft.updated === ''
                ? ''
                : relativeTime(entry.draft.updated, now)}
            </p>
            <p className="rp">{draftRowPreview(entry.draft.message)}</p>
            <p className="tags">
              <span className="tag drafttag">draft</span>
              <button
                className="link"
                type="button"
                data-testid={`draft-discard-${id}`}
                disabled={discardingId === id}
                style={{
                  background: 'transparent',
                  border: 0,
                  padding: 0,
                  cursor: 'pointer',
                  font: 'inherit',
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  onDiscard(id);
                }}
              >
                {discardingId === id ? 'discarding…' : 'discard'}
              </button>
            </p>
          </div>
        );
      })}
    </>
  );
}

function ChatRows({
  chats,
  titles,
  activeChatId,
  now,
}: {
  chats: readonly ChatListEntry[];
  titles: ReadonlyMap<string, string>;
  activeChatId: string | undefined;
  now: Date;
}) {
  return (
    <>
      {chats.map((chat) => {
        const updated = chat.updated ?? chat.created;
        const providerModel = [chat.provider, chat.model]
          .filter(
            (part): part is string => typeof part === 'string' && part !== '',
          )
          .join(' · ');
        const active = activeChatId === chat.id;
        return (
          <Link
            className={active ? 'row on' : 'row'}
            key={chat.id}
            to={`/chats/${chat.id}`}
            data-testid={`chat-row-${chat.id}`}
          >
            <p className="rt">{chat.title}</p>
            <p className="rd">
              {updated === null ? '' : relativeTime(updated, now)}
            </p>
            <p className="rp">
              {providerModel === '' ? chat.path : providerModel}
            </p>
            <p className="tags">
              {chat.projects.map((projectId) => (
                <span className="tag proj" key={projectId}>
                  {projectTagLabel(projectId, titles)}
                </span>
              ))}
            </p>
          </Link>
        );
      })}
    </>
  );
}

export function ChatListPane({
  activeChatId,
  list,
}: {
  activeChatId?: string;
  list: ChatListController;
}) {
  const {
    drafts,
    chats,
    titles,
    total,
    loading,
    failed,
    discardingId,
    notice,
    discard,
  } = list;
  const now = new Date();
  return (
    <>
      <div className="lh">
        <div className="top">
          <span className="t">All chats</span>
          <span className="f">by date</span>
        </div>
        {!loading && !failed && <FilterTabs list={list} />}
      </div>
      <div className="rows rise" data-testid="chat-list">
        {notice !== null && (
          <p
            className="note"
            style={{ margin: 10, borderLeftColor: 'var(--danger)' }}
          >
            {notice}
          </p>
        )}
        {loading && <p className="stub-note">Loading chats…</p>}
        {!loading && failed && (
          <p className="stub-note">Chats could not be loaded.</p>
        )}
        {!loading && !failed && total === 0 && (
          <p className="stub-note">
            No chats yet. Start one from the New chat button.
          </p>
        )}
        {!loading && !failed && (
          <DraftRows
            drafts={drafts}
            discardingId={discardingId}
            onDiscard={discard}
            now={now}
          />
        )}
        {!loading && !failed && (
          <ChatRows
            chats={chats}
            titles={titles}
            activeChatId={activeChatId}
            now={now}
          />
        )}
      </div>
      {!loading && !failed && (
        <div className="lfoot">
          <span>
            {total} {total === 1 ? 'chat' : 'chats'}
          </span>
          <span>newest first</span>
        </div>
      )}
    </>
  );
}

import { useState } from 'react';

import { postJson, type ApiFailure } from '../shared/api.js';
import { useStagger } from '../shared/controls/index.js';
import {
  toChatListEntries,
  type ChatListEntry,
} from '../shared/projects/catalog.js';
import { Link, navigate } from '../shared/router.js';
import { AppShell } from '../shared/shell/AppShell.js';
import { PagePlaceholder } from './stub.js';
import { useApiResource } from './useApiResource.js';
import { relativeTime } from './workspaceModel.js';

// The open-chat endpoint answers with the staged draft view; its `route` is the
// `/chats/new?draft=<id>` URL the composer resumes.
function draftRouteOf(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const draft = (data as { draft?: unknown }).draft;
  if (typeof draft !== 'object' || draft === null) return null;
  const route = (draft as { route?: unknown }).route;
  return typeof route === 'string' && route !== '' ? route : null;
}

export function InboxPage() {
  const inbox = useApiResource<unknown>('/api/inbox');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const now = new Date();

  // The inbox payload still carries loose files for agents, but the page only
  // renders the unassigned chats half.
  const chats =
    inbox.state.status === 'ready' ? toChatListEntries(inbox.state.data) : [];
  const riseStyles = useStagger(chats.length);

  const loading = inbox.state.status === 'loading';
  const failed = inbox.state.status === 'error';

  const attachInChat = async (chat: ChatListEntry) => {
    setBusyId(chat.id);
    setNotice(null);
    const outcome = await postJson<unknown>(
      `/api/chats/${encodeURIComponent(chat.id)}/open-chat`,
      {},
    );
    setBusyId(null);
    if (!outcome.ok) {
      setNotice(failureText(outcome.failure));
      return;
    }
    navigate(draftRouteOf(outcome.data) ?? '/chats/new');
  };

  const chatCount = chats.length;

  const list = (
    <>
      <div className="lh">
        <div className="top">
          <span className="t">Needs triage</span>
          <span className="f">oldest first</span>
        </div>
      </div>
      <div className="rows rise">
        {loading && <p className="stub-note">Loading inbox…</p>}
        {!loading && failed && (
          <p className="stub-note">The inbox could not be loaded.</p>
        )}
        {!loading &&
          !failed &&
          chats.map((chat) => (
            <Link
              className="row"
              key={chat.id}
              to={`/chats/${encodeURIComponent(chat.id)}`}
            >
              <p className="rt">{chat.title}</p>
              <p className="rd">
                {chat.updated === null ? '' : relativeTime(chat.updated, now)}
              </p>
              <p className="rp">Unassigned chat in search of a project.</p>
              <p className="tags">
                <span className="tag inbox">unassigned chat</span>
              </p>
            </Link>
          ))}
        {!loading && !failed && chatCount === 0 && (
          <p className="stub-note">Nothing needs triage. The inbox is clear.</p>
        )}
      </div>
      {!loading && !failed && (
        <div className="lfoot">
          <span>
            {chatCount} {chatCount === 1 ? 'chat' : 'chats'}
          </span>
        </div>
      )}
    </>
  );

  return (
    <AppShell breadcrumb={[]} title="Inbox" parentPath="/" list={list}>
      {loading && (
        <PagePlaceholder
          glyph="◫"
          heading="Loading inbox…"
          body="Reading unassigned chats from the workspace."
        />
      )}
      {!loading && failed && (
        <PagePlaceholder
          glyph="◌"
          heading="Inbox unavailable"
          body={failureText(
            inbox.state.status === 'error' ? inbox.state.failure : null,
          )}
          actions={
            <button
              className="btn primary sm"
              type="button"
              onClick={inbox.reload}
            >
              Retry
            </button>
          }
        />
      )}
      {!loading && !failed && (
        <div className="sheet wide">
          <div className="chead rise">
            <p className="kick">
              Inbox <span className="chip">inbox/</span>
            </p>
            <h1>Needs triage</h1>
            <p className="sub">
              Unassigned chats collect here. Attaching is optional by design.
            </p>
          </div>

          {notice !== null && (
            <p
              className="note"
              style={{ marginBottom: 16, borderLeftColor: 'var(--warn)' }}
            >
              {notice}
            </p>
          )}

          <section className="sect">
            <p className="sl">
              Unassigned chats <span className="cnt">{chatCount}</span>
            </p>
            <div className="rise" data-testid="inbox-chats">
              {chats.length === 0 && (
                <p className="stub-note">No unassigned chats.</p>
              )}
              {chats.map((chat, index) => (
                <div
                  className="card lift"
                  key={chat.id}
                  data-testid={`inbox-chat-${chat.id}`}
                  style={{
                    marginBottom: 12,
                    ...(riseStyles[index] ?? {}),
                  }}
                >
                  <div className="triagerow">
                    <div className="triagebody">
                      <p className="ct">
                        {chat.title}{' '}
                        <span className="tag inbox">
                          {chat.updated === null
                            ? 'unassigned'
                            : `since ${relativeTime(chat.updated, now)}`}
                        </span>
                      </p>
                      <p className="cs">
                        {chat.path === ''
                          ? 'No transcript path recorded.'
                          : chat.path}
                      </p>
                    </div>
                    <div className="triageact">
                      <button
                        className="btn sm"
                        type="button"
                        data-testid={`inbox-attach-${chat.id}`}
                        disabled={busyId === chat.id}
                        onClick={() => {
                          void attachInChat(chat);
                        }}
                      >
                        {busyId === chat.id ? 'Attaching…' : 'Attach in chat'}
                      </button>
                      <Link
                        className="btn ghost sm"
                        to={`/chats/${encodeURIComponent(chat.id)}`}
                      >
                        Open chat
                      </Link>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </AppShell>
  );
}

function failureText(failure: ApiFailure | null): string {
  return failure?.errorText ?? 'The inbox request failed.';
}

import { useRef, useState, type ReactNode } from 'react';

import { getJson, postJson } from '../shared/api.js';
import { SearchableSelect } from '../shared/controls/index.js';
import { Link, useRoute } from '../shared/router.js';
import { errorTextOf } from '../shared/responses.js';
import { AppShell } from '../shared/shell/AppShell.js';
import { PagePlaceholder, SheetPlaceholder } from './stub.js';
import { useApiResource } from './useApiResource.js';
import {
  chatCountLabel,
  chatDateOf,
  fileCountLabel,
  repositoryName,
  repositoryPayload,
  toChatListEntries,
  toProjectDetail,
  type ChatListEntry,
  type InboundReferenceEntry,
  type ProjectResourceEntry,
  type RepositoryValues,
} from './projectsModel.js';
import { humanizeBytes, relativeTime, topicLabel } from './workspaceModel.js';

interface ChatRetry {
  chatId: string;
  change: 'attach' | 'detach';
}

interface Notice {
  tone: 'info' | 'conflict' | 'error';
  text: string;
  chatRetry?: ChatRetry;
  repoRetry?: boolean;
}

const emptyRepositoryForm: RepositoryValues = {
  path: '',
  id: '',
  title: '',
  remote: '',
};

function editHref(path: string): string {
  return `/edit?path=${encodeURIComponent(path)}`;
}

function noticeStyle(tone: Notice['tone']): { borderLeftColor: string } {
  if (tone === 'conflict') return { borderLeftColor: 'var(--warn)' };
  if (tone === 'error') return { borderLeftColor: 'var(--danger)' };
  return { borderLeftColor: 'var(--acc)' };
}

function resourceNode(resource: ProjectResourceEntry): ReactNode {
  const label = resource.title ?? resource.path ?? resource.url ?? resource.id;
  if (resource.path !== null) {
    return (
      <Link className="link" to={editHref(resource.path)}>
        {label}
      </Link>
    );
  }
  if (resource.targetPath !== null) {
    return (
      <Link className="link" to={editHref(resource.targetPath)}>
        {label}
      </Link>
    );
  }
  if (resource.url !== null) {
    return (
      <a
        className="link"
        href={resource.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        {label}
      </a>
    );
  }
  return <span>{label}</span>;
}

function resourceDetailText(resource: ProjectResourceEntry): string {
  const target = resource.targetPath ?? resource.path;
  const parts = [resource.kind, target].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  );
  return parts.length === 0 ? 'resource' : parts.join(' · ');
}

function referenceLink(reference: InboundReferenceEntry): ReactNode {
  const label = reference.sourceTitle ?? reference.sourcePath;
  if (reference.sourceKind === 'chat') {
    return (
      <Link
        className="link"
        to={`/chats/${encodeURIComponent(reference.sourceId)}`}
      >
        {label}
      </Link>
    );
  }
  return (
    <Link className="link" to={editHref(reference.sourcePath)}>
      {label}
    </Link>
  );
}

function NoticeBox({
  notice,
  onChatRetry,
  onRepoRetry,
}: {
  notice: Notice;
  onChatRetry: (retry: ChatRetry) => void;
  onRepoRetry: () => void;
}) {
  return (
    <div className="note" style={noticeStyle(notice.tone)}>
      <span>{notice.text}</span>
      {notice.chatRetry !== undefined && (
        <button
          className="btn sm"
          type="button"
          style={{ marginLeft: 10 }}
          onClick={() => {
            onChatRetry(notice.chatRetry as ChatRetry);
          }}
        >
          Retry
        </button>
      )}
      {notice.repoRetry === true && (
        <button
          className="btn sm"
          type="button"
          style={{ marginLeft: 10 }}
          onClick={onRepoRetry}
        >
          Retry
        </button>
      )}
    </div>
  );
}

function ChatRows({
  chats,
  busyChatId,
  onDetach,
  availableChats,
  attachPending,
  onAttach,
  now,
}: {
  chats: readonly ChatListEntry[];
  busyChatId: string | null;
  onDetach: (chatId: string) => void;
  availableChats: readonly ChatListEntry[];
  attachPending: boolean;
  onAttach: (chatId: string) => void;
  now: Date;
}) {
  const options = availableChats.map((chat) => ({
    id: chat.id,
    label: chat.title,
  }));
  return (
    <>
      <div className="lh">
        <div className="top">
          <span className="t">Attached chats</span>
          <span className="f">
            {chats.length} of {chats.length}
          </span>
        </div>
      </div>
      <div className="rows rise" data-testid="project-chats">
        {chats.map((chat) => {
          const date = chatDateOf(chat);
          return (
            <div className="row" key={chat.id}>
              <Link className="rt" to={`/chats/${chat.id}`}>
                {chat.title}
              </Link>
              <p className="rd">
                {date === null ? '' : relativeTime(date, now)}
              </p>
              <p className="rp">{chat.provider ?? chat.path}</p>
              <p className="tags">
                {chat.model !== null && (
                  <span className="tag dim">{chat.model}</span>
                )}
                <button
                  className="link"
                  type="button"
                  style={{
                    background: 'transparent',
                    border: 0,
                    padding: 0,
                    cursor: 'pointer',
                    font: 'inherit',
                  }}
                  disabled={busyChatId === chat.id}
                  onClick={() => {
                    onDetach(chat.id);
                  }}
                >
                  {busyChatId === chat.id ? 'detaching…' : 'detach'}
                </button>
              </p>
            </div>
          );
        })}
        <div className="row" style={{ display: 'block' }}>
          <p className="rt" style={{ color: 'var(--faint)', fontWeight: 500 }}>
            + Attach a chat
          </p>
          <p className="rp">any chat can join several projects</p>
          <div style={{ marginTop: 8 }}>
            <span data-testid="chat-attach-menu">
              <SearchableSelect
                items={options}
                value={null}
                onChange={onAttach}
                ariaLabel="Attach a chat"
                placeholder="Choose a chat"
                disabled={attachPending || options.length === 0}
              />
            </span>
          </div>
        </div>
      </div>
      <div className="lfoot">
        <span>chats attach, files belong</span>
      </div>
    </>
  );
}

export function ProjectDetailPage() {
  const route = useRoute();
  const projectId = route.params.id ?? '';
  const { state, reload } = useApiResource<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}`,
  );
  const chatsResource = useApiResource<unknown>('/api/chats?view=all');
  const [busyChatId, setBusyChatId] = useState<string | null>(null);
  const [chatNotice, setChatNotice] = useState<Notice | null>(null);
  const [repoForm, setRepoForm] =
    useState<RepositoryValues>(emptyRepositoryForm);
  const [repoPending, setRepoPending] = useState(false);
  const [repoNotice, setRepoNotice] = useState<Notice | null>(null);
  const repoPathRef = useRef<HTMLInputElement | null>(null);
  const now = new Date();

  const detail = state.status === 'ready' ? toProjectDetail(state.data) : null;
  const allChats =
    chatsResource.state.status === 'ready'
      ? toChatListEntries(chatsResource.state.data)
      : [];
  const attachedIds = new Set(detail?.chats.map((chat) => chat.id) ?? []);
  const availableChats = allChats.filter((chat) => !attachedIds.has(chat.id));
  const title = detail?.title ?? projectId;

  const membership = async (
    chatId: string,
    change: 'attach' | 'detach',
  ): Promise<void> => {
    setBusyChatId(chatId);
    setChatNotice(null);
    const chatOutcome = await getJson<{ contentHash?: string | null }>(
      `/api/chats/${encodeURIComponent(chatId)}`,
    );
    if (!chatOutcome.ok) {
      setBusyChatId(null);
      setChatNotice({
        tone: 'error',
        text:
          errorTextOf(chatOutcome.failure.body) ??
          'The chat could not be loaded.',
      });
      return;
    }
    const expectedHash = chatOutcome.data.contentHash ?? null;
    const outcome = await postJson<unknown>(
      `/api/chats/${encodeURIComponent(chatId)}/${change}`,
      {
        projectId,
        expectedHash,
      },
    );
    setBusyChatId(null);
    if (!outcome.ok) {
      const conflict = outcome.failure.status === 409;
      setChatNotice({
        tone: conflict ? 'conflict' : 'error',
        text:
          errorTextOf(outcome.failure.body) ??
          (conflict
            ? 'The chat changed since it was loaded.'
            : `The chat could not be ${change === 'attach' ? 'attached' : 'detached'}.`),
        ...(conflict ? { chatRetry: { chatId, change } } : {}),
      });
      reload();
      return;
    }
    setChatNotice({
      tone: 'info',
      text: change === 'attach' ? 'Chat attached.' : 'Chat detached.',
    });
    reload();
  };

  const registerRepository = async (): Promise<void> => {
    if (detail === null) return;
    const built = repositoryPayload(repoForm, detail.contentHash);
    if (!built.ok) {
      setRepoNotice({ tone: 'error', text: built.message });
      return;
    }
    setRepoPending(true);
    setRepoNotice(null);
    const outcome = await postJson<unknown>(
      `/api/projects/${encodeURIComponent(projectId)}/repositories`,
      built.payload,
    );
    setRepoPending(false);
    if (!outcome.ok) {
      const conflict = outcome.failure.status === 409;
      setRepoNotice({
        tone: conflict ? 'conflict' : 'error',
        text:
          errorTextOf(outcome.failure.body) ??
          (conflict
            ? 'The project changed since it was loaded.'
            : 'The repository could not be registered.'),
        ...(conflict ? { repoRetry: true } : {}),
      });
      if (conflict) reload();
      return;
    }
    setRepoForm(emptyRepositoryForm);
    setRepoNotice({ tone: 'info', text: 'Repository registered.' });
    reload();
  };

  const list =
    state.status === 'loading' ? (
      <p className="stub-note">Loading chats…</p>
    ) : detail === null ? (
      <p className="stub-note">
        {state.status === 'error' && state.failure.status === 404
          ? 'No chats for a missing project.'
          : 'Chats could not be loaded.'}
      </p>
    ) : (
      <ChatRows
        chats={detail.chats}
        busyChatId={busyChatId}
        onDetach={(chatId) => {
          void membership(chatId, 'detach');
        }}
        availableChats={availableChats}
        attachPending={busyChatId !== null}
        onAttach={(chatId) => {
          void membership(chatId, 'attach');
        }}
        now={now}
      />
    );

  return (
    <AppShell
      breadcrumb={[
        { label: 'Workspace', href: '/' },
        { label: 'Projects', href: '/projects' },
      ]}
      title={title}
      parentPath="/projects"
      list={list}
    >
      {state.status === 'loading' && (
        <SheetPlaceholder
          kicker="Project"
          heading="Loading project…"
          body="Reading the project manifest and its owned files."
        />
      )}
      {state.status === 'error' &&
        (state.failure.status === 404 ? (
          <PagePlaceholder
            glyph="▣"
            heading="Project not found"
            body={`There is no project with id "${projectId}" in this workspace.`}
            actions={
              <Link className="btn primary sm" to="/projects">
                Back to projects
              </Link>
            }
          />
        ) : (
          <PagePlaceholder
            glyph="◌"
            heading="Project unavailable"
            body={
              errorTextOf(state.failure.body) ??
              'The project could not be loaded.'
            }
            actions={
              <button className="btn primary sm" type="button" onClick={reload}>
                Retry
              </button>
            }
          />
        ))}
      {detail !== null && (
        <div className="sheet wide">
          <div className="chead rise">
            <p className="kick">
              <span className="chip">{detail.id}</span>{' '}
              <span className="chip">{detail.path}</span>
            </p>
            <h1>{detail.title}</h1>
            <p className="sub">{detail.summary ?? 'No summary yet.'}</p>
            <div className="meta">
              {detail.topics.map((topic) => (
                <span className="tag" key={topic}>
                  {topicLabel(topic)}
                </span>
              ))}
              <span>{chatCountLabel(detail.chatCount)}</span>
              <span>·</span>
              <span>{fileCountLabel(detail.ownedFiles.length)}</span>
              <span>·</span>
              <span>
                last activity{' '}
                {detail.lastActivity === null
                  ? 'unknown'
                  : relativeTime(detail.lastActivity, now)}
              </span>
            </div>
            <div className="actions">
              {detail.summaryDocument === null ? (
                <button
                  className="btn sm"
                  type="button"
                  disabled
                  data-testid="project-summary-edit"
                >
                  Edit summary
                </button>
              ) : (
                <Link
                  className="btn sm"
                  data-testid="project-summary-edit"
                  to={editHref(detail.summaryDocument.path)}
                >
                  Edit summary
                </Link>
              )}
              <button
                className="btn ghost sm"
                type="button"
                onClick={() => {
                  repoPathRef.current?.scrollIntoView({ block: 'center' });
                  repoPathRef.current?.focus();
                }}
              >
                Register repository
              </button>
              <Link
                className="btn ghost sm"
                to={`/search?project=${projectId}`}
              >
                Search project
              </Link>
            </div>
          </div>

          {chatNotice !== null && (
            <NoticeBox
              notice={chatNotice}
              onChatRetry={(retry) => {
                void membership(retry.chatId, retry.change);
              }}
              onRepoRetry={() => {
                void registerRepository();
              }}
            />
          )}

          <div className="cards-2 rise" style={{ marginBottom: 34 }}>
            <section className="card lift">
              <p className="ct">Resources</p>
              {detail.resources.length === 0 ? (
                <p className="cs">No linked resources.</p>
              ) : (
                <dl
                  className="kv resource-kv"
                  style={{ marginTop: 12 }}
                  data-testid="project-resources"
                >
                  {detail.resources.map((resource) => (
                    <ResourceRow key={resource.id} resource={resource} />
                  ))}
                </dl>
              )}
              <p className="cm">
                <span>
                  <b>{detail.ownedFiles.length}</b> files total
                </span>
              </p>
            </section>

            <section className="card lift" data-testid="project-repos">
              <p className="ct">Repositories</p>
              <div
                style={{
                  marginTop: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                {detail.repositories.length === 0 ? (
                  <p className="cs">No repositories registered.</p>
                ) : (
                  detail.repositories.map((repository) => (
                    <div key={repository.id}>
                      <p style={{ fontWeight: 600, fontSize: 13 }}>
                        <span
                          className="dot"
                          style={{
                            background:
                              repository.state === 'live'
                                ? 'var(--dot-ochre)'
                                : 'var(--dot-steel)',
                            marginRight: 8,
                          }}
                        />
                        {repositoryName(repository)}{' '}
                        <span
                          className={`tag ${repository.state === 'live' ? 'proj' : 'inbox'}`}
                          style={{ marginLeft: 6 }}
                        >
                          {repository.state === 'live' ? 'live' : 'missing'}
                        </span>
                      </p>
                      <p
                        className="mono"
                        style={{
                          fontSize: 11,
                          color: 'var(--faint)',
                          marginTop: 4,
                          marginLeft: 17,
                        }}
                      >
                        {repository.path ?? 'path not recorded'}
                      </p>
                    </div>
                  ))
                )}
                <p className="fnote">
                  Registered repositories stay where they are; FieldWork only
                  reads them during search and context.
                </p>
              </div>

              <div style={{ marginTop: 16 }} data-testid="repo-register">
                <p
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--muted)',
                    marginBottom: 10,
                  }}
                >
                  Register a repository
                </p>
                <div className="field">
                  <p className="fl">Path</p>
                  <input
                    ref={repoPathRef}
                    className="input mono"
                    type="text"
                    value={repoForm.path}
                    aria-label="Repository path"
                    onChange={(event) => {
                      setRepoForm({
                        ...repoForm,
                        path: event.currentTarget.value,
                      });
                    }}
                  />
                </div>
                <div className="grid2">
                  <div className="field">
                    <p className="fl">
                      ID <span>optional</span>
                    </p>
                    <input
                      className="input mono"
                      type="text"
                      value={repoForm.id}
                      aria-label="Repository id"
                      onChange={(event) => {
                        setRepoForm({
                          ...repoForm,
                          id: event.currentTarget.value,
                        });
                      }}
                    />
                  </div>
                  <div className="field">
                    <p className="fl">
                      Title <span>optional</span>
                    </p>
                    <input
                      className="input"
                      type="text"
                      value={repoForm.title}
                      aria-label="Repository title"
                      onChange={(event) => {
                        setRepoForm({
                          ...repoForm,
                          title: event.currentTarget.value,
                        });
                      }}
                    />
                  </div>
                </div>
                <div className="field">
                  <p className="fl">
                    Remote <span>optional</span>
                  </p>
                  <input
                    className="input mono"
                    type="text"
                    value={repoForm.remote}
                    aria-label="Repository remote"
                    onChange={(event) => {
                      setRepoForm({
                        ...repoForm,
                        remote: event.currentTarget.value,
                      });
                    }}
                  />
                </div>
                {repoNotice !== null && (
                  <NoticeBox
                    notice={repoNotice}
                    onChatRetry={(retry) => {
                      void membership(retry.chatId, retry.change);
                    }}
                    onRepoRetry={() => {
                      void registerRepository();
                    }}
                  />
                )}
                <button
                  className="btn primary sm"
                  type="button"
                  disabled={repoPending}
                  onClick={() => {
                    void registerRepository();
                  }}
                >
                  {repoPending ? 'Registering…' : 'Register repository'}
                </button>
              </div>
            </section>
          </div>

          <section className="sect">
            <p className="sl">Owned files</p>
            {detail.ownedFiles.length === 0 ? (
              <p className="fnote">No files owned by this project.</p>
            ) : (
              <table className="tbl ftable rise" data-testid="project-files">
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Kind</th>
                    <th className="num">Size</th>
                    <th className="num">Modified</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.ownedFiles.map((file) => (
                    <tr key={file.path}>
                      <td data-th="">
                        <Link className="link" to={editHref(file.path)}>
                          {file.title}
                        </Link>
                        <span className="id">{file.path}</span>
                      </td>
                      <td data-th="Kind">
                        <span className="tag dim">{file.kind}</span>
                      </td>
                      <td data-th="Size" className="num mono">
                        {humanizeBytes(file.sizeBytes)}
                      </td>
                      <td data-th="Modified" className="num mono">
                        {relativeTime(file.modifiedAt, now)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="sect">
            <p className="sl">Referencing objects</p>
            {detail.inboundReferences.length === 0 ? (
              <p className="fnote">Nothing references this project yet.</p>
            ) : (
              <table className="tbl rise" data-testid="project-references">
                <thead>
                  <tr>
                    <th>Object</th>
                    <th>Kind</th>
                    <th>Relationship</th>
                    <th className="num">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.inboundReferences.map((reference) => (
                    <tr key={`${reference.sourceKind}:${reference.sourceId}`}>
                      <td data-th="">{referenceLink(reference)}</td>
                      <td data-th="Kind">
                        <span className="tag dim">{reference.sourceKind}</span>
                      </td>
                      <td
                        data-th="Relationship"
                        style={{ color: 'var(--muted)' }}
                      >
                        {reference.relation}
                      </td>
                      <td
                        data-th="Updated"
                        className="num mono"
                        style={{
                          fontSize: '11.5px',
                          color: 'var(--faint)',
                        }}
                      >
                        {reference.updated === null
                          ? ''
                          : relativeTime(reference.updated, now)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </AppShell>
  );
}

function ResourceRow({ resource }: { resource: ProjectResourceEntry }) {
  return (
    <>
      <dt>{resourceNode(resource)}</dt>
      <dd className="mono" style={{ fontSize: '11.5px' }}>
        {resourceDetailText(resource)}
      </dd>
    </>
  );
}

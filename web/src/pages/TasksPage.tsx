import { useCallback, useState } from 'react';

import { getJson, postJson } from '../shared/api.js';
import { ProjectMultiSelect } from '../shared/controls/index.js';
import { errorTextOf } from '../shared/responses.js';
import { Link, navigate } from '../shared/router.js';
import { AppShell } from '../shared/shell/AppShell.js';
import { PagePlaceholder, SheetPlaceholder } from './stub.js';
import {
  deadlineForPreset,
  deadlinePresetLabels,
  deadlinePresets,
  deadlineText,
  defaultDeadlinePreset,
  formatPickedLabel,
  isRecord,
  parseQuickAdd,
  parseTaskList,
  parseTaskView,
  projectTagLabel,
  projectTitles,
  snoozePayload,
  statusPayload,
  taskSections,
  type DeadlinePreset,
  type TaskSectionKey,
  type TaskView,
} from './tasksModel.js';
import { useApiResource } from './useApiResource.js';

const sectionLabels: Record<TaskSectionKey, string> = {
  overdue: 'Overdue',
  active: 'Active',
  upcoming: 'Upcoming',
  done: 'Done',
};

function draftRouteOf(data: unknown): string | null {
  if (!isRecord(data)) return null;
  const draft = data.draft;
  if (!isRecord(draft)) return null;
  return typeof draft.route === 'string' && draft.route !== ''
    ? draft.route
    : null;
}

function TaskComposer({ onCreated }: { onCreated: () => void }) {
  const [text, setText] = useState('');
  const [preset, setPreset] = useState<DeadlinePreset>(defaultDeadlinePreset);
  const [picked, setPicked] = useState('');
  const [projects, setProjects] = useState<string[]>([]);
  const [busy, setBusy] = useState<'add' | 'open' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const parsed = parseQuickAdd(text);
  const canSubmit = parsed !== null && busy === null;
  const pickLabel =
    picked === '' ? deadlinePresetLabels.pick : formatPickedLabel(picked);

  const submit = async (openChat: boolean) => {
    if (parsed === null) {
      setNotice('Write a task first.');
      return;
    }
    setBusy(openChat ? 'open' : 'add');
    setNotice(null);
    const payload: Record<string, unknown> = { text };
    if (projects.length > 0) payload.projects = projects;
    const deadline = deadlineForPreset(preset, new Date(), picked);
    if (deadline !== undefined) payload.deadline = deadline;
    const route = openChat ? '/api/tasks/add-open-chat' : '/api/tasks';
    const outcome = await postJson<unknown>(route, payload);
    setBusy(null);
    if (!outcome.ok) {
      setNotice(
        errorTextOf(outcome.failure.body) ?? 'The task could not be created.',
      );
      return;
    }
    setText('');
    setProjects([]);
    setPreset(defaultDeadlinePreset);
    setPicked('');
    if (openChat) {
      navigate(draftRouteOf(outcome.data) ?? '/chats/new');
    }
    onCreated();
  };

  return (
    <section className="sect">
      <p className="sl">New task</p>
      <div className="card rise" style={{ padding: '16px 18px' }}>
        <div className="field" style={{ marginBottom: 14 }}>
          <textarea
            className="textarea"
            style={{ minHeight: 76 }}
            placeholder="Write the task. The first line is the title, the rest is the description"
            aria-label="New task text"
            data-testid="task-quickadd"
            value={text}
            onChange={(event) => {
              setText(event.currentTarget.value);
            }}
          />
        </div>
        <div
          className="checks"
          style={{ marginBottom: 4 }}
          data-single
          data-testid="task-deadline-presets"
        >
          {deadlinePresets.map((key) => {
            const on = preset === key;
            const label =
              key === 'pick' ? pickLabel : deadlinePresetLabels[key];
            return (
              <button
                key={key}
                type="button"
                className={on ? 'check on' : 'check'}
                aria-pressed={on}
                data-testid={`task-preset-${key}`}
                onClick={() => {
                  setPreset(key);
                }}
              >
                <i />
                {label}
              </button>
            );
          })}
        </div>
        <input
          className="input mono tpick"
          data-time-input
          type="datetime-local"
          aria-label="Pick a deadline"
          data-testid="task-pick-time"
          value={picked}
          style={{
            display: preset === 'pick' ? 'block' : 'none',
            marginBottom: 14,
          }}
          onChange={(event) => {
            setPicked(event.currentTarget.value);
          }}
        />
        <div style={{ marginBottom: 16 }}>
          <ProjectMultiSelect
            selected={projects}
            onChange={setProjects}
            ariaLabel="Task projects"
            disabled={busy !== null}
          />
        </div>
        <div
          style={{
            display: 'flex',
            gap: 10,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <button
            className="btn primary sm"
            type="button"
            data-testid="task-add"
            disabled={!canSubmit}
            onClick={() => {
              void submit(false);
            }}
          >
            {busy === 'add' ? 'Adding…' : 'Add task'}
          </button>
          <button
            className="btn sm"
            type="button"
            data-testid="task-add-open-chat"
            disabled={!canSubmit}
            onClick={() => {
              void submit(true);
            }}
          >
            {busy === 'open' ? 'Adding…' : 'Add & open chat'}
          </button>
        </div>
        {notice !== null && (
          <div
            className="note"
            data-testid="task-compose-error"
            style={{ borderLeftColor: 'var(--danger)', marginTop: 14 }}
          >
            {notice}
          </div>
        )}
      </div>
    </section>
  );
}

function TaskCard({
  task,
  now,
  titles,
  pending,
  onDone,
  onSnooze,
  onOpenChat,
}: {
  task: TaskView;
  now: Date;
  titles: ReadonlyMap<string, string>;
  pending: string | undefined;
  onDone: (task: TaskView) => void;
  onSnooze: (task: TaskView, duration: string) => void;
  onOpenChat: (task: TaskView) => void;
}) {
  const busy = pending !== undefined;
  const done = task.status === 'done';
  return (
    <div
      className={`task${task.overdue ? ' overdue' : ''}${done ? ' done' : ''}`}
      data-testid={`task-card-${task.id}`}
    >
      <button
        className="tcheck"
        type="button"
        data-testid={done ? `task-reopen-${task.id}` : `task-done-${task.id}`}
        aria-label={done ? 'Mark as not done' : 'Mark as done'}
        aria-pressed={done}
        disabled={busy}
        onClick={() => {
          onDone(task);
        }}
      />
      <div className="tmain">
        <p className="tt">{task.title}</p>
        {task.description !== '' && <p className="td">{task.description}</p>}
        <p className="tmt">
          <span className="dued">{deadlineText(task, now)}</span>
          {task.projects.length === 0 ? (
            <span className="tag">no project</span>
          ) : (
            task.projects.map((id) => (
              <span className="tag" key={id}>
                {projectTagLabel(id, titles)}
              </span>
            ))
          )}
        </p>
      </div>
      <div className="tact">
        {!done && (
          <span className="snz">
            <button
              className="sbtn"
              type="button"
              data-testid={`task-snooze-30m-${task.id}`}
              disabled={busy}
              onClick={() => {
                onSnooze(task, '30m');
              }}
            >
              +30m
            </button>
            <button
              className="sbtn"
              type="button"
              data-testid={`task-snooze-1h-${task.id}`}
              disabled={busy}
              onClick={() => {
                onSnooze(task, '1h');
              }}
            >
              +1h
            </button>
          </span>
        )}
        <button
          className={done ? 'btn ghost sm' : 'btn primary sm'}
          type="button"
          data-testid={`task-open-chat-${task.id}`}
          disabled={busy}
          onClick={() => {
            onOpenChat(task);
          }}
        >
          Open chat
        </button>
      </div>
    </div>
  );
}

export function TasksPage() {
  const { state, reload } = useApiResource<unknown>('/api/tasks');
  const projectsResource = useApiResource<unknown>('/api/projects');
  const [notice, setNotice] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, string>>({});
  const now = new Date();

  const clearPending = useCallback((id: string) => {
    setPending((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
  }, []);

  const fetchHash = useCallback(async (id: string): Promise<string | null> => {
    const outcome = await getJson<unknown>(
      `/api/tasks/${encodeURIComponent(id)}`,
    );
    if (!outcome.ok) return null;
    const raw = isRecord(outcome.data) ? outcome.data.task : null;
    const task = parseTaskView(raw);
    return task?.contentHash ?? null;
  }, []);

  // Runs one hash-guarded mutation. On a 409 it refetches, shows an inline
  // conflict notice, and retries the same mutation once with the fresh hash.
  const mutate = useCallback(
    async (
      task: TaskView,
      action: string,
      route: (hash: string) => string,
      payload: (hash: string) => Record<string, unknown>,
    ) => {
      setPending((previous) => ({ ...previous, [task.id]: action }));
      setNotice(null);
      setConflict(null);
      let outcome = await postJson<unknown>(
        route(task.contentHash),
        payload(task.contentHash),
      );
      if (!outcome.ok && outcome.failure.status === 409) {
        const fresh = outcome.failure.currentHash ?? (await fetchHash(task.id));
        setConflict(
          `'${task.title}' changed elsewhere. Retried with the latest version.`,
        );
        reload();
        if (fresh !== null && fresh !== task.contentHash) {
          outcome = await postJson<unknown>(route(fresh), payload(fresh));
        }
      }
      clearPending(task.id);
      if (!outcome.ok) {
        setNotice(
          errorTextOf(outcome.failure.body) ?? 'The task could not be updated.',
        );
        return;
      }
      reload();
    },
    [clearPending, fetchHash, reload],
  );

  const onDone = useCallback(
    (task: TaskView) => {
      const done = task.status === 'done';
      const suffix = done ? 'reopen' : 'done';
      void mutate(
        task,
        suffix,
        () => `/api/tasks/${encodeURIComponent(task.id)}/${suffix}`,
        (hash) => statusPayload(hash),
      );
    },
    [mutate],
  );

  const onSnooze = useCallback(
    (task: TaskView, duration: string) => {
      void mutate(
        task,
        `snooze-${duration}`,
        () => `/api/tasks/${encodeURIComponent(task.id)}/snooze`,
        (hash) => ({ ...snoozePayload({ duration }), expectedHash: hash }),
      );
    },
    [mutate],
  );

  const onOpenChat = useCallback(
    async (task: TaskView) => {
      setPending((previous) => ({ ...previous, [task.id]: 'open' }));
      setNotice(null);
      const outcome = await postJson<unknown>(
        `/api/tasks/${encodeURIComponent(task.id)}/open-chat`,
        {},
      );
      clearPending(task.id);
      if (!outcome.ok) {
        setNotice(
          errorTextOf(outcome.failure.body) ?? 'The chat could not be opened.',
        );
        return;
      }
      navigate(draftRouteOf(outcome.data) ?? '/chats/new');
    },
    [clearPending],
  );

  const data = state.status === 'ready' ? parseTaskList(state.data) : null;
  const titles =
    projectsResource.state.status === 'ready'
      ? projectTitles(projectsResource.state.data)
      : new Map<string, string>();
  const sections = data === null ? [] : taskSections(data.groups);
  const visibleSections = sections.filter(
    (section) => section.tasks.length > 0,
  );
  const total = data?.tasks.length ?? 0;
  const activeCount = data?.groups.active.length ?? 0;
  const overdueCount = data?.groups.overdue.length ?? 0;
  const doneCount = data?.groups.done.length ?? 0;

  const loading = state.status === 'loading';
  const failed = state.status === 'error';

  const list = (
    <>
      <div className="lh">
        <div className="top">
          <span className="t">Filters</span>
        </div>
        {!loading && !failed && (
          <div className="ftabs">
            <span className="ftab on">All · {total}</span>
            <span className="ftab">Active · {activeCount}</span>
            <span className="ftab">Overdue · {overdueCount}</span>
            <span className="ftab">Done · {doneCount}</span>
          </div>
        )}
      </div>
      <div className="rows">
        <div className="card rise" style={{ margin: 14, borderRadius: 12 }}>
          <p className="ct" style={{ fontSize: 13 }}>
            From chats
          </p>
          <p className="cs" style={{ fontSize: 12.5 }}>
            Promote any chat into a task when a thread turns into work, or start
            tasks blank and attach a project later.
          </p>
          <p className="cm">
            <Link className="link" to="/chats">
              browse chats →
            </Link>
          </p>
        </div>
        <div className="card rise" style={{ margin: 14, borderRadius: 12 }}>
          <p className="ct" style={{ fontSize: 13 }}>
            Reminders
          </p>
          <p className="cs" style={{ fontSize: 12.5 }}>
            A crossed deadline only gets louder. The card turns, and stays that
            way until you snooze it or mark it done. Nothing is ever
            auto-deleted.
          </p>
        </div>
        <div className="card rise" style={{ margin: 14, borderRadius: 12 }}>
          <p className="ct" style={{ fontSize: 13 }}>
            Kept where?
          </p>
          <p className="cs" style={{ fontSize: 12.5 }}>
            Tasks live as ordinary Markdown under{' '}
            <span className="mono" style={{ fontSize: 11 }}>
              tasks/
            </span>{' '}
            next to your chats, so agents can pick them up too.
          </p>
        </div>
      </div>
      {!loading && !failed && (
        <div className="lfoot">
          <span>
            {total} {total === 1 ? 'task' : 'tasks'} · {overdueCount}{' '}
            {overdueCount === 1 ? 'needs' : 'need'} action
          </span>
        </div>
      )}
    </>
  );

  return (
    <AppShell breadcrumb={[]} title="Tasks" parentPath="/" list={list}>
      {loading && (
        <SheetPlaceholder
          kicker="Tracker"
          heading="Loading tasks…"
          body="Reading tracked work from the workspace."
        />
      )}
      {failed && (
        <PagePlaceholder
          glyph="◌"
          heading="Tasks unavailable"
          body={
            state.status === 'error'
              ? (errorTextOf(state.failure.body) ??
                'The task list could not be loaded.')
              : 'The task list could not be loaded.'
          }
          actions={
            <button className="btn primary sm" type="button" onClick={reload}>
              Retry
            </button>
          }
        />
      )}
      {data !== null && (
        <div className="sheet wide">
          <div className="chead rise">
            <p className="kick">Tracker</p>
            <h1>Tasks</h1>
            <p className="sub">
              Lightweight to-dos that can grow into chats. Attach a project when
              it becomes clear, or never.
            </p>
          </div>

          {conflict !== null && (
            <div
              className="note"
              data-testid="task-conflict"
              style={{ borderLeftColor: 'var(--warn)', marginBottom: 16 }}
            >
              {conflict}
            </div>
          )}
          {notice !== null && (
            <div
              className="note"
              data-testid="task-notice"
              style={{ borderLeftColor: 'var(--danger)', marginBottom: 16 }}
            >
              {notice}
            </div>
          )}

          <TaskComposer onCreated={reload} />

          <div data-testid="task-list">
            {visibleSections.length === 0 ? (
              <section className="sect">
                <div className="card rise" style={{ padding: '16px 18px' }}>
                  <p className="ct">No tasks yet</p>
                  <p className="cs">
                    Add one above, or promote a chat into a task when a thread
                    turns into work.
                  </p>
                </div>
              </section>
            ) : (
              visibleSections.map((section) => (
                <section
                  className="sect"
                  key={section.key}
                  data-testid={`task-group-${section.key}`}
                >
                  <p className="sl">
                    {sectionLabels[section.key]}{' '}
                    <span className="cnt">
                      {section.key === 'overdue'
                        ? `${section.tasks.length} · needs action`
                        : section.tasks.length}
                    </span>
                  </p>
                  <div className="rise">
                    {section.tasks.map((task) => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        now={now}
                        titles={titles}
                        pending={pending[task.id]}
                        onDone={onDone}
                        onSnooze={onSnooze}
                        onOpenChat={(entry) => {
                          void onOpenChat(entry);
                        }}
                      />
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>
        </div>
      )}
    </AppShell>
  );
}

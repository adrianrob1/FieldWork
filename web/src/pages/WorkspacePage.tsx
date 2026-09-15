import { Link } from '../shared/router.js';
import { useStagger } from '../shared/controls/index.js';
import {
  toChatListEntries,
  type ChatListEntry,
} from '../shared/projects/catalog.js';
import {
  useProjectCatalog,
  type ProjectCatalog,
} from '../shared/projects/useProjectCatalog.js';
import { errorTextOf } from '../shared/responses.js';
import { AppShell } from '../shared/shell/AppShell.js';
import { PagePlaceholder, SheetPlaceholder } from './stub.js';
import { projectRepoLabel } from './projectsModel.js';
import {
  deadlineText,
  parseTaskList,
  projectTagLabel,
  projectTitles,
  type TaskView,
} from './tasksModel.js';
import { useApiResource } from './useApiResource.js';
import {
  activityKindLabel,
  activityTagClass,
  activityTarget,
  priorityTasks,
  recentChats,
  relativeTime,
  toWorkspaceSnapshot,
  topicLabel,
  type ActivityEntry,
} from './workspaceModel.js';

const workspaceChip = <span className="chip">workspace.yml</span>;

const projectDotColors = [
  'var(--dot-ochre)',
  'var(--dot-steel)',
  'var(--dot-sage)',
] as const;

type ResourceStatus = 'loading' | 'ready' | 'error';

function WorkspaceProjects({ catalog }: { catalog: ProjectCatalog }) {
  const { status, projects, details } = catalog;
  if (status === 'error') return null;
  return (
    <section className="sect" data-testid="workspace-projects">
      <p className="sl">
        Projects{' '}
        <Link className="link" to="/projects">
          all →
        </Link>
      </p>
      {status === 'loading' ? (
        <div className="cards-3 rise">
          <section className="card lift">
            <p className="cs">Loading projects…</p>
          </section>
        </div>
      ) : projects.length === 0 ? (
        <p className="fnote">No projects yet.</p>
      ) : (
        <div className="cards-3 rise">
          {projects.map((project, index) => {
            const detail = details[project.id] ?? null;
            const repositories = detail?.repositories ?? project.repositories;
            const repoLabel = projectRepoLabel(repositories);
            const summary =
              project.summary ??
              (project.topics.length > 0
                ? project.topics.map(topicLabel).join(', ')
                : '');
            return (
              <Link
                key={project.id}
                className="card lift"
                style={{ textDecoration: 'none', color: 'inherit' }}
                to={`/projects/${project.id}`}
                data-testid={`workspace-project-${project.id}`}
              >
                <p className="ct">
                  <span
                    className="dot"
                    style={{
                      background:
                        projectDotColors[index % projectDotColors.length] ??
                        projectDotColors[0],
                    }}
                  />
                  {project.title}
                </p>
                {summary !== '' && <p className="cs">{summary}</p>}
                <p className="cm">
                  <span>
                    <b>{detail?.chatCount ?? '…'}</b>{' '}
                    {detail?.chatCount === 1 ? 'chat' : 'chats'}
                  </span>
                  <span>
                    <b>{detail?.ownedFiles.length ?? '…'}</b>{' '}
                    {detail?.ownedFiles.length === 1 ? 'file' : 'files'}
                  </span>
                  {repoLabel !== null && <span>{repoLabel}</span>}
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}

function workspaceActions() {
  return (
    <>
      <Link className="btn primary sm" to="/chats/new">
        Start a chat
      </Link>
      <Link className="btn sm" to="/search">
        Search documents
      </Link>
      <Link className="btn sm" to="/projects">
        Browse projects
      </Link>
    </>
  );
}

// Recent chats reuse the list-pane row shape (title + relative time + project
// tags), collected inside a single bordered card so the overview reads like a
// compact list rather than loose rows.
function RecentChatsSection({
  chats,
  titles,
  status,
  now,
}: {
  chats: readonly ChatListEntry[];
  titles: ReadonlyMap<string, string>;
  status: ResourceStatus;
  now: Date;
}) {
  const rise = useStagger(chats.length);
  return (
    <section className="sect" data-testid="workspace-recent-chats">
      <p className="sl">
        Recent chats{' '}
        <Link className="link" to="/chats">
          all →
        </Link>
      </p>
      {status === 'loading' ? (
        <p className="fnote">Loading chats…</p>
      ) : status === 'error' ? (
        <p className="fnote">Recent chats could not be loaded.</p>
      ) : chats.length === 0 ? (
        <p className="fnote">No chats yet.</p>
      ) : (
        <div className="card rise" style={{ padding: 0, overflow: 'hidden' }}>
          {chats.map((chat, index) => {
            const updated = chat.updated ?? chat.created;
            return (
              <Link
                className="row"
                key={chat.id}
                to={`/chats/${encodeURIComponent(chat.id)}`}
                data-testid={`workspace-recent-chat-${chat.id}`}
                style={rise[index]}
              >
                <p className="rt">{chat.title}</p>
                <p className="rd">
                  {updated === null ? '' : relativeTime(updated, now)}
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
        </div>
      )}
    </section>
  );
}

// Priority tasks are read-only here: the same task card look, but each row is a
// link to the tracker instead of carrying done/snooze controls. Overdue tasks
// keep the existing red treatment.
function PriorityTasksSection({
  tasks,
  status,
  now,
}: {
  tasks: readonly TaskView[];
  status: ResourceStatus;
  now: Date;
}) {
  const rise = useStagger(tasks.length);
  return (
    <section className="sect" data-testid="workspace-priority-tasks">
      <p className="sl">
        Priority tasks{' '}
        <Link className="link" to="/tasks">
          all →
        </Link>
      </p>
      {status === 'loading' ? (
        <p className="fnote">Loading tasks…</p>
      ) : status === 'error' ? (
        <p className="fnote">Priority tasks could not be loaded.</p>
      ) : tasks.length === 0 ? (
        <p className="fnote">No active tasks.</p>
      ) : (
        <div className="rise">
          {tasks.map((task, index) => (
            <Link
              key={task.id}
              className={task.overdue ? 'task overdue' : 'task'}
              style={{
                textDecoration: 'none',
                color: 'inherit',
                ...(rise[index] ?? {}),
              }}
              to="/tasks"
              data-testid={`workspace-priority-task-${task.id}`}
            >
              <div className="tmain">
                <p className="tt">{task.title}</p>
                <p className="tmt">
                  <span className="dued">{deadlineText(task, now)}</span>
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

function ActivityList({
  entries,
  now,
}: {
  entries: readonly ActivityEntry[];
  now: Date;
}) {
  const stagger = useStagger(entries.length);
  if (entries.length === 0) {
    return (
      <>
        <div className="lh">
          <div className="top">
            <span className="t">Recent activity</span>
          </div>
        </div>
        <div className="rows">
          <p className="stub-note">No recent activity yet.</p>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="lh">
        <div className="top">
          <span className="t">Recent activity</span>
          <span className="f">this week</span>
        </div>
      </div>
      <div className="rows rise" data-testid="recent-activity">
        {entries.map((entry, index) => (
          <Link
            key={`${entry.kind}:${entry.path}`}
            className="row"
            to={activityTarget(entry)}
            style={stagger[index]}
          >
            <p className="rt">{entry.title}</p>
            <p className="rd">{relativeTime(entry.modifiedAt, now)}</p>
            <p className="rp">{entry.path}</p>
            <p className="tags">
              <span className={`tag ${activityTagClass(entry.kind)}`}>
                {activityKindLabel(entry.kind)}
              </span>
            </p>
          </Link>
        ))}
      </div>
      <div className="lfoot">
        <span>
          {entries.length} {entries.length === 1 ? 'event' : 'events'}
        </span>
      </div>
    </>
  );
}

export function WorkspacePage() {
  const { state, reload } = useApiResource<unknown>('/api/workspace');
  const chatsResource = useApiResource<unknown>('/api/chats?view=all');
  const tasksResource = useApiResource<unknown>('/api/tasks');
  const catalog = useProjectCatalog();
  const snapshot =
    state.status === 'ready' ? toWorkspaceSnapshot(state.data) : null;
  const now = new Date();
  const title =
    snapshot !== null && snapshot.title !== null && snapshot.title.trim() !== ''
      ? snapshot.title
      : 'Workspace';

  const recent =
    chatsResource.state.status === 'ready'
      ? recentChats(toChatListEntries(chatsResource.state.data))
      : [];
  const chatTitles =
    chatsResource.state.status === 'ready'
      ? projectTitles(chatsResource.state.data)
      : new Map<string, string>();
  const taskList =
    tasksResource.state.status === 'ready'
      ? parseTaskList(tasksResource.state.data)
      : null;
  const priority = taskList === null ? [] : priorityTasks(taskList.tasks);

  const list =
    state.status === 'loading' ? (
      <>
        <div className="lh">
          <div className="top">
            <span className="t">Recent activity</span>
          </div>
        </div>
        <div className="rows">
          <p className="stub-note">Loading recent activity…</p>
        </div>
      </>
    ) : state.status === 'error' ? (
      <>
        <div className="lh">
          <div className="top">
            <span className="t">Recent activity</span>
          </div>
        </div>
        <div className="rows">
          <p className="stub-note">Recent activity could not be loaded.</p>
        </div>
      </>
    ) : (
      <ActivityList entries={snapshot?.recentActivity ?? []} now={now} />
    );

  return (
    <AppShell breadcrumb={[]} title={title} parentPath="/" list={list}>
      {state.status === 'loading' && (
        <SheetPlaceholder
          kicker="Overview"
          heading="Loading workspace…"
          body="Reading the workspace files and refreshing the derived index."
        />
      )}
      {state.status === 'error' && (
        <PagePlaceholder
          glyph="◌"
          heading="Workspace unavailable"
          body={
            errorTextOf(state.failure.body) ??
            'The workspace summary could not be loaded.'
          }
          actions={
            <button className="btn primary sm" type="button" onClick={reload}>
              Retry
            </button>
          }
        />
      )}
      {snapshot !== null && (
        <div className="sheet wide">
          <div className="chead rise">
            <p className="kick">Overview {workspaceChip}</p>
            <h1>{title}</h1>
            <p className="sub">
              Local-first workspace. The filesystem is the canonical record.
              Derived state lives under .workspace/ and can be rebuilt from the
              files at any time.
            </p>
            <div className="actions">{workspaceActions()}</div>
          </div>

          <RecentChatsSection
            chats={recent}
            titles={chatTitles}
            status={chatsResource.state.status}
            now={now}
          />
          <PriorityTasksSection
            tasks={priority}
            status={tasksResource.state.status}
            now={now}
          />
          <WorkspaceProjects catalog={catalog} />
        </div>
      )}
    </AppShell>
  );
}

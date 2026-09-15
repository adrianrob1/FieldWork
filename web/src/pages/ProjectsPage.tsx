import { useRef, useState, type KeyboardEvent } from 'react';

import { postJson } from '../shared/api.js';
import { useProjectCatalog } from '../shared/projects/useProjectCatalog.js';
import { navigate, Link } from '../shared/router.js';
import { errorTextOf } from '../shared/responses.js';
import { AppShell } from '../shared/shell/AppShell.js';
import { PagePlaceholder, SheetPlaceholder } from './stub.js';
import {
  chatCountLabel,
  newProjectPayload,
  projectFormErrorsOf,
  projectRowMeta,
  repositoryStateLabel,
  type NewProjectValues,
  type ProjectDetail,
  type ProjectFormErrors,
  type ProjectListEntry,
} from './projectsModel.js';
import { relativeTime, topicLabel } from './workspaceModel.js';

const emptyForm: NewProjectValues = {
  title: '',
  directory: '',
  repositoryPath: '',
};

function ProjectList({
  projects,
  details,
  onRegister,
}: {
  projects: readonly ProjectListEntry[];
  details: Record<string, ProjectDetail | null>;
  onRegister: () => void;
}) {
  const repositoryCount = projects.filter(
    (project) => project.repositories.length > 0,
  ).length;
  return (
    <>
      <div className="lh">
        <div className="top">
          <span className="t">Projects</span>
          <span className="f">by activity</span>
        </div>
      </div>
      <div className="rows rise">
        {projects.map((project) => {
          const detail = details[project.id] ?? undefined;
          const repositories =
            detail === undefined ? project.repositories : detail.repositories;
          const hasRepo = repositories.length > 0;
          return (
            <Link
              key={project.id}
              className="row"
              to={`/projects/${project.id}`}
            >
              <p className="rt">{project.title}</p>
              <p className="rd">
                {detail === undefined ? '…' : chatCountLabel(detail.chatCount)}
              </p>
              <p className="rp">{project.summary ?? project.path}</p>
              <p className="tags">
                <span className="tag acc">{project.id}</span>
                {hasRepo && <span className="tag dim">repo</span>}
              </p>
            </Link>
          );
        })}
        <button
          className="row"
          type="button"
          style={{
            textAlign: 'left',
            background: 'transparent',
            border: 0,
            cursor: 'pointer',
          }}
          onClick={onRegister}
        >
          <p className="rt" style={{ color: 'var(--faint)', fontWeight: 500 }}>
            + Register a project
          </p>
          <p className="rp">point at a directory with a project.yml</p>
        </button>
      </div>
      <div className="lfoot">
        <span>
          {projects.length} {projects.length === 1 ? 'project' : 'projects'}
        </span>
        <span>
          {repositoryCount}{' '}
          {repositoryCount === 1 ? 'repository' : 'repositories'}
        </span>
      </div>
    </>
  );
}

function ProjectsTable({
  projects,
  details,
  now,
}: {
  projects: readonly ProjectListEntry[];
  details: Record<string, ProjectDetail | null>;
  now: Date;
}) {
  return (
    <table className="tbl ptable rise" data-testid="projects-table">
      <thead>
        <tr>
          <th>Project</th>
          <th>Topics</th>
          <th className="num">Chats</th>
          <th className="num">Files</th>
          <th className="num">Repository</th>
          <th className="num">Last activity</th>
        </tr>
      </thead>
      <tbody>
        {projects.map((project) => {
          const detail = details[project.id] ?? undefined;
          const repositories =
            detail === undefined ? project.repositories : detail.repositories;
          const repository = repositoryStateLabel(repositories);
          const chatCount = detail?.chatCount;
          const fileCount = detail?.ownedFiles.length;
          const lastActivity = detail?.lastActivity ?? null;
          const meta =
            detail === undefined
              ? project.title
              : `${project.title}, ${projectRowMeta(detail.chatCount, detail.ownedFiles.length, lastActivity, now)}`;
          return (
            <tr
              key={project.id}
              data-testid={`project-row-${project.id}`}
              tabIndex={0}
              aria-label={meta}
              onClick={(event) => {
                if (event.defaultPrevented) return;
                navigate(`/projects/${project.id}`);
              }}
              onKeyDown={(event: KeyboardEvent<HTMLTableRowElement>) => {
                if (event.key !== 'Enter') return;
                if (event.target !== event.currentTarget) return;
                event.preventDefault();
                navigate(`/projects/${project.id}`);
              }}
            >
              <td data-th="">
                <Link
                  className="link"
                  to={`/projects/${project.id}`}
                  style={{ fontWeight: 600 }}
                >
                  {project.title}
                </Link>
              </td>
              <td data-th="Topics">
                {project.topics.map((topic) => (
                  <span className="tag" key={topic}>
                    {topicLabel(topic)}
                  </span>
                ))}
              </td>
              <td data-th="Chats" className="num">
                {chatCount ?? '…'}
              </td>
              <td data-th="Files" className="num">
                {fileCount ?? '…'}
              </td>
              <td data-th="Repository" className="num">
                {repository.className === '' ? (
                  <span style={{ color: 'var(--faint)' }}>none</span>
                ) : (
                  <span className={`tag ${repository.className}`}>
                    {repository.text}
                  </span>
                )}
              </td>
              <td
                data-th="Last activity"
                className="num mono"
                style={{ color: 'var(--faint)', fontSize: '11.5px' }}
              >
                {lastActivity === null ? '…' : relativeTime(lastActivity, now)}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function FieldError({ messages }: { messages: readonly string[] }) {
  if (messages.length === 0) return null;
  return (
    <p className="fnote" style={{ color: 'var(--danger)' }}>
      {messages.join(' ')}
    </p>
  );
}

export function ProjectsPage() {
  const { status, projects, details, failure, reload } = useProjectCatalog();
  const [form, setForm] = useState<NewProjectValues>(emptyForm);
  const [pending, setPending] = useState(false);
  const [formErrors, setFormErrors] = useState<ProjectFormErrors | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);
  const now = new Date();

  const focusForm = () => {
    titleRef.current?.scrollIntoView({ block: 'center' });
    titleRef.current?.focus();
  };

  const submit = async () => {
    const built = newProjectPayload(form);
    if (!built.ok) {
      setBanner(built.message);
      return;
    }
    setPending(true);
    setBanner(null);
    setFormErrors(null);
    const outcome = await postJson<{ project?: { id?: string } }>(
      '/api/projects',
      built.payload,
    );
    setPending(false);
    if (!outcome.ok) {
      setFormErrors(projectFormErrorsOf(outcome.failure.diagnostics));
      setBanner(
        errorTextOf(outcome.failure.body) ??
          'The project could not be created.',
      );
      return;
    }
    const projectId = outcome.data.project?.id;
    if (projectId === undefined || projectId === '') {
      setBanner('The project was created but no id came back.');
      reload();
      return;
    }
    navigate(`/projects/${projectId}`);
  };

  const list =
    status === 'loading' ? (
      <>
        <div className="lh">
          <div className="top">
            <span className="t">Projects</span>
          </div>
        </div>
        <div className="rows">
          <p className="stub-note">Loading projects…</p>
        </div>
      </>
    ) : status === 'error' ? (
      <>
        <div className="lh">
          <div className="top">
            <span className="t">Projects</span>
          </div>
        </div>
        <div className="rows">
          <p className="stub-note">Projects could not be loaded.</p>
        </div>
      </>
    ) : (
      <ProjectList
        projects={projects}
        details={details}
        onRegister={focusForm}
      />
    );

  return (
    <AppShell
      breadcrumb={[{ label: 'Workspace', href: '/' }]}
      title="Projects"
      parentPath="/"
      list={list}
    >
      {status === 'loading' && (
        <SheetPlaceholder
          kicker="Projects"
          heading="Loading projects…"
          body="Reading project manifests from the workspace."
        />
      )}
      {status === 'error' && (
        <PagePlaceholder
          glyph="◌"
          heading="Projects unavailable"
          body={
            errorTextOf(failure?.body ?? null) ??
            'The project list could not be loaded.'
          }
          actions={
            <button className="btn primary sm" type="button" onClick={reload}>
              Retry
            </button>
          }
        />
      )}
      {status === 'ready' && (
        <div className="sheet wide">
          <div className="chead rise">
            <p className="sub">
              Directories and summaries define ownership. Links and frontmatter
              represent overlap between projects.
            </p>
          </div>

          {projects.length === 0 ? (
            <PagePlaceholder
              glyph="▦"
              heading="No projects yet"
              body="Register a directory with a project.yml to create the first project."
            />
          ) : (
            <section className="sect">
              <ProjectsTable projects={projects} details={details} now={now} />
            </section>
          )}

          <section className="sect">
            <div className="card lift" data-testid="project-register">
              <p className="ct">Register a project</p>
              <p className="cs">
                Point at a directory that will hold a project.yml manifest. The
                project opens as soon as it is created.
              </p>
              <div className="grid2" style={{ marginTop: 14 }}>
                <div className="field">
                  <p className="fl">Title</p>
                  <input
                    ref={titleRef}
                    className="input"
                    type="text"
                    value={form.title}
                    aria-label="Project title"
                    onChange={(event) => {
                      setForm({ ...form, title: event.currentTarget.value });
                    }}
                  />
                  <FieldError messages={formErrors?.title ?? []} />
                </div>
                <div className="field">
                  <p className="fl">
                    Directory <span>relative to projects/</span>
                  </p>
                  <input
                    className="input mono"
                    type="text"
                    value={form.directory}
                    aria-label="Project directory"
                    onChange={(event) => {
                      setForm({
                        ...form,
                        directory: event.currentTarget.value,
                      });
                    }}
                  />
                  <FieldError messages={formErrors?.directory ?? []} />
                </div>
              </div>
              <div className="field">
                <p className="fl">
                  Repository path <span>optional</span>
                </p>
                <input
                  className="input mono"
                  type="text"
                  value={form.repositoryPath}
                  aria-label="Repository path"
                  onChange={(event) => {
                    setForm({
                      ...form,
                      repositoryPath: event.currentTarget.value,
                    });
                  }}
                />
                <FieldError messages={formErrors?.repositoryPath ?? []} />
              </div>
              {banner !== null && <p className="note">{banner}</p>}
              {(formErrors?.unassigned.length ?? 0) > 0 && (
                <ul className="fnote">
                  {formErrors?.unassigned.map((entry) => (
                    <li key={`${entry.code}:${entry.message}`}>
                      {entry.message}
                    </li>
                  ))}
                </ul>
              )}
              <div className="actions" style={{ marginTop: 4 }}>
                <button
                  className="btn primary sm"
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    void submit();
                  }}
                >
                  {pending ? 'Creating…' : 'Create project'}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </AppShell>
  );
}

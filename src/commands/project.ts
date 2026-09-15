import path from 'node:path';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import type { ParsedWorkspaceFile } from '../files/workspace.js';
import { parseWorkspace } from '../files/workspace.js';
import {
  emitResult,
  failureOutcome,
  type CommandContext,
  type CommandOutcome,
} from './output.js';
import { resolveWorkspaceRoot } from './workspace-root.js';

export interface ProjectListItem {
  id: string;
  title: string;
  directory: string;
}

export interface RepositoryView {
  id: string;
  title: string | null;
  resolvedPath: string | null;
  accessible: boolean | null;
}

export interface ChatView {
  id: string;
  title: string;
  file: string;
}

export interface ProjectView {
  id: string;
  title: string;
  summary: string | null;
  topics: string[];
  directory: string;
  repositories: RepositoryView[];
  resources: string[];
  links: string[];
  chats: ChatView[];
  readmeSummaryTitle: string | null;
}

export async function projectListCommand(
  context: CommandContext,
): Promise<number> {
  const resolution = await resolveWorkspaceRoot(context.workspace);
  if (resolution.diagnostic !== null) {
    emitResult(context, 'project list', failureOutcome(resolution.diagnostic));
    return 1;
  }

  const parsed = await parseWorkspace(resolution.root);
  const projects = listProjects(parsed.files);
  const outcome: CommandOutcome = {
    success: true,
    data: { projects },
    diagnostics: parsed.diagnostics,
    human: renderProjectList(projects),
  };
  emitResult(context, 'project list', outcome);
  return 0;
}

export async function projectShowCommand(
  projectId: string,
  context: CommandContext,
): Promise<number> {
  const resolution = await resolveWorkspaceRoot(context.workspace);
  if (resolution.diagnostic !== null) {
    emitResult(context, 'project show', failureOutcome(resolution.diagnostic));
    return 1;
  }

  const parsed = await parseWorkspace(resolution.root);
  const project = parsed.files.find(
    (file) =>
      file.kind === 'project' &&
      typeof file.metadata?.id === 'string' &&
      file.metadata.id === projectId,
  );
  const metadata = project?.metadata ?? null;
  if (project === undefined || metadata === null) {
    emitResult(
      context,
      'project show',
      failureOutcome(missingProjectDiagnostic(resolution.root, projectId)),
    );
    return 1;
  }

  const view = buildProjectView(metadata, project, parsed.files);
  const outcome: CommandOutcome = {
    success: true,
    data: view,
    diagnostics: parsed.diagnostics,
    human: renderProjectView(view),
  };
  emitResult(context, 'project show', outcome);
  return 0;
}

function missingProjectDiagnostic(root: string, projectId: string): Diagnostic {
  return diagnostic(
    root,
    'project.missing',
    'error',
    `Project '${projectId}' was not found in this workspace.`,
  );
}

function listProjects(files: ParsedWorkspaceFile[]): ProjectListItem[] {
  const items = files.flatMap((file): ProjectListItem[] => {
    if (file.kind !== 'project' || !isRecord(file.metadata)) return [];
    const id = file.metadata.id;
    if (typeof id !== 'string') return [];
    return [
      {
        id,
        title: textOf(file.metadata.title),
        directory: path.basename(path.dirname(file.file)),
      },
    ];
  });
  return items.sort((left, right) => compareIds(left.id, right.id));
}

function buildProjectView(
  metadata: Record<string, unknown>,
  project: ParsedWorkspaceFile,
  files: ParsedWorkspaceFile[],
): ProjectView {
  const id = textOf(metadata.id);
  return {
    id,
    title: textOf(metadata.title),
    summary: typeof metadata.summary === 'string' ? metadata.summary : null,
    topics: stringListOf(metadata.topics),
    directory: path.basename(path.dirname(project.file)),
    repositories: repositoriesOf(project, files),
    resources: stringListOf(metadata.resources),
    links: stringListOf(metadata.links),
    chats: chatsAttachedTo(files, id),
    readmeSummaryTitle: readmeSummaryTitle(files, id),
  };
}

function repositoriesOf(
  project: ParsedWorkspaceFile,
  files: ParsedWorkspaceFile[],
): RepositoryView[] {
  const entries = Array.isArray(project.metadata?.repositories)
    ? project.metadata.repositories
    : [];
  const views: RepositoryView[] = [];
  entries.forEach((entry, index) => {
    if (typeof entry === 'string') {
      const resource = files.find((file) => file.metadata?.id === entry);
      const resolution =
        resource?.resolvedPaths.find(
          (candidate) => candidate.fieldPath === 'path',
        ) ?? null;
      views.push({
        id: entry,
        title: resource ? textOf(resource.metadata?.title) : null,
        resolvedPath: resolution?.resolvedPath ?? null,
        accessible: resolution?.accessible ?? null,
      });
      return;
    }
    if (isRecord(entry)) {
      const resolution =
        project.resolvedPaths.find(
          (candidate) => candidate.fieldPath === `repositories.${index}.path`,
        ) ?? null;
      views.push({
        id: textOf(entry.id),
        title: typeof entry.title === 'string' ? entry.title : null,
        resolvedPath: resolution?.resolvedPath ?? null,
        accessible: resolution?.accessible ?? null,
      });
    }
  });
  return views;
}

function chatsAttachedTo(
  files: ParsedWorkspaceFile[],
  projectId: string,
): ChatView[] {
  return files
    .filter(
      (file) =>
        file.kind === 'chat' &&
        stringListOf(file.metadata?.projects).includes(projectId),
    )
    .map((chat) => ({
      id: textOf(chat.metadata?.id),
      title: textOf(chat.metadata?.title),
      file: chat.file,
    }))
    .sort((left, right) => compareIds(left.id, right.id));
}

function readmeSummaryTitle(
  files: ParsedWorkspaceFile[],
  projectId: string,
): string | null {
  for (const file of files) {
    if (file.kind !== 'summary') continue;
    const metadata = file.metadata;
    if (
      metadata === null ||
      metadata.kind !== 'project' ||
      metadata.project !== projectId
    ) {
      continue;
    }
    return typeof metadata.title === 'string' ? metadata.title : null;
  }
  return null;
}

function renderProjectList(projects: ProjectListItem[]): string {
  if (projects.length === 0) return 'No projects found.\n';
  const idWidth = Math.max(...projects.map(({ id }) => id.length));
  const titleWidth = Math.max(...projects.map(({ title }) => title.length));
  const lines = projects.map(
    ({ id, title, directory }) =>
      `${id.padEnd(idWidth)}  ${title.padEnd(titleWidth)}  ${directory}`,
  );
  return `${lines.join('\n')}\n`;
}

function renderProjectView(view: ProjectView): string {
  const lines: string[] = [
    `id: ${view.id}`,
    `title: ${view.title}`,
    `summary: ${view.summary ?? '(none)'}`,
    `topics: ${view.topics.length > 0 ? view.topics.join(', ') : '(none)'}`,
    `directory: ${view.directory}`,
  ];
  if (view.repositories.length === 0) {
    lines.push('repositories: (none)');
  } else {
    lines.push('repositories:');
    for (const repository of view.repositories) {
      lines.push(
        `  ${repository.id}${repository.title === null ? '' : ` ${repository.title}`}`,
      );
      if (repository.resolvedPath === null) {
        lines.push('    path: (unresolved)');
      } else {
        lines.push(`    path: ${repository.resolvedPath}`);
        lines.push(
          `    accessible: ${repository.accessible === true ? 'yes' : 'no'}`,
        );
      }
    }
  }
  lines.push(
    `resources: ${view.resources.length > 0 ? view.resources.join(', ') : '(none)'}`,
  );
  lines.push(
    `links: ${view.links.length > 0 ? view.links.join(', ') : '(none)'}`,
  );
  if (view.chats.length === 0) {
    lines.push('chats: (none)');
  } else {
    lines.push('chats:');
    for (const chat of view.chats) {
      lines.push(`  ${chat.id}  ${chat.title}`);
    }
  }
  lines.push(`readmeSummaryTitle: ${view.readmeSummaryTitle ?? '(none)'}`);
  return `${lines.join('\n')}\n`;
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringListOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

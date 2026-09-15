import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import { parseMarkdownSource } from '../files/frontmatter.js';
import {
  discoverWorkspaceFiles,
  parseWorkspaceFile,
  type ParsedWorkspaceFile,
} from '../files/workspace.js';
import { canonicalPath } from '../index/rows.js';
import {
  editCanonicalFile,
  hashOf,
  singleTrailingNewline,
  type CanonicalWriteOutcome,
  type WriteHooks,
} from './edit.js';
import { refreshDiagnostics } from './register.js';

export type EditableKind = 'chat' | 'summary' | 'resource' | 'task';

export type EditableFieldType = 'text' | 'list';

export interface EditableFieldPolicy {
  field: string;
  type: EditableFieldType;
}

export const editableFieldPolicy: Record<EditableKind, EditableFieldPolicy[]> =
  {
    chat: [
      { field: 'title', type: 'text' },
      { field: 'topics', type: 'list' },
      { field: 'projects', type: 'list' },
      { field: 'provider', type: 'text' },
      { field: 'model', type: 'text' },
    ],
    summary: [
      { field: 'title', type: 'text' },
      { field: 'summary', type: 'text' },
      { field: 'keywords', type: 'list' },
      { field: 'sources', type: 'list' },
      { field: 'reviewed', type: 'text' },
    ],
    resource: [
      { field: 'title', type: 'text' },
      { field: 'topics', type: 'list' },
      { field: 'projects', type: 'list' },
    ],
    task: [
      { field: 'title', type: 'text' },
      { field: 'status', type: 'text' },
      { field: 'deadline', type: 'text' },
      { field: 'projects', type: 'list' },
      { field: 'updated', type: 'text' },
      { field: 'completed', type: 'text' },
    ],
  };

const knownKeysByKind: Record<EditableKind, ReadonlySet<string>> = {
  chat: new Set([
    'id',
    'title',
    'created',
    'updated',
    'projects',
    'topics',
    'provider',
    'model',
    'links',
  ]),
  summary: new Set([
    'id',
    'title',
    'kind',
    'project',
    'summary',
    'keywords',
    'sources',
    'links',
    'reviewed',
  ]),
  resource: new Set([
    'id',
    'title',
    'kind',
    'projects',
    'topics',
    'path',
    'url',
    'source',
    'snapshot',
    'links',
  ]),
  task: new Set([
    'id',
    'title',
    'status',
    'created',
    'updated',
    'deadline',
    'projects',
    'completed',
  ]),
};

export type EditOutcomeStatus =
  'ok' | 'invalid' | 'conflict' | 'notFound' | 'outOfScope';

export interface EditableFileView {
  kind: EditableKind;
  path: string;
  metadata: Record<string, unknown>;
  unknownKeys: string[];
  body: string;
  contentHash: string;
  editableFields: EditableFieldPolicy[];
}

export interface EditFileOutcome {
  status: EditOutcomeStatus;
  view: EditableFileView | null;
  diagnostics: Diagnostic[];
}

export interface FrontmatterPatchInput {
  path: string;
  changes: Record<string, unknown>;
  expectedHash: string | null;
}

export interface BodyEditInput {
  path: string;
  body: string;
  expectedHash: string | null;
}

export interface EditApplyHooks extends WriteHooks {
  afterPreconditionCheck?: ((file: string) => Promise<void>) | undefined;
}

export interface EditApplyOutcome {
  status: EditOutcomeStatus;
  changed: boolean;
  contentHash: string | null;
  diagnostics: Diagnostic[];
}

interface EditTarget {
  file: string;
  kind: EditableKind;
  parsed: ParsedWorkspaceFile;
}

type EditTargetResolution =
  | { ok: true; target: EditTarget }
  | {
      ok: false;
      status: 'invalid' | 'notFound' | 'outOfScope';
      diagnostics: Diagnostic[];
    };

type HashCheck =
  | { stale: false; currentHash: string | null }
  | { stale: true; currentHash: string | null; diagnostic: Diagnostic };

export function checkEditPath(
  root: string,
  relativePath: string,
): { ok: true; file: string } | { ok: false; diagnostic: Diagnostic } {
  const workspaceRoot = path.resolve(root);
  const stored = relativePath.trim();
  const reject = (message: string): { ok: false; diagnostic: Diagnostic } => ({
    ok: false,
    diagnostic: diagnostic(
      workspaceRoot,
      'edit.path_out_of_scope',
      'error',
      message,
      { fieldPath: 'path' },
    ),
  });
  if (stored === '') {
    return reject('The path is empty.');
  }
  if (stored.includes('\\')) {
    return reject(`Paths must use '/' as the separator: ${stored}`);
  }
  if (stored.startsWith('/')) {
    return reject(`The path must be relative to the workspace root: ${stored}`);
  }
  if (stored.startsWith('~')) {
    return reject(`The path must not start with '~': ${stored}`);
  }
  if (path.isAbsolute(stored)) {
    return reject(`The path must be relative to the workspace root: ${stored}`);
  }
  if (stored.split('/').includes('..')) {
    return reject(`The path must not contain '..' segments: ${stored}`);
  }
  const file = path.resolve(workspaceRoot, ...stored.split('/'));
  if (outsideRoot(workspaceRoot, file)) {
    return reject(`The path must stay inside the workspace root: ${stored}`);
  }
  return { ok: true, file };
}

export async function loadEditableFile(
  root: string,
  relativePath: string,
): Promise<EditFileOutcome> {
  const resolution = await resolveEditTarget(root, relativePath);
  if (!resolution.ok) {
    return {
      status: resolution.status,
      view: null,
      diagnostics: resolution.diagnostics,
    };
  }
  const target = resolution.target;
  let bytes: Buffer;
  try {
    bytes = await readFile(target.file);
  } catch (error) {
    return {
      status: 'notFound',
      view: null,
      diagnostics: [
        diagnostic(
          target.file,
          'file.unreadable',
          'error',
          `Could not read file: ${errorMessage(error)}`,
        ),
      ],
    };
  }
  const parsed = parseMarkdownSource(target.file, bytes.toString('utf8'));
  if (parsed.document === null || parsed.diagnostics.length > 0) {
    return {
      status: 'invalid',
      view: null,
      diagnostics: parsed.diagnostics,
    };
  }
  const metadata: unknown = parsed.document.toJS();
  if (!isRecord(metadata)) {
    return {
      status: 'invalid',
      view: null,
      diagnostics: [
        diagnostic(
          target.file,
          'schema.mapping',
          'error',
          'Metadata must contain one top-level mapping.',
        ),
      ],
    };
  }
  const view: EditableFileView = {
    kind: target.kind,
    path: canonicalPath(path.resolve(root), target.file),
    metadata,
    unknownKeys: Object.keys(metadata)
      .filter((key) => !knownKeysByKind[target.kind].has(key))
      .sort(),
    body: parsed.body ?? '',
    contentHash: hashOf(bytes),
    editableFields: editableFieldPolicy[target.kind],
  };
  return {
    status: 'ok',
    view,
    diagnostics: target.parsed.diagnostics,
  };
}

export async function applyFrontmatterPatch(
  root: string,
  input: FrontmatterPatchInput,
  hooks?: EditApplyHooks,
): Promise<EditApplyOutcome> {
  const resolution = await resolveEditTarget(root, input.path);
  if (!resolution.ok) {
    return {
      status: resolution.status,
      changed: false,
      contentHash: null,
      diagnostics: resolution.diagnostics,
    };
  }
  const target = resolution.target;
  const expectedHash =
    input.expectedHash === null ? undefined : input.expectedHash.toLowerCase();
  const allowed = new Set(
    editableFieldPolicy[target.kind].map((policy) => policy.field),
  );
  const disallowed = Object.keys(input.changes).filter(
    (field) => !allowed.has(field),
  );
  if (disallowed.length > 0) {
    return {
      status: 'invalid',
      changed: false,
      contentHash: null,
      diagnostics: disallowed.map((field) =>
        diagnostic(
          target.file,
          'edit.field_not_editable',
          'error',
          `Field '${field}' is not editable for ${target.kind} files.`,
          { fieldPath: field },
        ),
      ),
    };
  }
  const check = await checkExpectedHash(target.file, expectedHash);
  if (check.stale) {
    return {
      status: 'conflict',
      changed: false,
      contentHash: check.currentHash,
      diagnostics: [check.diagnostic],
    };
  }
  await hooks?.afterPreconditionCheck?.(target.file);
  const edited = await editCanonicalFile({
    file: target.file,
    kind: target.kind,
    root: path.resolve(root),
    expectedHash,
    change: (document) => {
      const before = String(document);
      for (const [field, value] of Object.entries(input.changes)) {
        if (value === null) {
          document.delete(field);
        } else {
          document.set(field, document.createNode(value));
        }
      }
      return String(document) !== before;
    },
    hooks,
  });
  return finishApplyOutcome(root, target.file, edited);
}

export async function applyBodyEdit(
  root: string,
  input: BodyEditInput,
  hooks?: EditApplyHooks,
): Promise<EditApplyOutcome> {
  const resolution = await resolveEditTarget(root, input.path);
  if (!resolution.ok) {
    return {
      status: resolution.status,
      changed: false,
      contentHash: null,
      diagnostics: resolution.diagnostics,
    };
  }
  const target = resolution.target;
  const expectedHash =
    input.expectedHash === null ? undefined : input.expectedHash.toLowerCase();
  const check = await checkExpectedHash(target.file, expectedHash);
  if (check.stale) {
    return {
      status: 'conflict',
      changed: false,
      contentHash: check.currentHash,
      diagnostics: [check.diagnostic],
    };
  }
  await hooks?.afterPreconditionCheck?.(target.file);
  const edited = await editCanonicalFile({
    file: target.file,
    kind: target.kind,
    root: path.resolve(root),
    expectedHash,
    change: () => false,
    body: () => singleTrailingNewline(input.body),
    hooks,
  });
  return finishApplyOutcome(root, target.file, edited);
}

async function resolveEditTarget(
  root: string,
  relativePath: string,
): Promise<EditTargetResolution> {
  const workspaceRoot = path.resolve(root);
  const checked = checkEditPath(workspaceRoot, relativePath);
  if (!checked.ok) {
    return {
      ok: false,
      status: 'outOfScope',
      diagnostics: [checked.diagnostic],
    };
  }
  const discovery = await discoverWorkspaceFiles(workspaceRoot);
  const candidate = discovery.files.find(
    (entry) => path.resolve(entry.file) === checked.file,
  );
  if (candidate === undefined) {
    if (await pathExists(checked.file)) {
      return {
        ok: false,
        status: 'outOfScope',
        diagnostics: [
          diagnostic(
            checked.file,
            'edit.path_out_of_scope',
            'error',
            `This file is not an editable workspace Markdown file: ${canonicalPath(workspaceRoot, checked.file)}`,
            { fieldPath: 'path' },
          ),
        ],
      };
    }
    return {
      ok: false,
      status: 'notFound',
      diagnostics: [
        diagnostic(
          checked.file,
          'edit.file_missing',
          'error',
          `No workspace file exists at this path: ${canonicalPath(workspaceRoot, checked.file)}`,
          { fieldPath: 'path' },
        ),
      ],
    };
  }
  const parsed = await parseWorkspaceFile(
    candidate.file,
    candidate.kind,
    candidate.area,
    workspaceRoot,
  );
  if (
    parsed.kind !== 'chat' &&
    parsed.kind !== 'summary' &&
    parsed.kind !== 'resource' &&
    parsed.kind !== 'task'
  ) {
    return {
      ok: false,
      status: 'outOfScope',
      diagnostics: [
        diagnostic(
          candidate.file,
          'edit.path_out_of_scope',
          'error',
          `Files of kind '${parsed.kind}' are not editable here; only chat, summary, resource, and task Markdown files can be edited.`,
          { fieldPath: 'path' },
        ),
      ],
    };
  }
  const structural = parsed.diagnostics.filter(isStructuralFailure);
  if (structural.length > 0 || parsed.metadata === null) {
    return { ok: false, status: 'invalid', diagnostics: structural };
  }
  return {
    ok: true,
    target: { file: candidate.file, kind: parsed.kind, parsed },
  };
}

async function checkExpectedHash(
  file: string,
  expectedHash: string | undefined,
): Promise<HashCheck> {
  if (expectedHash === undefined) {
    return { stale: false, currentHash: null };
  }
  const currentHash = await currentHashOf(file);
  if (currentHash === null || currentHash === expectedHash) {
    return { stale: false, currentHash };
  }
  return {
    stale: true,
    currentHash,
    diagnostic: diagnostic(
      file,
      'edit.stale_hash',
      'error',
      'The file changed since it was loaded; nothing was written.',
    ),
  };
}

async function finishApplyOutcome(
  root: string,
  file: string,
  edited: CanonicalWriteOutcome,
): Promise<EditApplyOutcome> {
  if (edited.diagnostics.some((entry) => entry.code === 'write.conflict')) {
    return {
      status: 'conflict',
      changed: false,
      contentHash: await currentHashOf(file),
      diagnostics: edited.diagnostics,
    };
  }
  if (edited.diagnostics.some((entry) => entry.severity === 'error')) {
    return {
      status: 'invalid',
      changed: false,
      contentHash: null,
      diagnostics: edited.diagnostics,
    };
  }
  const currentHash = await currentHashOf(file);
  if (!edited.changed) {
    return {
      status: 'ok',
      changed: false,
      contentHash: currentHash,
      diagnostics: edited.diagnostics,
    };
  }
  const refreshed = await refreshDiagnostics(root);
  return {
    status: 'ok',
    changed: true,
    contentHash: currentHash,
    diagnostics: [...edited.diagnostics, ...refreshed],
  };
}

function isStructuralFailure(entry: Diagnostic): boolean {
  return (
    entry.code.startsWith('yaml.') ||
    entry.code === 'frontmatter.missing' ||
    entry.code === 'frontmatter.unclosed' ||
    entry.code === 'metadata.empty' ||
    entry.code === 'schema.mapping' ||
    entry.code === 'file.unreadable'
  );
}

async function currentHashOf(file: string): Promise<string | null> {
  try {
    return hashOf(await readFile(file));
  } catch {
    return null;
  }
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function outsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

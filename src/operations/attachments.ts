import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import {
  attachmentReferenceSchema,
  type AttachmentReference,
  type MessageAttachment,
} from '../domain/transcript.js';
import type { ParsedWorkspaceFile } from '../files/workspace.js';

export const MAX_ATTACHMENTS_PER_MESSAGE = 8;
export const MAX_ATTACHMENT_BYTES = 262144;
export const MAX_TOTAL_ATTACHMENT_BYTES = 1048576;

const attachmentTargetKinds: ReadonlySet<string> = new Set([
  'task',
  'resource',
  'summary',
  'chat',
  'project',
]);

export interface ResolvedAttachment {
  kind: string;
  id?: string;
  path: string;
  title: string;
  label: string;
  mime: string;
  sizeBytes: number;
  content: string;
}

export interface AttachmentResolution {
  resolved: ResolvedAttachment[];
  diagnostics: Diagnostic[];
}

export async function resolveAttachmentReferences(
  root: string,
  files: ParsedWorkspaceFile[],
  refs: readonly AttachmentReference[],
): Promise<AttachmentResolution> {
  const diagnostics: Diagnostic[] = [];
  if (refs.length > MAX_ATTACHMENTS_PER_MESSAGE) {
    return {
      resolved: [],
      diagnostics: [
        diagnostic(
          root,
          'attachment.limit',
          'error',
          `A message accepts at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments.`,
        ),
      ],
    };
  }

  const byId = new Map<string, ParsedWorkspaceFile>();
  const byPath = new Map<string, ParsedWorkspaceFile>();
  for (const file of files) {
    const id = file.metadata?.id;
    if (typeof id === 'string' && !byId.has(id)) byId.set(id, file);
    byPath.set(storedPathOf(root, file.file), file);
  }

  const seenReferences = new Set<string>();
  const seenTargets = new Set<string>();
  const resolved: ResolvedAttachment[] = [];
  let totalBytes = 0;

  for (const ref of refs) {
    const parsedRef = attachmentReferenceSchema.safeParse(ref);
    if (!parsedRef.success) {
      diagnostics.push(
        diagnostic(
          root,
          'attachment.invalid',
          'error',
          `Attachment reference is invalid: ${parsedRef.error.issues.map((issue) => issue.message).join(' ')}`,
        ),
      );
      continue;
    }
    const reference = parsedRef.data;
    const referenceKey =
      reference.id !== undefined
        ? `id:${reference.id}`
        : `path:${reference.path ?? ''}`;
    if (seenReferences.has(referenceKey)) continue;
    seenReferences.add(referenceKey);

    const target =
      reference.id !== undefined
        ? (byId.get(reference.id) ?? null)
        : (byPath.get(reference.path ?? '') ?? null);
    if (target === null) {
      if (reference.id === undefined) {
        diagnostics.push(
          ...(await pathReferenceDiagnostics(root, reference.path ?? '')),
        );
      } else {
        diagnostics.push(
          diagnostic(
            root,
            'attachment.missing',
            'error',
            `Attachment '${reference.id}' could not be resolved.`,
          ),
        );
      }
      continue;
    }
    if (!attachmentTargetKinds.has(target.kind)) {
      diagnostics.push(
        diagnostic(
          root,
          'attachment.missing',
          'error',
          `Attachment '${referenceTarget(reference)}' is a '${target.kind}' and cannot be attached.`,
        ),
      );
      continue;
    }
    if (seenTargets.has(target.file)) continue;
    seenTargets.add(target.file);

    const loaded = await loadAttachment(root, target);
    if (loaded === null) {
      diagnostics.push(
        diagnostic(
          root,
          'attachment.unreadable',
          'error',
          `Attachment '${storedPathOf(root, target.file)}' could not be read.`,
        ),
      );
      continue;
    }
    if (loaded.sizeBytes > MAX_ATTACHMENT_BYTES) {
      diagnostics.push(
        diagnostic(
          root,
          'attachment.too_large',
          'error',
          `Attachment '${loaded.path}' exceeds the ${MAX_ATTACHMENT_BYTES}-byte size limit.`,
        ),
      );
      continue;
    }
    if (totalBytes + loaded.sizeBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      diagnostics.push(
        diagnostic(
          root,
          'attachment.limit',
          'error',
          `Attachment '${loaded.path}' exceeds the ${MAX_TOTAL_ATTACHMENT_BYTES}-byte total attachment limit.`,
        ),
      );
      continue;
    }
    totalBytes += loaded.sizeBytes;
    resolved.push(loaded);
  }

  return { resolved, diagnostics };
}

async function pathReferenceDiagnostics(
  root: string,
  storedPath: string,
): Promise<Diagnostic[]> {
  if (!safeStoredPath(root, storedPath)) {
    return [
      diagnostic(
        root,
        'attachment.missing',
        'error',
        `Attachment '${storedPath}' could not be resolved.`,
      ),
    ];
  }
  const absolute = path.resolve(root, ...storedPath.split('/'));
  if (await exists(absolute)) {
    return [
      diagnostic(
        root,
        'attachment.unsupported',
        'error',
        `Attachment '${storedPath}' is not a canonical workspace file and cannot be attached.`,
      ),
    ];
  }
  return [
    diagnostic(
      root,
      'attachment.missing',
      'error',
      `Attachment '${storedPath}' could not be resolved.`,
    ),
  ];
}

async function loadAttachment(
  root: string,
  target: ParsedWorkspaceFile,
): Promise<ResolvedAttachment | null> {
  const extension = path.extname(target.file);
  let content: string | null = null;
  if (extension === '.md') {
    content = target.body;
  } else {
    try {
      content = await readFile(target.file, 'utf8');
    } catch {
      content = null;
    }
  }
  if (content === null) return null;

  const id =
    typeof target.metadata?.id === 'string' ? target.metadata.id : undefined;
  const frontmatterTitle =
    typeof target.metadata?.title === 'string' &&
    target.metadata.title.length > 0
      ? target.metadata.title
      : null;
  const stem = path.basename(target.file, extension);
  const attachment: ResolvedAttachment = {
    kind: target.kind,
    path: storedPathOf(root, target.file),
    title: frontmatterTitle ?? stem,
    label: frontmatterTitle ?? id ?? stem,
    mime: mimeOf(extension),
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    content,
  };
  if (id !== undefined) attachment.id = id;
  return attachment;
}

export function attachmentsBlock(
  attachments: readonly ResolvedAttachment[],
): string {
  if (attachments.length === 0) return '';
  return attachments
    .map((attachment) => {
      const head = `<attachment kind="${escapeAttribute(attachment.kind)}" title="${escapeAttribute(attachment.title)}">`;
      return `${head}\n${attachment.content.trim()}\n</attachment>`;
    })
    .join('\n\n');
}

export function messageAttachments(
  attachments: readonly ResolvedAttachment[],
): MessageAttachment[] {
  return attachments.map((attachment) => {
    const stored: MessageAttachment = {
      path: attachment.path,
      label: attachment.label,
      mime: attachment.mime,
      kind: attachment.kind,
      title: attachment.title,
      size: attachment.sizeBytes,
    };
    if (attachment.id !== undefined) stored.id = attachment.id;
    return stored;
  });
}

function referenceTarget(reference: AttachmentReference): string {
  return reference.id ?? reference.path ?? '';
}

function storedPathOf(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

function mimeOf(extension: string): string {
  if (extension === '.md') return 'text/markdown';
  if (extension === '.yml' || extension === '.yaml') {
    return 'application/yaml';
  }
  return 'application/octet-stream';
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function safeStoredPath(root: string, value: string): boolean {
  if (value.length === 0 || value.includes('\\') || value.startsWith('~')) {
    return false;
  }
  if (/\$(?:\{[^}]+\}|[A-Za-z_][A-Za-z0-9_]*)|%[^%]+%/.test(value)) {
    return false;
  }
  const resolved = path.resolve(root, ...value.split('/'));
  const relative = path.relative(path.resolve(root), resolved);
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

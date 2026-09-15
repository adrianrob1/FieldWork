import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import writeFileAtomic from 'write-file-atomic';
import { Document, type ParsedNode } from 'yaml';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import { schemas } from '../domain/schemas.js';
import {
  parseMarkdownSource,
  parseYamlSource,
  spliceFrontmatter,
} from '../files/frontmatter.js';
import {
  metadataDeclaredIds,
  metadataReferences,
  parseWorkspace,
  zodDiagnostic,
  type CanonicalFileKind,
} from '../files/workspace.js';

export interface WriteHooks {
  beforeConflictCheck?: ((file: string) => Promise<void>) | undefined;
}

export interface CanonicalEditInput {
  file: string;
  kind: CanonicalFileKind;
  root: string;
  change: (document: Document.Parsed<ParsedNode>) => boolean;
  body?: ((body: string) => string) | undefined;
  expectedHash?: string | undefined;
  hooks?: WriteHooks | undefined;
}

export interface CanonicalCreateInput {
  file: string;
  kind: CanonicalFileKind;
  root: string;
  metadata: Record<string, unknown>;
  body?: string | undefined;
}

export interface CanonicalWriteOutcome {
  changed: boolean;
  diagnostics: Diagnostic[];
}

export async function editCanonicalFile(
  input: CanonicalEditInput,
): Promise<CanonicalWriteOutcome> {
  let initial: Buffer;
  try {
    initial = await readFile(input.file);
  } catch (error) {
    return refuse(unreadableDiagnostic(input.file, error));
  }
  const initialHash = hashOf(initial);
  if (input.expectedHash !== undefined && initialHash !== input.expectedHash) {
    return refuse(
      diagnostic(
        input.file,
        'write.conflict',
        'error',
        'The chat changed during the exchange; nothing was written.',
      ),
    );
  }
  const source = initial.toString('utf8');
  const parsed = input.file.endsWith('.md')
    ? parseMarkdownSource(input.file, source)
    : parseYamlSource(input.file, source);
  if (parsed.document === null || parsed.document.errors.length > 0) {
    return refuse(...parsed.diagnostics);
  }

  const originalBody = parsed.body === null ? '' : parsed.body;
  const proposedBody =
    input.body === undefined ? originalBody : input.body(originalBody);
  const changed =
    input.change(parsed.document) || proposedBody !== originalBody;
  if (!changed) return { changed: false, diagnostics: [] };

  const serialized = singleTrailingNewline(String(parsed.document));
  const proposed = input.file.endsWith('.md')
    ? spliceFrontmatter(
        source,
        serialized,
        input.body === undefined ? undefined : proposedBody,
      )
    : serialized;
  if (proposed === null) {
    return refuse(
      diagnostic(
        input.file,
        'frontmatter.unclosed',
        'error',
        "Markdown frontmatter has no closing '---'.",
        { line: 1, column: 1 },
      ),
    );
  }

  const validation = await validateProposedDocument(input.root, {
    file: input.file,
    kind: input.kind,
    metadata: parsed.document.toJS(),
  });
  if (validation.some((entry) => entry.severity === 'error')) {
    return { changed: false, diagnostics: validation };
  }

  await input.hooks?.beforeConflictCheck?.(input.file);
  let current: Buffer;
  try {
    current = await readFile(input.file);
  } catch (error) {
    return refuse(unreadableDiagnostic(input.file, error));
  }
  if (hashOf(current) !== initialHash) {
    return refuse(
      diagnostic(
        input.file,
        'write.conflict',
        'error',
        'The file changed while the edit was prepared; nothing was written.',
      ),
    );
  }
  return writeProposed(input.file, proposed, validation);
}

export async function createCanonicalFile(
  input: CanonicalCreateInput,
): Promise<CanonicalWriteOutcome> {
  if (await fileExists(input.file)) {
    return refuse(
      diagnostic(
        input.file,
        'operation.target_exists',
        'error',
        'A file already exists at this location; refusing to overwrite it.',
      ),
    );
  }
  const serialized = singleTrailingNewline(
    String(new Document(input.metadata)),
  );
  const source = input.file.endsWith('.md')
    ? markdownWithFrontmatter(serialized, input.body)
    : serialized;
  const validation = await validateProposedDocument(input.root, {
    file: input.file,
    kind: input.kind,
    metadata: input.metadata,
  });
  if (validation.some((entry) => entry.severity === 'error')) {
    return { changed: false, diagnostics: validation };
  }
  return writeProposed(input.file, source, validation);
}

function markdownWithFrontmatter(
  serialized: string,
  body: string | undefined,
): string {
  if (body === undefined || body.trim().length === 0) {
    return `---\n${serialized}---\n`;
  }
  return `---\n${serialized}---\n\n${singleTrailingNewline(body)}`;
}

export interface ProposedDocument {
  file: string;
  kind: CanonicalFileKind;
  metadata: unknown;
}

export async function validateProposedDocument(
  root: string,
  proposed: ProposedDocument,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const metadata = proposed.metadata;
  if (!isRecord(metadata)) {
    diagnostics.push(
      diagnostic(
        proposed.file,
        'schema.mapping',
        'error',
        'Metadata must contain one top-level mapping.',
      ),
    );
    return diagnostics;
  }
  const result = schemas[proposed.kind].safeParse(metadata);
  if (!result.success) {
    diagnostics.push(
      ...result.error.issues.map((issue) =>
        zodDiagnostic(proposed.file, issue),
      ),
    );
  }

  const parsed = await parseWorkspace(root);
  const targetPath = path.resolve(proposed.file);
  const knownIds = new Set<string>();
  for (const file of parsed.files) {
    if (path.resolve(file.file) === targetPath) continue;
    for (const declared of metadataDeclaredIds(file.kind, file.metadata)) {
      knownIds.add(declared.id);
    }
  }

  const ownIds = new Set<string>();
  for (const declared of metadataDeclaredIds(proposed.kind, metadata)) {
    if (ownIds.has(declared.id) || knownIds.has(declared.id)) {
      diagnostics.push(
        diagnostic(
          proposed.file,
          'id.duplicate',
          'error',
          `Stable ID '${declared.id}' is declared more than once.`,
          { fieldPath: declared.fieldPath },
        ),
      );
    }
    ownIds.add(declared.id);
  }
  for (const [fieldPath, target] of metadataReferences(
    proposed.kind,
    metadata,
  )) {
    if (!knownIds.has(target) && !ownIds.has(target)) {
      diagnostics.push(
        diagnostic(
          proposed.file,
          'reference.missing',
          'error',
          `'${fieldPath}' references unknown ID '${target}'.`,
          { fieldPath },
        ),
      );
    }
  }
  return diagnostics;
}

export function hashOf(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function singleTrailingNewline(source: string): string {
  return source.replace(/\n*$/, '\n');
}

async function writeProposed(
  file: string,
  source: string,
  warnings: Diagnostic[],
): Promise<CanonicalWriteOutcome> {
  try {
    await writeFileAtomic(file, source);
  } catch (error) {
    return refuse(
      diagnostic(
        file,
        'write.failed',
        'error',
        `Could not write file: ${errorMessage(error)}`,
      ),
    );
  }
  return { changed: true, diagnostics: warnings };
}

function refuse(...diagnostics: Diagnostic[]): CanonicalWriteOutcome {
  return { changed: false, diagnostics };
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function unreadableDiagnostic(file: string, error: unknown): Diagnostic {
  return diagnostic(
    file,
    'file.unreadable',
    'error',
    `Could not read file: ${errorMessage(error)}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

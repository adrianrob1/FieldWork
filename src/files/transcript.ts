import { LineCounter, parseDocument, stringify } from 'yaml';
import type { ZodIssue } from 'zod';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';
import type { MessageMetadata, MessageRole } from '../domain/transcript.js';
import { messageMetadataSchema } from '../domain/transcript.js';

export interface HeadingLocation {
  line: number;
  column: number;
}

export interface TranscriptMessage {
  role: MessageRole;
  text: string;
  metadata: MessageMetadata | null;
  metadataRaw: unknown;
  headingLocation: HeadingLocation;
}

export interface TranscriptParseResult {
  preamble: string;
  messages: TranscriptMessage[];
  diagnostics: Diagnostic[];
}

export interface TranscriptMessageInput {
  role: MessageRole;
  text: string;
  metadata?: unknown;
  metadataRaw?: unknown;
}

interface SourceLine {
  start: number;
  end: number;
}

const messageHeadingPattern = /^##[ \t]*(user|assistant|system|tool)[ \t]*$/i;
const escapedHeadingPattern =
  /^\\(\\*)##[ \t]*(user|assistant|system|tool)[ \t]*$/i;
const escapeTargetPattern =
  /^(\\*)##[ \t]*(user|assistant|system|tool)[ \t]*$/i;
const fenceOpenPattern = /^`{3}[ \t]*yaml[ \t]*$/;
const fenceClosePattern = /^`{3}[ \t]*$/;
const blankLinePattern = /^[ \t]*$/;

export function parseTranscript(
  source: string,
  file = '',
): TranscriptParseResult {
  const diagnostics: Diagnostic[] = [];
  const lines = scanLines(source);
  const headings: { index: number; role: MessageRole }[] = [];
  for (const [index, line] of lines.entries()) {
    const match = messageHeadingPattern.exec(contentOf(source, line));
    if (match === null) continue;
    const role = match[1];
    if (role === undefined) continue;
    headings.push({ index, role: role.toLowerCase() as MessageRole });
  }
  const firstHeading = headings[0];
  if (firstHeading === undefined) {
    return { preamble: source, messages: [], diagnostics };
  }

  const preamble = source.slice(0, lines[firstHeading.index]?.start ?? 0);
  const messages: TranscriptMessage[] = [];
  for (const [position, heading] of headings.entries()) {
    const nextHeading = headings[position + 1];
    const lastLine =
      nextHeading === undefined ? lines.length : nextHeading.index;
    const segmentLines = lines.slice(heading.index + 1, lastLine);
    messages.push(
      parseMessage(source, heading, segmentLines, file, diagnostics),
    );
  }
  return { preamble, messages, diagnostics };
}

export function serializeTranscript(
  preamble: string,
  messages: readonly TranscriptMessageInput[],
): string {
  return messages.reduce(
    (source, message) => source + serializeChatMessage(message),
    preamble,
  );
}

export const TRANSCRIPT_WINDOW_DEFAULT_LIMIT = 50;
export const TRANSCRIPT_WINDOW_MAX_LIMIT = 200;

export interface TranscriptWindowOptions {
  limit?: number;
  before?: string;
}

export interface TranscriptWindow {
  messages: TranscriptMessage[];
  hasEarlier: boolean;
  earlierCursor?: string;
}

export function windowMessages(
  messages: readonly TranscriptMessage[],
  options: TranscriptWindowOptions = {},
): TranscriptWindow {
  const limit = windowLimit(options.limit);
  const end = windowEnd(options.before, messages.length);
  const start = Math.max(0, end - limit);
  const window = messages.slice(start, end);
  const hasEarlier = start > 0;
  if (!hasEarlier) return { messages: window, hasEarlier: false };
  return { messages: window, hasEarlier: true, earlierCursor: String(start) };
}

function windowLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return TRANSCRIPT_WINDOW_DEFAULT_LIMIT;
  }
  const clamped = Math.floor(limit);
  if (clamped < 1) return 1;
  if (clamped > TRANSCRIPT_WINDOW_MAX_LIMIT) {
    return TRANSCRIPT_WINDOW_MAX_LIMIT;
  }
  return clamped;
}

function windowEnd(before: string | undefined, length: number): number {
  if (before === undefined) return length;
  if (!/^\d+$/.test(before)) return 0;
  return Math.min(Number(before), length);
}

export function serializeChatMessage(message: TranscriptMessageInput): string {
  const heading = `## ${message.role}\n\n`;
  const text = message.text
    .replace(/^(?:\r?\n)+/, '')
    .replace(/(?:\r?\n)+$/, '');
  const lines = text.split('\n');
  const mustEscape = lines.some((line) =>
    messageHeadingPattern.test(withoutCarriageReturn(line)),
  );
  const fenceSource =
    message.metadata === null || message.metadata === undefined
      ? message.metadataRaw
      : message.metadata;
  const fenced = fenceSource !== undefined && fenceSource !== null;
  let fence = '';
  let body = text;
  if (mustEscape) {
    fence = metadataFence(escapedFenceSource(fenceSource));
    body = escapeRoleLines(lines);
  } else if (fenced) {
    fence = metadataFence(fenceSource);
  } else if (
    text.length > 0 &&
    fenceOpenPattern.test(withoutCarriageReturn(lines[0] ?? ''))
  ) {
    fence = metadataFence({});
  }
  if (body.length === 0) return `${heading}${fence}`;
  return `${heading}${fence}${body}\n\n`;
}

function metadataFence(source: unknown): string {
  return '```yaml\n' + stringify(source, { lineWidth: 0 }) + '```\n\n';
}

function escapedFenceSource(fenceSource: unknown): Record<string, unknown> {
  if (isRecord(fenceSource)) {
    return { ...fenceSource, text_escaped: true };
  }
  return { text_escaped: true };
}

function escapeRoleLines(lines: string[]): string {
  return lines
    .map((line) =>
      escapeTargetPattern.test(withoutCarriageReturn(line))
        ? `\\${line}`
        : line,
    )
    .join('\n');
}

function unescapeRoleLines(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      escapedHeadingPattern.test(withoutCarriageReturn(line))
        ? line.slice(1)
        : line,
    )
    .join('\n');
}

function withoutCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function parseMessage(
  source: string,
  heading: { index: number; role: MessageRole },
  segmentLines: SourceLine[],
  file: string,
  diagnostics: Diagnostic[],
): TranscriptMessage {
  const headingLocation = {
    line: heading.index + 1,
    column: 1,
  };
  let metadata: MessageMetadata | null = null;
  let metadataRaw: unknown = null;
  let textStart = firstMeaningfulLine(source, segmentLines, 0);

  const opener = segmentLines[textStart];
  if (
    opener !== undefined &&
    fenceOpenPattern.test(contentOf(source, opener))
  ) {
    const closeOffset = segmentLines.findIndex((line, index) => {
      if (index <= textStart) return false;
      return fenceClosePattern.test(contentOf(source, line));
    });
    if (closeOffset === -1) {
      diagnostics.push(
        diagnostic(
          file,
          'transcript.fence',
          'error',
          'The metadata fence is not closed.',
          { line: heading.index + textStart + 2, column: 1 },
        ),
      );
    } else {
      const closeLine = segmentLines[closeOffset];
      const fence = parseMetadataFence(
        source.slice(opener.end + 1, closeLine?.start ?? opener.end + 1),
        file,
        heading.index + textStart + 2,
        diagnostics,
      );
      metadataRaw = fence.raw;
      metadata = fence.metadata;
      textStart = firstMeaningfulLine(source, segmentLines, closeOffset + 1);
    }
  }

  const lastTextLine = lastMeaningfulLine(source, segmentLines, textStart);
  let text = '';
  const startLine = segmentLines[textStart];
  const endLine = segmentLines[lastTextLine];
  if (startLine !== undefined && endLine !== undefined) {
    let textEnd = endLine.end;
    if (textEnd > startLine.start && source.charCodeAt(textEnd - 1) === 13) {
      textEnd -= 1;
    }
    text = source.slice(startLine.start, textEnd);
  }
  if (metadata?.text_escaped === true) {
    text = unescapeRoleLines(text);
  }

  return {
    role: heading.role,
    text,
    metadata,
    metadataRaw,
    headingLocation,
  };
}

function parseMetadataFence(
  yamlSource: string,
  file: string,
  startLine: number,
  diagnostics: Diagnostic[],
): { raw: unknown; metadata: MessageMetadata | null } {
  const lineCounter = new LineCounter();
  const document = parseDocument(yamlSource, {
    lineCounter,
    prettyErrors: false,
  });
  if (document.errors.length > 0) {
    for (const error of document.errors) {
      const position = lineCounter.linePos(error.pos[0] ?? 0);
      diagnostics.push(
        diagnostic(
          file,
          `yaml.${error.code.toLowerCase()}`,
          'error',
          error.message,
          { line: startLine + position.line - 1, column: position.col },
        ),
      );
    }
    return { raw: null, metadata: null };
  }
  const raw: unknown = document.toJS();
  if (!isRecord(raw)) {
    diagnostics.push(
      diagnostic(
        file,
        'transcript.metadata',
        'error',
        'Message metadata must contain one top-level mapping.',
      ),
    );
    return { raw, metadata: null };
  }
  const result = messageMetadataSchema.safeParse(raw);
  if (result.success) {
    return { raw, metadata: result.data };
  }
  diagnostics.push(invalidMetadataDiagnostic(file, result.error.issues));
  return { raw, metadata: null };
}

export function invalidMetadataDiagnostic(
  file: string,
  issues: ZodIssue[],
): Diagnostic {
  const first = issues[0];
  return diagnostic(
    file,
    'transcript.metadata',
    'error',
    `Message metadata is invalid: ${issues.map((issue) => issue.message).join(' ')}`,
    {
      fieldPath:
        first !== undefined && first.path.length > 0
          ? first.path.map(String).join('.')
          : null,
    },
  );
}

function scanLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let index = 0;
  while (index <= source.length) {
    const newline = source.indexOf('\n', index);
    const end = newline === -1 ? source.length : newline;
    lines.push({ start: index, end });
    if (newline === -1) break;
    index = newline + 1;
  }
  return lines;
}

function contentOf(source: string, line: SourceLine): string {
  const content = source.slice(line.start, line.end);
  return content.endsWith('\r') ? content.slice(0, -1) : content;
}

function firstMeaningfulLine(
  source: string,
  segmentLines: SourceLine[],
  from: number,
): number {
  for (const [index, line] of segmentLines.entries()) {
    if (index < from) continue;
    if (!blankLinePattern.test(contentOf(source, line))) return index;
  }
  return segmentLines.length;
}

function lastMeaningfulLine(
  source: string,
  segmentLines: SourceLine[],
  from: number,
): number {
  for (let index = segmentLines.length - 1; index >= from; index -= 1) {
    const line = segmentLines[index];
    if (line === undefined) continue;
    if (!blankLinePattern.test(contentOf(source, line))) return index;
  }
  return -1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

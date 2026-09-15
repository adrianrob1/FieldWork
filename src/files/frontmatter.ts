import {
  LineCounter,
  parseDocument,
  type Document,
  type ParsedNode,
} from 'yaml';

import { diagnostic, type Diagnostic } from '../domain/diagnostics.js';

export interface ParsedSource {
  document: Document.Parsed<ParsedNode> | null;
  metadata: unknown;
  body: string | null;
  diagnostics: Diagnostic[];
}

export function parseYamlSource(file: string, source: string): ParsedSource {
  const lineCounter = new LineCounter();
  const document = parseDocument(source, {
    keepSourceTokens: true,
    lineCounter,
    prettyErrors: false,
  });
  return {
    document,
    metadata: document.errors.length === 0 ? document.toJS() : null,
    body: null,
    diagnostics: yamlDiagnostics(file, document, lineCounter, 0),
  };
}

export function parseMarkdownSource(
  file: string,
  source: string,
): ParsedSource {
  const boundary = findFrontmatter(source);
  if (boundary === null) {
    return {
      document: null,
      metadata: null,
      body: source,
      diagnostics: [
        diagnostic(
          file,
          'frontmatter.missing',
          'error',
          'Markdown file has no YAML frontmatter.',
          { line: 1, column: 1 },
        ),
      ],
    };
  }
  if (boundary.closeStart === null || boundary.closeEnd === null) {
    return {
      document: null,
      metadata: null,
      body: source,
      diagnostics: [
        diagnostic(
          file,
          'frontmatter.unclosed',
          'error',
          "Markdown frontmatter has no closing '---'.",
          { line: 1, column: 1 },
        ),
      ],
    };
  }

  const yamlSource = source.slice(boundary.openEnd, boundary.closeStart);
  const body = source.slice(boundary.closeEnd);
  const lineCounter = new LineCounter();
  const document = parseDocument(yamlSource, {
    keepSourceTokens: true,
    lineCounter,
    prettyErrors: false,
  });
  return {
    document,
    metadata: document.errors.length === 0 ? document.toJS() : null,
    body,
    diagnostics: yamlDiagnostics(file, document, lineCounter, 1),
  };
}

export function spliceFrontmatter(
  source: string,
  replacement: string,
  body?: string,
): string | null {
  const boundary = findFrontmatter(source);
  if (
    boundary === null ||
    boundary.closeStart === null ||
    boundary.closeEnd === null
  ) {
    return null;
  }
  const head =
    source.slice(0, boundary.openEnd) +
    replacement +
    source.slice(boundary.closeStart, boundary.closeEnd);
  if (body === undefined) {
    return head + source.slice(boundary.closeEnd);
  }
  return head + body;
}

function findFrontmatter(source: string): {
  openEnd: number;
  closeStart: number | null;
  closeEnd: number | null;
} | null {
  const opening = /^(?:\uFEFF)?---[\t ]*(?:\r?\n|$)/.exec(source);
  if (!opening) return null;
  const openEnd = opening[0].length;
  const closing = /^---[\t ]*(?:\r?\n|$)/m.exec(source.slice(openEnd));
  if (!closing || closing.index === undefined) {
    return { openEnd, closeStart: null, closeEnd: null };
  }
  const closeStart = openEnd + closing.index;
  return {
    openEnd,
    closeStart,
    closeEnd: closeStart + closing[0].length,
  };
}

function yamlDiagnostics(
  file: string,
  document: Document.Parsed<ParsedNode>,
  lineCounter: LineCounter,
  lineOffset: number,
): Diagnostic[] {
  return document.errors.map((error) => {
    const position = lineCounter.linePos(error.pos[0]);
    return diagnostic(
      file,
      `yaml.${error.code.toLowerCase()}`,
      'error',
      error.message,
      {
        line: position.line + lineOffset,
        column: position.col,
      },
    );
  });
}

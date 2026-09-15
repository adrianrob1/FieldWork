import { describe, expect, it } from 'vitest';

import { parseMarkdownSource } from '../../src/files/frontmatter.js';

describe('Markdown frontmatter', () => {
  it('preserves the complete body and editable YAML document', () => {
    const source =
      '---\nid: chat_one\nx-note: retained # comment\n---\n\n# Body\n';
    const result = parseMarkdownSource('chat.md', source);

    expect(result.body).toBe('\n# Body\n');
    expect(result.metadata).toEqual({ id: 'chat_one', 'x-note': 'retained' });
    expect(result.document?.toString()).toContain('# comment');
  });

  it('returns the body when frontmatter is unclosed', () => {
    const source = '---\nid: [broken\nTranscript remains readable\n';
    const result = parseMarkdownSource('broken.md', source);

    expect(result.body).toBe(source);
    expect(result.diagnostics[0]?.code).toBe('frontmatter.unclosed');
  });

  it('reports YAML source locations relative to the Markdown file', () => {
    const result = parseMarkdownSource(
      'broken.md',
      '---\nid: [broken\n---\nBody\n',
    );

    expect(result.diagnostics[0]).toMatchObject({ line: 3, column: 1 });
  });
});

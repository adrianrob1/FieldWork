import { describe, expect, it } from 'vitest';

import { renderMarkdown } from '../../web/src/pages/chat/markdown.js';

describe('renderMarkdown', () => {
  it('keeps single newlines as line breaks (chat convention)', () => {
    expect(renderMarkdown('line one\nline two')).toContain('<br');
  });

  it('still renders paragraphs and emphasis', () => {
    const html = renderMarkdown('para one\n\npara **two**');
    expect(html).toContain('<p>');
    expect(html).toContain('<strong>two</strong>');
  });

  it('escapes raw HTML and hardens links', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).not.toContain(
      '<img',
    );
    const linked = renderMarkdown('see https://example.com');
    expect(linked).toContain('target="_blank"');
    expect(linked).toContain('rel="noopener noreferrer"');
  });
});

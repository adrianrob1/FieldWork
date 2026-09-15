import MarkdownIt from 'markdown-it';

const renderer = new MarkdownIt({ html: false, linkify: true });

export function renderMarkdown(source: string): string {
  return renderer.render(source);
}

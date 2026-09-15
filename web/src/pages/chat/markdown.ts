import MarkdownIt from 'markdown-it';

// Client-side transcript rendering. HTML in the source is never interpreted
// (`html: false`), links always open in a new tab with noopener, and the same
// linkify behavior as the server renderer keeps manual URLs clickable. Chat
// convention: single newlines stay line breaks (`breaks: true`) instead of
// collapsing into spaces like prose markdown.
const renderer = new MarkdownIt({ html: false, linkify: true, breaks: true });

const defaultLinkOpen =
  renderer.renderer.rules.link_open ??
  ((tokens, index, options, _env, self) =>
    self.renderToken(tokens, index, options));

renderer.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index];
  if (token !== undefined) {
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
  }
  return defaultLinkOpen(tokens, index, options, env, self);
};

export function renderMarkdown(source: string): string {
  return renderer.render(source);
}

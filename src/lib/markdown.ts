import MarkdownIt from "markdown-it";

const renderer = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true
});

const defaultValidateLink = renderer.validateLink;
renderer.validateLink = (url) => {
  const normalized = url.trim().toLowerCase();
  if (normalized.startsWith("javascript:") || normalized.startsWith("vbscript:") || normalized.startsWith("data:")) {
    return false;
  }

  return defaultValidateLink(url);
};

const defaultLinkOpen =
  renderer.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

renderer.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  token.attrSet("rel", "noopener noreferrer");
  token.attrSet("target", "_blank");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

export function renderMarkdown(source: string): string {
  return renderer.render(source);
}

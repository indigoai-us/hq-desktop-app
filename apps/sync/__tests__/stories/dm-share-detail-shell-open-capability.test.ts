import { describe, expect, it } from 'vitest';

import { renderMessageBodyMarkdown } from '../../src/lib/messageMarkdown';

describe('HQ-DESKTOP-4F: DM markdown links', () => {
  it('renders DM markdown links as target=_blank anchors (what the shell plugin listener intercepts)', () => {
    const link = renderMessageBodyMarkdown('see [docs](https://example.com/x)');
    expect(link).toMatch(/<a\s[^>]*href="https:\/\/example\.com\/x"[^>]*target="_blank"/);

    // CommonMark angle-bracket autolinks — the renderer deliberately does not
    // linkify bare URLs, so these are the other two anchor-emitting branches.
    const autolink = renderMessageBodyMarkdown('<https://example.com/y>');
    expect(autolink).toMatch(/<a\s[^>]*href="https:\/\/example\.com\/y"[^>]*target="_blank"/);

    const mail = renderMessageBodyMarkdown('<someone@example.com>');
    expect(mail).toMatch(/<a\s[^>]*href="mailto:someone@example\.com"[^>]*target="_blank"/);
  });
});

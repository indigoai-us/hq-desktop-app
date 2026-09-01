import { describe, expect, it } from 'vitest';
import {
  applyChatLineBreaks,
  normalizeMessageMarkdown,
  renderMessageBodyMarkdown,
  wrapMessageMentions,
} from './messageMarkdown';

describe('renderMessageBodyMarkdown', () => {
  it('renders complete safe Markdown blocks used in conversations', () => {
    const html = renderMessageBodyMarkdown(`# Release notes

| Surface | Status |
| :--- | ---: |
| Messages | Ready |

- Keeps lists semantic
- Supports **emphasis**

> Neutral, readable, and compact.

\`\`\`ts
const ready = true;
\`\`\`

---

![HQ mark](https://example.com/hq.png)`);

    expect(html).toContain('<h1>Release notes</h1>');
    expect(html).toContain('<div class="markdown-table-scroll" tabindex="0">');
    expect(html).toContain('<table>');
    expect(html).toContain('<th scope="col" class="markdown-align-left">Surface</th>');
    expect(html).toContain('<td class="markdown-align-right">Ready</td>');
    expect(html).toContain('<ul><li>Keeps lists semantic</li>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<pre><code class="language-ts">const ready = true;</code></pre>');
    expect(html).toContain('<hr />');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('https://example.com/hq.png');
    expect(html).toContain('HQ mark');
  });

  it('renders markdown links used in conversation messages', () => {
    const html = renderMessageBodyMarkdown(
      'Changed [dmThread.ts](/home/ec2-user/hq-agent/repos/private/hq-desktop-app/apps/sync/src/lib/dmThread.ts:44).',
    );

    expect(html).toContain(
      '<a href="/home/ec2-user/hq-agent/repos/private/hq-desktop-app/apps/sync/src/lib/dmThread.ts:44"',
    );
    expect(html).toContain('>dmThread.ts</a>');
  });

  it('removes shared transport indentation so rich prose does not become one code block', () => {
    const body = `    ## Smaller open items

    3. Confirm the timeout.
    4. Ship the resize fix.

    Nothing has been implemented yet.

    \`\`\`ts
    const deliberatelyMonospaced = true;
    \`\`\``;

    expect(normalizeMessageMarkdown(body)).toContain('## Smaller open items');
    const html = renderMessageBodyMarkdown(body);
    expect(html).toContain('<h2>Smaller open items</h2>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>Confirm the timeout.</li>');
    expect(html).toContain('<p>Nothing has been implemented yet.</p>');
    expect(html).toContain(
      '<pre><code class="language-ts">const deliberatelyMonospaced = true;</code></pre>',
    );
    expect(html).not.toMatch(/^<pre><code>[\s\S]*Smaller open items/);
  });

  it('preserves a standard four-space indented code-only message', () => {
    const body = `    const answer = 42;
    console.log(answer);`;

    expect(normalizeMessageMarkdown(body)).toBe(body);
    expect(renderMessageBodyMarkdown(body)).toContain(
      '<pre><code>const answer = 42;\nconsole.log(answer);</code></pre>',
    );
  });

  it('suppresses active raw HTML and drops unsafe link schemes', () => {
    const html = renderMessageBodyMarkdown(
      'See <script>alert(1)</script> and [bad](javascript:alert(1)).',
    );

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('&lt;script&gt;');
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a ');
    expect(html).toContain('bad');
  });

  it('does not let a message sender trigger remote image requests', () => {
    const html = renderMessageBodyMarkdown(
      '![tracking pixel](https://attacker.example/open.gif) <img src="http://attacker.example/raw.gif" alt="raw pixel">',
    );

    expect(html).not.toContain('<img');
    expect(html).not.toContain('attacker.example');
    expect(html).toContain('tracking pixel');
    expect(html).toContain('raw pixel');
  });

  it('turns a single newline in plain paragraph text into a <br />', () => {
    expect(applyChatLineBreaks('line one\nline two')).toBe('line one  \nline two');
    expect(renderMessageBodyMarkdown('line one\nline two')).toBe(
      '<p>line one<br />line two</p>',
    );
  });

  it('leaves blank-line paragraphs unchanged', () => {
    const body = 'para one\n\npara two';
    expect(applyChatLineBreaks(body)).toBe(body);
    expect(renderMessageBodyMarkdown(body)).toBe(
      '<p>para one</p>\n<p>para two</p>',
    );
  });

  it('does not alter fenced code block lines', () => {
    const body = '```\nconst a = 1;\nconst b = 2;\n```';
    expect(applyChatLineBreaks(body)).toBe(body);
    const html = renderMessageBodyMarkdown(body);
    expect(html).toContain('<pre><code>const a = 1;\nconst b = 2;</code></pre>');
    expect(html).not.toContain('<br');
  });

  it('does not alter list or table lines', () => {
    const list = '- item one\n- item two';
    expect(applyChatLineBreaks(list)).toBe(list);
    const listHtml = renderMessageBodyMarkdown(list);
    expect(listHtml).toContain('<ul><li>item one</li><li>item two</li></ul>');
    expect(listHtml).not.toContain('<br');

    const table = '| A | B |\n| --- | --- |\n| 1 | 2 |';
    expect(applyChatLineBreaks(table)).toBe(table);
    const tableHtml = renderMessageBodyMarkdown(table);
    expect(tableHtml).toContain('<table>');
    expect(tableHtml).not.toContain('<br');
  });


  it('does not swallow a capitalized sentence after a two-token mention', () => {
    expect(
      renderMessageBodyMarkdown('done.\n@Corey Epstein Building the page now.'),
    ).toContain('<span class="message-mention">@Corey Epstein</span> Building');
  });

  it('wraps @Corey Epstein and @izzy as mention chips', () => {
    expect(renderMessageBodyMarkdown('hey @Corey Epstein')).toContain(
      '<span class="message-mention">@Corey Epstein</span>',
    );
    expect(renderMessageBodyMarkdown('ping @izzy')).toContain(
      '<span class="message-mention">@izzy</span>',
    );
    expect(renderMessageBodyMarkdown('@corey please help')).toContain(
      '<span class="message-mention">@corey</span>',
    );
    expect(renderMessageBodyMarkdown('@corey please help')).not.toContain(
      '@corey please',
    );
  });

  it('does not treat an email address as a mention', () => {
    const html = renderMessageBodyMarkdown('email foo@bar.com please');
    expect(html).not.toContain('message-mention');
    expect(html).toContain('foo@bar.com');
  });

  it('does not wrap mentions inside inline code', () => {
    const html = renderMessageBodyMarkdown('use `@izzy` in code');
    expect(html).toContain('<code>@izzy</code>');
    expect(html).not.toContain('message-mention');
  });

  it('does not wrap mentions inside HTML attributes', () => {
    const html = wrapMessageMentions(
      '<a href="https://example.com/@izzy" title="@izzy">see @izzy</a>',
    );
    expect(html).toBe(
      '<a href="https://example.com/@izzy" title="@izzy">see <span class="message-mention">@izzy</span></a>',
    );
  });

  it('autolinks bare http and https URLs with rel=noopener noreferrer', () => {
    const http = renderMessageBodyMarkdown('see http://example.com/docs');
    expect(http).toContain(
      '<a href="http://example.com/docs" target="_blank" rel="noopener noreferrer">http://example.com/docs</a>',
    );
    const https = renderMessageBodyMarkdown('see https://example.com/docs');
    expect(https).toContain(
      '<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">https://example.com/docs</a>',
    );
  });

  it('does not swallow a trailing period after a bare URL', () => {
    const html = renderMessageBodyMarkdown('See https://example.com.');
    expect(html).toContain(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">https://example.com</a>.',
    );
    expect(html).not.toContain('href="https://example.com."');
  });

  it('still renders markdown [label](https://…) links', () => {
    const html = renderMessageBodyMarkdown('see [docs](https://example.com/x)');
    expect(html).toContain(
      '<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">docs</a>',
    );
  });

  it('never turns javascript:alert(1) into a link as markdown or bare text', () => {
    const markdown = renderMessageBodyMarkdown('[x](javascript:alert(1))');
    expect(markdown).not.toMatch(/<a\b/);
    expect(markdown).not.toContain('javascript:');

    const bare = renderMessageBodyMarkdown('javascript:alert(1)');
    expect(bare).not.toMatch(/<a\b/);
    expect(bare).toContain('javascript:alert(1)');
  });

  it('does not autolink URLs inside fenced or inline code', () => {
    const fenced = renderMessageBodyMarkdown('```\nhttps://example.com\n```');
    expect(fenced).toContain('<pre><code>https://example.com</code></pre>');
    expect(fenced).not.toMatch(/<a\b/);

    const inline = renderMessageBodyMarkdown('use `https://example.com` here');
    expect(inline).toContain('<code>https://example.com</code>');
    expect(inline).not.toMatch(/<a\b/);
  });

  it('does not double-link text inside an existing markdown link', () => {
    const html = renderMessageBodyMarkdown(
      '[https://example.com](https://example.com/page)',
    );
    expect(html.match(/<a\b/g)?.length).toBe(1);
    expect(html).toContain('href="https://example.com/page"');
    expect(html).toContain('>https://example.com</a>');
  });

  it('preserves escaped &amp; in a URL and does not decode it', () => {
    const html = renderMessageBodyMarkdown('https://example.com?a=1&b=2');
    expect(html).toContain(
      '<a href="https://example.com?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">https://example.com?a=1&amp;b=2</a>',
    );
    expect(html).not.toContain('href="https://example.com?a=1&b=2"');
  });
});

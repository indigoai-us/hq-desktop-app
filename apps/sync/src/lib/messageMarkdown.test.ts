import { describe, expect, it } from 'vitest';
import {
  normalizeMessageMarkdown,
  renderMessageBodyMarkdown,
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
});

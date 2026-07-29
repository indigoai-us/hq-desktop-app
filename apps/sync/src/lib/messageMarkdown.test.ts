import { describe, expect, it } from 'vitest';
import { renderMessageBodyMarkdown } from './messageMarkdown';

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
    expect(html).toContain(
      '<img src="https://example.com/hq.png" alt="HQ mark" loading="lazy" decoding="async" />',
    );
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
});

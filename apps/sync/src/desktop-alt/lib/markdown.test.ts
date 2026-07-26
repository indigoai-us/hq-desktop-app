import { describe, expect, it } from 'vitest';
import {
  renderInline,
  renderMarkdown,
  safeHref,
  safeImageSrc,
} from './markdown';

describe('desktop markdown rendering', () => {
  it('renders a GFM table as semantic HTML instead of raw pipe text', () => {
    const html = renderMarkdown(
      [
        '| Community | Direction | Households | Median income |',
        '| :--- | :---: | ---: | --- |',
        '| Lyons | center | 1,930 | **$121K** |',
        '| Eagle Canyon | N | n/a | $875K–$985K |',
      ].join('\n'),
    );

    expect(html).toContain('<div class="markdown-table-scroll" tabindex="0"><table>');
    expect(html).toContain('<thead><tr>');
    expect(html).toContain('<th scope="col" class="markdown-align-left">Community</th>');
    expect(html).toContain('<th scope="col" class="markdown-align-center">Direction</th>');
    expect(html).toContain('<th scope="col" class="markdown-align-right">Households</th>');
    expect(html).toContain('<tbody><tr><td class="markdown-align-left">Lyons</td>');
    expect(html).toContain('<strong>$121K</strong>');
    expect(html).not.toContain('<p>| Community');
  });

  it('keeps escaped and code-span pipes inside table cells', () => {
    const html = renderMarkdown(
      ['Name | Value', '--- | ---', 'literal \\| pipe | `a | b`'].join('\n'),
    );

    expect(html).toContain('<td>literal | pipe</td>');
    expect(html).toContain('<td><code>a | b</code></td>');
  });

  it('degrades malformed table delimiters to escaped paragraph text', () => {
    const html = renderMarkdown(
      ['| Name | Value |', '| --- | :-- |', '| safe | <script> |'].join('\n'),
    );

    expect(html).not.toContain('<table>');
    expect(html).toContain('| Name | Value |');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('renders nested lists and multi-line list items without losing content', () => {
    const html = renderMarkdown(
      [
        '- Parent item',
        '  continues on the next line',
        '  1. Nested first',
        '     with more detail',
        '  2. Nested second',
        '- Next parent',
      ].join('\n'),
    );

    expect(html).toBe(
      '<ul><li>Parent item continues on the next line<ol><li>Nested first with more detail</li><li>Nested second</li></ol></li><li>Next parent</li></ul>',
    );
  });

  it('renders headings, paragraphs, hard breaks, lists, tasks, quotes, rules, and code', () => {
    const html = renderMarkdown(
      [
        'Setext title',
        '============',
        '',
        '## Heading',
        '',
        'first line  ',
        'second line',
        '',
        '- ordinary',
        '- [x] shipped',
        '- [ ] follow up',
        '',
        '1. first',
        '2. second',
        '',
        '> **Quoted** text',
        '> - with a list',
        '',
        '---',
        '',
        '```ts',
        'const safe = "<tag>";',
        '```',
        '',
        '    indented()',
      ].join('\n'),
    );

    expect(html).toContain('<h1>Setext title</h1>');
    expect(html).toContain('<h2>Heading</h2>');
    expect(html).toContain('<p>first line<br />second line</p>');
    expect(html).toContain('<ul class="task-list">');
    expect(html).toContain(
      '<li class="task-list-item"><input type="checkbox" disabled checked /><div class="task-list-content">',
    );
    expect(html).toContain('<ol><li>first</li><li>second</li></ol>');
    expect(html).toContain('<blockquote><p><strong>Quoted</strong> text</p>');
    expect(html).toContain('<ul><li>with a list</li></ul></blockquote>');
    expect(html).toContain('<hr />');
    expect(html).toContain('<pre><code class="language-ts">');
    expect(html).toContain('&lt;tag&gt;');
    expect(html).toContain('<pre><code>indented()</code></pre>');
  });

  it('renders safe links, autolinks, images, emphasis, deletion, and escaped punctuation', () => {
    const html = renderInline(
      String.raw`[HQ](https://example.com) <team@example.com> ![Map](/map.png) **bold** _em_ ~~old~~ \*literal\*`,
    );

    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain('<a href="mailto:team@example.com"');
    expect(html).toContain(
      '<img src="/map.png" alt="Map" loading="lazy" decoding="async" />',
    );
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>em</em>');
    expect(html).toContain('<del>old</del>');
    expect(html).toContain('*literal*');
  });

  it('requires table headers and delimiters to have the same column count', () => {
    const html = renderMarkdown(['A | B', '--- | --- | ---', '1 | 2'].join('\n'));

    expect(html).not.toContain('<table>');
    expect(html).toContain('A | B');
  });

  it('escapes raw HTML and never emits unsafe link or image schemes', () => {
    const html = renderMarkdown(
      '<script>alert(1)</script>\n\n[bad](javascript:alert(1)) ![bad](data:text/html,x)',
    );

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:text/html');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<a ');
    expect(safeHref('//example.com')).toBeNull();
    expect(safeHref('\\\\example.com')).toBeNull();
    expect(safeImageSrc('mailto:team@example.com')).toBeNull();
    expect(safeImageSrc('#local')).toBeNull();
  });
});

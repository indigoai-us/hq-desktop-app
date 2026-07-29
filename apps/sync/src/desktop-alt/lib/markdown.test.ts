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

  it('degrades malformed table delimiters to safe paragraph text', () => {
    const html = renderMarkdown(
      ['| Name | Value |', '| --- | :-- |', '| safe | <script> |'].join('\n'),
    );

    expect(html).not.toContain('<table>');
    expect(html).toContain('| Name | Value |');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('&lt;script&gt;');
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

  it('renders the narrow raw HTML subset commonly used to center README artwork', () => {
    const html = renderMarkdown(
      [
        '<p align="center" class="ignored" onclick="alert(1)">',
        '  <img src="https://example.com/hq.png" alt="HQ" width="180" height="80" style="display:none" onerror="alert(2)">',
        '  <br>',
        '  **The operating system for teams.**',
        '</p>',
      ].join('\n'),
    );

    expect(html).toBe(
      '<p class="markdown-align-center"><img src="https://example.com/hq.png" alt="HQ" loading="lazy" decoding="async" width="180" height="80" /> <br /> <strong>The operating system for teams.</strong></p>',
    );
    expect(html).not.toContain('&lt;p');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('style=');
  });

  it('renders README details and summary blocks while continuing to parse Markdown', () => {
    const html = renderMarkdown(
      [
        '<details open ontoggle="alert(1)">',
        '<summary>Install **HQ**</summary>',
        '',
        'Run `hq setup`.',
        '',
        '- Verify sync',
        '</details>',
      ].join('\n'),
    );

    expect(html).toBe(
      '<details open><summary>Install <strong>HQ</strong></summary><p>Run <code>hq setup</code>.</p>\n<ul><li>Verify sync</li></ul></details>',
    );
    expect(html).not.toContain('&lt;details');
    expect(html).not.toContain('ontoggle');
  });

  it('suppresses unsafe and unsupported raw HTML without exposing executable markup', () => {
    const html = renderMarkdown(
      [
        '<!-- internal README note -->',
        '<p align="center">',
        '<img src="javascript:alert(1)" alt="unsafe" onerror="alert(2)">',
        '<script>alert("script")</script>',
        '<style>body { display: none }</style>',
        '<iframe src="https://example.com">frame fallback</iframe>',
        '<img-widget src="https://example.com/tracker.png"></img-widget>',
        '<a href="javascript:alert(3)">Visible label</a>',
        '</p>',
      ].join('\n'),
    );

    expect(html).toContain('<p class="markdown-align-center">');
    expect(html).toContain('unsafe');
    expect(html).toContain('Visible label');
    expect(html).not.toContain('&lt;');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<img ');
    expect(html).not.toContain('tracker.png');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('script")');
    expect(html).not.toContain('display: none');
    expect(html).not.toContain('frame fallback');
    expect(html).not.toContain('internal README note');
  });

  it('preserves raw HTML examples inside inline and fenced code', () => {
    const html = renderMarkdown(
      [
        'Inline `<script>alert(1)</script>` example.',
        '',
        '```html',
        '<iframe src="https://example.com">fallback</iframe>',
        '```',
        '',
        '    <p align="center">literal paragraph</p>',
        '    <script>alert(2)</script>',
      ].join('\n'),
    );

    expect(html).toContain(
      '<code>&lt;script&gt;alert(1)&lt;/script&gt;</code>',
    );
    expect(html).toContain(
      '<pre><code class="language-html">&lt;iframe src=&quot;https://example.com&quot;&gt;fallback&lt;/iframe&gt;</code></pre>',
    );
    expect(html).toContain(
      '<pre><code>&lt;p align=&quot;center&quot;&gt;literal paragraph&lt;/p&gt;\n&lt;script&gt;alert(2)&lt;/script&gt;</code></pre>',
    );
  });

  it('requires table headers and delimiters to have the same column count', () => {
    const html = renderMarkdown(['A | B', '--- | --- | ---', '1 | 2'].join('\n'));

    expect(html).not.toContain('<table>');
    expect(html).toContain('A | B');
  });

  it('suppresses unsafe raw HTML and never emits unsafe link or image schemes', () => {
    const html = renderMarkdown(
      '<script>alert(1)</script>\n\n[bad](javascript:alert(1)) ![bad](data:text/html,x)',
    );

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('&lt;script&gt;');
    expect(html).not.toContain('alert(1)');
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

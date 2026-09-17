import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

describe('desktop markdown surface contract', () => {
  const surfaces = [
    '../../packages/ui/src/files/FilePreviewPane.svelte',
    '../../packages/ui/src/library/LibraryDetailPanel.svelte',
    '../../packages/ui/src/projects/ProjectDetailView.svelte',
  ];

  it.each(surfaces)('%s styles semantic tables as open neutral content', (path) => {
    const source = readRepoFile(path);

    expect(source).toContain('.markdown-body :global(.markdown-table-scroll)');
    expect(source).toContain('overflow-x: auto');
    expect(source).toContain('.markdown-body :global(table)');
    expect(source).toContain('.markdown-body :global(th)');
    expect(source).toContain('.markdown-body :global(td)');
    expect(source).toContain('border-radius: 0');
    expect(source).toMatch(/border-bottom: 1px solid var\(--v4-hairline/);
    expect(source).toMatch(/border-right: 1px solid var\(--v4-hairline/);

    const markdownStyles = source.slice(source.indexOf('/* ---- markdown typography'));
    expect(markdownStyles).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(markdownStyles).not.toMatch(/var\(--(?:blue|yellow|warning|amber)/i);
  });

  it.each(surfaces)('%s styles the other emitted document constructs', (path) => {
    const source = readRepoFile(path);

    expect(source).toContain('.markdown-body :global(.task-list)');
    expect(source).toContain('.markdown-body :global(.task-list-item input)');
    expect(source).toContain('.markdown-body :global(img)');
    expect(source).toContain('.markdown-body :global(del)');
    expect(source).toContain('.markdown-body :global(blockquote)');
    expect(source).toContain('.markdown-body :global(pre)');
    expect(source).toContain('.markdown-body :global(code)');
  });
});

import { describe, expect, it } from 'vitest';
import { V4_ROW_STACK_GAP_PX, V4_TYPE_SCALE } from '../../src/desktop-alt/v4/model';
import { readRepoFile } from './harness';

/**
 * DESKTOP-008 — Company knowledge workspace.
 *
 * Source contracts for: tenant path guard on companies/{slug}/knowledge,
 * compact search + tree + preview workspace, preserved preview/actions
 * (Reveal, Copy path, Open in Claude Code), markdown/image/PDF/text handling,
 * no global Files redirect, naked hairline split (no rounded outer shell),
 * five type roles + 3px stacks, keyboard tree/search focus, list-detail
 * collapse with primary actions retained, light/dark + reduced motion.
 */

describe('DESKTOP-008: company knowledge workspace', () => {
  const panel = readRepoFile('src/desktop-alt/panels/CompanyKnowledgePanel.svelte');
  const tree = readRepoFile('src/desktop-alt/components/CompanyFileTree.svelte');
  const preview = readRepoFile('src/desktop-alt/components/FilePreviewPane.svelte');
  const companyPage = readRepoFile('src/desktop-alt/pages/CompanyPage.svelte');
  const fileTreeLib = readRepoFile('src/desktop-alt/lib/file-tree.ts');
  const tokens = readRepoFile('src/desktop-alt/v4/tokens.css');
  const desktopCss = readRepoFile('src/desktop-alt/styles/desktop-alt.css');

  it('keeps Company Knowledge strictly scoped by the existing path guard', () => {
    expect(panel).toContain('`companies/${slug}/knowledge`');
    expect(panel).toContain('function inKnowledgeScope(path: string)');
    expect(panel).toContain('path === rootPath || path.startsWith(`${rootPath}/`)');
    expect(panel).toContain('path outside company knowledge scope');
    expect(panel).toContain("invoke<DirEntry[]>('list_hq_dir', { relPath })");
    // Guard is applied before list + select — never weakened/bypassed.
    expect(panel).toContain('if (!inKnowledgeScope(relPath))');
    expect(panel).toContain('if (!inKnowledgeScope(path)) return');
    // No alternate root that could escape the knowledge subtree.
    expect(panel).not.toMatch(/rootPath\s*=\s*\$derived\(`companies\/\$\{slug\}`\)/);
    expect(panel).not.toMatch(/rootPath\s*=\s*['"]['"]/);
  });

  it('shows search, tenant-scoped tree, and selected document preview in one workspace', () => {
    expect(panel).toContain('data-testid="company-knowledge-panel"');
    expect(panel).toContain('data-testid="knowledge-search"');
    expect(panel).toContain('data-testid="knowledge-tree"');
    expect(panel).toContain('data-testid="knowledge-tree-pane"');
    expect(panel).toContain('data-testid="knowledge-preview-pane"');
    expect(panel).toContain('data-testid="company-knowledge-empty"');
    expect(panel).toContain('data-testid="knowledge-scope-meta"');
    expect(panel).toContain('companies/{slug}/knowledge');
    expect(panel).toContain('bind:value={searchQuery}');
    expect(panel).toContain('filterQuery={searchQuery}');
    expect(panel).toContain('<CompanyFileTree');
    expect(panel).toContain('<FilePreviewPane path={selectedPath}');
    expect(panel).toContain('class="list-detail knowledge-workspace');
  });

  it('preserves preview, Reveal in Finder, Copy path, and Open in Claude Code', () => {
    expect(preview).toContain('data-testid="file-preview-pane"');
    expect(preview).toContain('data-testid="reveal-in-finder"');
    expect(preview).toContain('data-testid="copy-path"');
    expect(preview).toContain('Copy path');
    expect(preview).toContain('navigator.clipboard.writeText(copyPathValue)');
    expect(preview).toContain("import OpenFileInClaudeCode from './OpenFileInClaudeCode.svelte'");
    expect(preview).toContain('<OpenFileInClaudeCode');
    expect(preview).toContain('file={path}');
    expect(preview).toContain('folder={hqFolderPath}');
    expect(preview).toContain("invoke('reveal_in_finder', { path })");
    expect(preview).not.toContain("from '@tauri-apps/plugin-shell'");
    // Actions live in the header as primary actions (outside body conditionals).
    expect(preview).toContain('class="preview-actions detail-primary-actions primary-actions"');
    const headerIdx = preview.indexOf('<header class="preview-header">');
    const bodyIdx = preview.indexOf('class="preview-body"');
    const copyIdx = preview.indexOf('data-testid="copy-path"');
    const revealIdx = preview.indexOf('data-testid="reveal-in-finder"');
    expect(headerIdx).toBeGreaterThan(-1);
    expect(bodyIdx).toBeGreaterThan(headerIdx);
    expect(copyIdx).toBeGreaterThan(headerIdx);
    expect(copyIdx).toBeLessThan(bodyIdx);
    expect(revealIdx).toBeGreaterThan(headerIdx);
    expect(revealIdx).toBeLessThan(bodyIdx);
  });

  it('preserves markdown/image/PDF/text handling and unsupported/error states', () => {
    expect(preview).toContain("from '../lib/file-preview-kind'");
    expect(preview).toContain('filePreviewKind');
    expect(preview).toContain('data-testid="file-preview-markdown"');
    expect(preview).toContain('data-testid="file-preview-image"');
    expect(preview).toContain('data-testid="file-preview-pdf"');
    expect(preview).toContain('data-testid="file-preview-monospace"');
    expect(preview).toContain('data-testid="file-preview-unsupported"');
    expect(preview).toContain("invoke<string>('get_company_file_content', { path:");
    expect(preview).toContain('convertFileSrc(abs)');
    expect(preview).toContain('unsupported = true');
    expect(preview).toContain('unsupported || mediaError');
  });

  it('does not route users out to global Files for company knowledge', () => {
    expect(companyPage).toContain('<CompanyKnowledgePanel slug={company.slug} />');
    expect(companyPage).toContain("{:else if tab === 'knowledge'}");
    // Knowledge stays inline — no navigate to files mode from the knowledge panel.
    expect(panel).not.toContain("kind: 'files'");
    expect(panel).not.toContain("navigate({ kind: 'files'");
    expect(panel).not.toContain('exitFilesMode');
    expect(panel).not.toContain('FilesModeSidebar');
    expect(panel).not.toContain("onselectfile");
  });

  it('uses naked hairline tree/preview split with no rounded outer shell', () => {
    expect(panel).toContain('border: 1px solid var(--v4-hairline)');
    expect(panel).toContain('border-radius: 0');
    expect(panel).toContain('background: transparent');
    expect(panel).toContain('border-right: 1px solid var(--v4-hairline)');
    // Rounded only for controls / selection / discrete payload — not the outer workspace.
    expect(panel).not.toContain('border-radius: var(--v4-radius-card');
    expect(panel).toMatch(/\.knowledge-search\s*\{[\s\S]*?border-radius:\s*6px;/);
    expect(tree).toMatch(/\.ft-row\s*\{[\s\S]*?border-radius:\s*6px;/);
    expect(preview).toContain('border-radius: var(--v4-radius-button');
    // No card chrome / shadow on the workspace shell.
    expect(panel).not.toContain('var(--v4-shadow-card)');
    expect(desktopCss).toContain('.list-detail');
    expect(desktopCss).toContain(".list-detail[data-detail-open='true'] > .list-pane");
  });

  it('uses five semantic type roles and 3px title/meta stacks', () => {
    expect(V4_TYPE_SCALE).toEqual({
      metadata: 10,
      secondary: 11,
      body: 12,
      section: 14,
      detail: 18,
    });
    expect(V4_ROW_STACK_GAP_PX).toBe(3);
    expect(tokens).toContain('--v4-row-stack-gap: 3px');
    expect(panel).toContain('--type-body');
    expect(panel).toContain('--type-secondary');
    expect(panel).toContain('--type-metadata');
    expect(panel).toContain('var(--v4-row-stack-gap, 3px)');
    expect(panel).toContain('title-stack');
    expect(tree).toContain('title-stack');
    expect(tree).toContain('--type-body');
    expect(tree).toContain('--type-metadata');
    expect(tree).toContain('var(--v4-row-stack-gap, 3px)');
    expect(preview).toContain('title-stack');
    expect(preview).toContain('--type-section');
    expect(preview).toContain('--type-metadata');
    expect(preview).toContain('var(--v4-row-stack-gap, 3px)');
  });

  it('supports keyboard tree/search focus, visible focus, and list-detail collapse', () => {
    expect(panel).toContain('data-testid="knowledge-search"');
    expect(panel).toContain('handleWorkspaceKeydown');
    expect(panel).toContain("event.key.toLowerCase() === 'f'");
    expect(panel).toContain('focusSearch');
    expect(panel).toContain('data-detail-open={selectedPath != null ? \'true\' : \'false\'}');
    expect(panel).toContain('data-testid="knowledge-detail-back"');
    expect(panel).toContain('@media (max-width: 820px)');
    expect(panel).toContain('.knowledge-search:focus-visible');
    expect(panel).toContain('.knowledge-detail-back:focus-visible');

    expect(tree).toContain('handleTreeKeydown');
    expect(tree).toContain("event.key === 'ArrowDown'");
    expect(tree).toContain("event.key === 'ArrowUp'");
    expect(tree).toContain("event.key === 'Home'");
    expect(tree).toContain("event.key === 'End'");
    expect(tree).toContain("event.key === 'ArrowRight'");
    expect(tree).toContain("event.key === 'ArrowLeft'");
    expect(tree).toContain("event.key === 'Enter'");
    expect(tree).toContain('tabindex={node.path === focusedPath ? 0 : -1}');
    expect(tree).toContain('.ft-row:focus-visible');
    expect(tree).toContain('filterQuery');
    expect(fileTreeLib).toContain('export function filterLazyNodes');

    // Primary preview actions stay mounted and unshrunk under list-detail.
    expect(preview).toContain('detail-primary-actions');
    expect(preview).toContain('primary-actions');
    expect(desktopCss).toMatch(
      /\.list-detail\s+\.detail-primary-actions,[\s\S]*?flex:\s*0\s+0\s+auto/,
    );
  });

  it('honors light/dark and reduced motion/transparency', () => {
    expect(tokens).toContain('--v4-text-1: #0a0c10');
    expect(tokens).toMatch(
      /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{[\s\S]*?--v4-text-1:\s*#f4f6f8/,
    );
    expect(panel).toContain('@media (prefers-reduced-motion: reduce)');
    expect(panel).toContain('@media (prefers-reduced-transparency: reduce)');
    expect(tree).toContain('@media (prefers-reduced-motion: reduce)');
    expect(tree).toContain('@media (prefers-reduced-transparency: reduce)');
    expect(preview).toContain('@media (prefers-reduced-motion: reduce)');
    expect(preview).toContain('@media (prefers-reduced-transparency: reduce)');
    expect(tree).toContain('animation: none');
    expect(preview).toContain('animation: none');
  });

  it('preserves loading/empty/error and existing command/capability contracts', () => {
    expect(tree).toContain('data-testid="file-tree-loading"');
    expect(tree).toContain('data-testid="file-tree-error"');
    expect(tree).toContain('data-testid="file-tree-empty"');
    expect(tree).toContain('Loading…');
    expect(tree).toContain('Files unavailable');
    expect(tree).toContain('selectedPath?');
    expect(tree).toContain('class:selected={node.path === selectedPath}');
    expect(tree).toContain("aria-current={node.path === selectedPath ? 'true' : undefined}");
    expect(panel).toContain("invoke<{ hqFolderPath?: string }>('get_config')");
    expect(panel).toContain('hqFolderPath');
    // Lazy load contract unchanged.
    expect(tree).toContain('loadChildren: (relPath: string) => Promise<DirEntry[]>');
    expect(tree).toContain('function ensureLoaded(');
    expect(tree).toContain('flattenLazy(');
  });
});

import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * US-010 (hq-desktop-v2) — Knowledge and Files V2.
 *
 * Source-contract harness (same style as company-file-explorer.spec.ts /
 * desktop-008-company-knowledge.spec.ts). Locks the V2 contract for the two
 * surfaces the story owns:
 *
 * Knowledge page (per company):
 *   - search input + `companies/{slug}/knowledge` path label
 *   - tenant-scoped tree + selected-document preview
 *   - "Choose a file to preview" empty state (Markdown / images / PDFs / text)
 *   - markdown rendering in the preview
 *
 * Files mode (top-level):
 *   - the primary V2 sidebar SWAPS to the file-browser sidebar
 *     (Back + FILES label, FILTER BY COMPANY rows with connected dots)
 *   - HQ-root tree by default; company filter is a chip (path + ×) that only
 *     narrows the tree root
 *   - preview pane keeps all three actions: Open in Claude Code (sparkle),
 *     Copy path, Reveal in Finder
 *   - Files route persists across desktop window reloads
 *
 * Covers the US-010 e2eTest: "Given a markdown file, when selected in Files,
 * then it renders with all three actions functional."
 */

describe('desktop-v2 US-010 — Knowledge page V2', () => {
  const panel = readRepoFile('src/desktop-alt/panels/CompanyKnowledgePanel.svelte');
  const preview = readRepoFile('src/desktop-alt/components/FilePreviewPane.svelte');
  const model = readRepoFile('src/desktop-alt/v4/model.ts');

  it('renders search, the knowledge path label, and the tenant-scoped tree', () => {
    expect(panel).toContain('data-testid="knowledge-search"');
    expect(panel).toContain('placeholder="Search knowledge…"');
    expect(panel).toContain('bind:value={searchQuery}');
    expect(panel).toContain('filterQuery={searchQuery}');
    // Path label under the search input.
    expect(panel).toContain('data-testid="knowledge-scope-meta"');
    expect(panel).toContain('companies/{slug}/knowledge');
    // Tree stays scoped to the company knowledge subtree (defense-in-depth).
    expect(panel).toContain('`companies/${slug}/knowledge`');
    expect(panel).toContain('if (!inKnowledgeScope(relPath))');
    expect(panel).toContain('<CompanyFileTree');
  });

  it('shows the V2 empty state until a file is chosen, then the preview', () => {
    expect(panel).toContain('data-testid="company-knowledge-empty"');
    expect(panel).toContain('Choose a file to preview');
    expect(panel).toContain(
      'Markdown, images, PDFs, and\n          text open here',
    );
    expect(panel).toContain('<FilePreviewPane path={selectedPath}');
  });

  it('renders markdown documents in the preview pane', () => {
    expect(preview).toContain("import { renderMarkdownDocument } from '../lib/markdown'");
    expect(preview).toContain('data-testid="file-preview-markdown"');
    expect(preview).toContain('{@html markdownHtml}');
  });

  it('Knowledge is a V2 workspace section for the active company', () => {
    expect(model).toContain("{ id: 'knowledge', label: 'Knowledge' }");
  });
});

describe('desktop-v2 US-010 — Files mode V2', () => {
  const sidebar = readRepoFile('src/desktop-alt/v4/FilesModeSidebar.svelte');
  const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
  const preview = readRepoFile('src/desktop-alt/components/FilePreviewPane.svelte');
  const claude = readRepoFile('src/desktop-alt/components/OpenFileInClaudeCode.svelte');
  const model = readRepoFile('src/desktop-alt/v4/model.ts');

  it('the V2 primary sidebar swaps to the file browser in Files mode', () => {
    // Files route → FilesModeSidebar; every other route → V2Sidebar.
    const filesBranch = desktopApp.indexOf("{#if route.kind === 'files'}\n        <FilesModeSidebar");
    expect(filesBranch).toBeGreaterThan(-1);
    expect(desktopApp.slice(filesBranch)).toContain('<V2Sidebar');
    // Files lives in the GENERAL nav group of the V2 sidebar model.
    expect(model).toContain("{ id: 'files', label: 'Files' }");
  });

  it('file-browser header carries the Back exit control and the FILES label', () => {
    expect(sidebar).toContain('class="fs-exit"');
    expect(sidebar).toContain('<span class="fs-exit-label">Back</span>');
    expect(sidebar).toContain('<span class="fs-title">Files</span>');
    // Back leaves Files mode via the shell's exit handler.
    expect(sidebar).toContain('onclick={() => onexit?.()}');
    expect(desktopApp).toContain('onexit={exitFilesMode}');
  });

  it('FILTER BY COMPANY rows show a connected (green) status dot', () => {
    expect(sidebar).toContain('Filter by company');
    expect(sidebar).toContain('class="fs-company-row"');
    // Connected tone maps to the ok token (green dot).
    expect(sidebar).toContain('<span class={`fs-dot ${row.tone}`}');
    expect(sidebar).toContain('.fs-dot.ok {');
    expect(sidebar).toContain('background: var(--v4-ok);');
  });

  it('defaults to the HQ-root tree; the company filter only narrows the root', () => {
    // No filter → empty root path (HQ root: companies/core/personal/repos…).
    expect(sidebar).toContain(
      "activeSlug ? `companies/${activeSlug}` : ''",
    );
    expect(sidebar).toContain('<span class="fs-scope-root">HQ root</span>');
    // Lazy per-directory loads through the guarded native command.
    expect(sidebar).toContain("invoke<DirEntry[]>('list_hq_dir', { relPath })");
    expect(sidebar).toContain('filterFileEntriesForMembership(entries, accessibleCompanies)');
  });

  it('active company filter renders as a path chip with a clear (×) control', () => {
    expect(sidebar).toContain('class="fs-scope-chip"');
    expect(sidebar).toContain('<span class="fs-scope-label">companies/{activeSlug}</span>');
    expect(sidebar).toContain('class="fs-scope-clear"');
    expect(sidebar).toContain('onclick={() => onselectcompany?.(null)}');
    // Toggling the active row also clears back to root.
    expect(sidebar).toContain('row.slug === activeSlug ? null : row.slug');
  });

  it('selected markdown file previews with all three actions (US-010 e2eTest)', () => {
    // Selection flows sidebar → shell route → main-area preview.
    expect(desktopApp).toContain('onselectfile={navigateFilesPath}');
    expect(desktopApp).toContain('<FilePreviewPane path={filesSelectedPath} />');
    // Action 1: ✦ Open in Claude Code — sparkle glyph + authorized native path.
    expect(preview).toContain('<OpenFileInClaudeCode file={path} authorizedFile');
    expect(claude).toContain("label = 'Open in Claude Code'");
    expect(claude).toContain('M8 2.5l1.4 3.6 3.6 1.4-3.6 1.4L8 12.5 6.6 8.9 3 7.5l3.6-1.4L8 2.5z');
    expect(claude).toContain("invoke('open_authorized_file_in_claude', { path: file })");
    // Action 2: Copy path.
    expect(preview).toContain('data-testid="copy-path"');
    // Action 3: Reveal in Finder.
    expect(preview).toContain('data-testid="reveal-in-finder"');
    // Markdown renders (not raw text) for .md selections.
    expect(preview).toContain('data-testid="file-preview-markdown"');
  });

  it('persists the Files route across desktop window reloads', () => {
    expect(desktopApp).toContain('function readStoredFilesRoute()');
    expect(desktopApp).toContain("if (!parsed || parsed.kind !== 'files') return null");
    expect(desktopApp).toContain(
      "JSON.stringify({ kind: 'files', slug: route.slug, path: route.path })",
    );
    // Non-files routes clear the stored entry (no stale strand on reload).
    expect(desktopApp).toContain('window.localStorage.removeItem(ROUTE_CACHE_KEY)');
  });
});

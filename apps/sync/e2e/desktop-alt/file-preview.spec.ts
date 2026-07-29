import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * US-004 — File preview pane + open-in-Claude-Code / reveal-in-Finder
 *
 * Source-contract harness (same style as open-in-claude-code.spec.ts /
 * board-surface.spec.ts). Does NOT mount components — asserts on source text
 * to lock down implementation contracts and prevent regressions.
 *
 * Acceptance criteria covered:
 *   1. Markdown files are detected by extension and rendered as HTML via
 *      renderMarkdown, not shown as raw text.
 *   2. Open-in-Claude-Code reuses OpenFileInClaudeCode.svelte in authorized
 *      mode, so the renderer supplies only the HQ-relative file path.
 *   3. Binary / oversized files drive the unsupported placeholder via .catch();
 *      the open actions render in the header independent of preview success.
 *   4. get_company_file_content is invoked with { path } (binary/oversized
 *      triggers the catch path, which drives the unsupported state).
 *   5. Reveal in Finder uses the same native canonical-path + live-membership
 *      authorization boundary as preview.
 *   6. Files mode wires the tree + preview: FilesModeSidebar owns the tree and
 *      file select, DesktopApp renders FilePreviewPane in the main area driven
 *      by the selected path (US-009 moved this off the per-company panel).
 *   7. CompanyFileTree accepts selectedPath prop and highlights the selected
 *      row with .selected + aria-current="true".
 *   8. No purple and no hardcoded hex in FilePreviewPane's <style> block.
 */

describe('desktop-alt file preview pane + open actions (US-004 file-explorer)', () => {
  const preview = readRepoFile(
    'src/desktop-alt/components/FilePreviewPane.svelte',
  );
  const sidebar = readRepoFile(
    'src/desktop-alt/v4/FilesModeSidebar.svelte',
  );
  const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
  const tree = readRepoFile(
    'src/desktop-alt/components/CompanyFileTree.svelte',
  );
  const openFile = readRepoFile(
    'src/desktop-alt/components/OpenFileInClaudeCode.svelte',
  );
  const rust = readRepoFile('src-tauri/src/commands/desktop_alt.rs');
  const mainRs = readRepoFile('src-tauri/src/main.rs');
  const tauriConfig = readRepoFile('src-tauri/tauri.conf.json');
  const cargoToml = readRepoFile('src-tauri/Cargo.toml');
  const capability = readRepoFile('src-tauri/capabilities/desktop-alt.json');

  // -------------------------------------------------------------------------
  // US-004 e2eTest 1: Markdown detection + renderMarkdown rendering
  // -------------------------------------------------------------------------
  it('detects markdown by extension and renders via renderMarkdown into file-preview-markdown (not raw text)', () => {
    // Imports renderMarkdown from the shared lib (no reimplementation).
    expect(preview).toContain(
      "import { renderMarkdown } from '../lib/markdown'",
    );
    // Classification lives in file-preview-kind (shared Files + Knowledge).
    expect(preview).toContain("from '../lib/file-preview-kind'");
    const kindLib = readRepoFile('src/desktop-alt/lib/file-preview-kind.ts');
    expect(kindLib).toContain('/\\.(md|markdown)$/i');

    // The markdown derived-state drives renderMarkdown when isMarkdown is true.
    expect(preview).toContain('renderMarkdown(content)');

    // Markdown result is rendered into the article via {@html ...} —
    // Svelte auto-escaping is intentionally bypassed for HTML rendering.
    expect(preview).toContain('{@html markdownHtml}');

    // The markdown article carries the correct testid.
    expect(preview).toContain('data-testid="file-preview-markdown"');

    // The article has the markdown-body class (mirrors LibraryDetailPanel).
    expect(preview).toContain('class="markdown-body"');

    // Non-markdown text branch uses the monospace <pre> testid — it is the
    // OTHER branch, confirming the two paths are mutually exclusive.
    expect(preview).toContain('data-testid="file-preview-monospace"');

    // The monospace pre does NOT use {@html ...} (Svelte auto-escapes it).
    expect(preview).not.toMatch(
      /file-preview-monospace[\s\S]{0,80}\{@html/,
    );
  });

  // -------------------------------------------------------------------------
  // US-004 e2eTest 2: Open-in-Claude-Code reuses the shared component
  // -------------------------------------------------------------------------
  it('reuses OpenFileInClaudeCode for open actions — does NOT hand-roll claude:// or route through plugin-shell', () => {
    // Imports the shared component (not a re-implementation).
    expect(preview).toContain(
      "import OpenFileInClaudeCode from './OpenFileInClaudeCode.svelte'",
    );

    // Files/Knowledge mode sends only the selected HQ-relative path.
    expect(preview).toContain('<OpenFileInClaudeCode');
    expect(preview).toContain('file={path}');
    expect(preview).toContain('authorizedFile');
    expect(preview).not.toContain('folder={hqFolderPath}');
    expect(openFile).toContain(
      "invoke('open_authorized_file_in_claude', { path: file })",
    );

    // The open-in-claude-code testid originates from the reused component.
    // FilePreviewPane does NOT independently produce this testid — it comes
    // from the imported component.  The panel source does NOT contain a
    // hand-rolled data-testid="open-in-claude-code" string:
    const previewWithoutImportLine = preview
      .split('\n')
      .filter((l) => !l.includes('OpenFileInClaudeCode'))
      .join('\n');
    expect(previewWithoutImportLine).not.toContain(
      'data-testid="open-in-claude-code"',
    );

    // No hand-rolled claude:// query string in FilePreviewPane source.
    expect(preview).not.toMatch(/claude:\/\/[\w/]*\?/);

    // Neither action exposes a local filesystem path to plugin-shell.
    expect(preview).not.toContain("@tauri-apps/plugin-shell");
    expect(preview).toContain('async function revealInFinder');
    expect(preview).toContain('const actedPath = path');
    expect(preview).toContain(
      "await invoke('reveal_authorized_file', { path: actedPath })",
    );
    expect(preview).toContain('generation === revealGeneration');
  });

  // -------------------------------------------------------------------------
  // US-004 e2eTest 3: Binary / oversized drives unsupported placeholder;
  //                   open actions render in header regardless of state
  // -------------------------------------------------------------------------
  it('previews images and PDFs via an authorized, size-capped native byte command', () => {
    expect(preview).toContain("import { invoke } from '@tauri-apps/api/core'");
    expect(preview).toContain("from '../lib/file-preview-kind'");
    expect(preview).toContain('filePreviewKind');
    expect(preview).toContain(
      "invoke<AuthorizedFilePreview>('get_authorized_file_preview'",
    );
    expect(preview).toContain(
      'mediaUrl = `data:${mimeType};base64,${dataBase64}`',
    );
    expect(preview).not.toContain('convertFileSrc');
    expect(preview).not.toContain('absolutePath');
    expect(preview).toContain('data-testid="file-preview-image"');
    expect(preview).toContain('data-testid="file-preview-pdf"');
    // Knowledge panel reuses the same pane.
    const knowledge = readRepoFile('src/desktop-alt/panels/CompanyKnowledgePanel.svelte');
    expect(knowledge).toContain('FilePreviewPane');
  });

  it('drives file-preview-unsupported for failed text/media loads and keeps open actions in the header', () => {
    // Text path still uses .catch() on get_company_file_content.
    expect(preview).toContain('.catch(');
    expect(preview).toContain('unsupported = true');

    // The unsupported placeholder is guarded by the unsupported state.
    expect(preview).toContain('data-testid="file-preview-unsupported"');
    expect(preview).toContain('unsupported || mediaError');

    // The preview-actions div (containing open buttons) is inside the header,
    // OUTSIDE the preview-body conditional block — it renders regardless.
    // DESKTOP-008: also tagged detail-primary-actions for list-detail collapse.
    expect(preview).toContain('class="preview-actions detail-primary-actions primary-actions"');
    expect(preview).toContain('<header class="preview-header">');

    // Verify structural order: header (with actions) comes BEFORE preview-body.
    const headerIdx = preview.indexOf('<header class="preview-header">');
    const bodyIdx = preview.indexOf('class="preview-body"');
    expect(headerIdx).toBeGreaterThan(-1);
    expect(bodyIdx).toBeGreaterThan(-1);
    expect(headerIdx).toBeLessThan(bodyIdx);

    // preview-actions is inside the header, before preview-body.
    const actionsIdx = preview.indexOf('class="preview-actions detail-primary-actions primary-actions"');
    expect(actionsIdx).toBeGreaterThan(headerIdx);
    expect(actionsIdx).toBeLessThan(bodyIdx);

    // Reveal in Finder button is also inside the header section
    // (testid is before the preview-body div).
    const revealIdx = preview.indexOf('data-testid="reveal-in-finder"');
    expect(revealIdx).toBeGreaterThan(headerIdx);
    expect(revealIdx).toBeLessThan(bodyIdx);
  });

  // -------------------------------------------------------------------------
  // Additional acceptance criteria: get_company_file_content invocation
  // -------------------------------------------------------------------------
  it('invokes get_company_file_content with { path } and handles rejection as unsupported state', () => {
    // Correct invoke signature: { path } (the path variable, not a literal).
    expect(preview).toContain(
      "invoke<string>('get_company_file_content', { path:",
    );

    // On success, content is set; unsupported = false.
    expect(preview).toContain('content = text');
    expect(preview).toContain('unsupported = false');

    // On rejection, content = null; unsupported = true (binary/oversized path).
    expect(preview).toContain('content = null');
    expect(preview).toContain('unsupported = true');

    // A cancel flag guards against out-of-order completions.
    expect(preview).toContain('let cancelled = false');
    expect(preview).toContain('cancelled = true');
  });

  // -------------------------------------------------------------------------
  // Additional acceptance criteria: reveal stays inside native authorization.
  // -------------------------------------------------------------------------
  it('uses HQ-relative native authorization for Reveal in Finder', () => {
    // Reveal button carries the correct testid.
    expect(preview).toContain('data-testid="reveal-in-finder"');

    expect(preview).toContain('const actedPath = path');
    expect(preview).toContain(
      "await invoke('reveal_authorized_file', { path: actedPath })",
    );
    expect(preview).toContain('generation === revealGeneration');
    expect(preview).not.toContain("@tauri-apps/plugin-shell");
    expect(preview).not.toContain('absolutePath');
  });

  it('registers native file actions and removes wildcard/ambient renderer file access', () => {
    expect(rust).toContain('pub async fn get_authorized_file_preview(');
    expect(rust).toContain('pub async fn reveal_authorized_file(');
    expect(rust).toContain('pub async fn open_authorized_file_in_claude(');
    expect(rust).toContain('resolve_authorized_file_target(&path).await?');
    expect(rust).toContain('revalidate_authorized_file_target(&target).await?');
    expect(rust).toContain('MAX_MEDIA_PREVIEW_BYTES');
    expect(rust).not.toContain('"svg" => Some("image/svg+xml")');
    expect(mainRs).toContain('commands::desktop_alt::get_authorized_file_preview');
    expect(mainRs).toContain('commands::desktop_alt::reveal_authorized_file');
    expect(mainRs).toContain('commands::desktop_alt::open_authorized_file_in_claude');
    expect(mainRs).not.toContain('commands::process::spawn_process');
    expect(mainRs).not.toContain('commands::process::cancel_process');
    expect(tauriConfig).not.toContain('"assetProtocol"');
    expect(tauriConfig).not.toContain('"**"');
    expect(cargoToml).not.toContain('"protocol-asset"');
    expect(capability).toContain('"core:image:deny-from-path"');
  });

  // -------------------------------------------------------------------------
  // Additional acceptance criteria (US-009): Files mode wires tree → preview
  // The tree lives in the explorer sidebar; the preview fills the MAIN area.
  // -------------------------------------------------------------------------
  it('Files mode wires the tree (sidebar) and FilePreviewPane (main area) via the selected path', () => {
    // The explorer sidebar owns the tree + file select.
    expect(sidebar).toContain(
      "import CompanyFileTree from '../components/CompanyFileTree.svelte'",
    );
    expect(sidebar).toContain('<CompanyFileTree');
    expect(sidebar).toContain('onselectfile?: (path: string) => void');

    // The shell renders FilePreviewPane in the main content area, driven by the
    // route-carried selected path only.
    expect(desktopApp).toContain(
      "import FilePreviewPane from './components/FilePreviewPane.svelte'",
    );
    expect(desktopApp).toContain('<FilePreviewPane path={filesSelectedPath}');
    expect(desktopApp).not.toContain(
      '<FilePreviewPane path={filesSelectedPath} hqFolderPath=',
    );

    // A file select flows through the membership-guarded route helper before
    // the selected path can mount the raw file preview.
    expect(desktopApp).toContain('onselectfile={navigateFilesPath}');
    expect(desktopApp).toContain('function navigateFilesPath(path: string)');
    expect(desktopApp).toContain('isFilesRouteAllowed(');
    expect(desktopApp).toContain(
      "navigate({ kind: 'files', slug: filesActiveSlug ?? undefined, path })",
    );
  });

  // -------------------------------------------------------------------------
  // Additional acceptance criteria: CompanyFileTree selectedPath prop
  // -------------------------------------------------------------------------
  it('CompanyFileTree accepts selectedPath prop, marks selected row with .selected and aria-current', () => {
    // Optional selectedPath prop accepted.
    expect(tree).toContain('selectedPath?');

    // Highlights the row with .selected class.
    expect(tree).toContain('class:selected={node.path === selectedPath}');

    // aria-current="true" on the selected file row.
    expect(tree).toContain("aria-current={node.path === selectedPath ? 'true' : undefined}");
  });

  // -------------------------------------------------------------------------
  // Additional acceptance criteria: no purple, no hardcoded hex in style block
  // (mirrors open-in-claude-code.spec.ts "token-driven" test)
  // -------------------------------------------------------------------------
  it('FilePreviewPane style block is token-driven — no hardcoded hex colors', () => {
    const styleBlock = preview.split('<style>')[1] ?? '';

    // No hardcoded hex color literals (3, 4, 6, or 8 hex digits).
    expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);

    // No purple keyword in any form (hard Indigo policy).
    expect(styleBlock.toLowerCase()).not.toContain('purple');
  });

  it('FilesModeSidebar style block is token-driven — no hardcoded hex colors (except the mask sentinel)', () => {
    const styleBlock = sidebar.split('<style>')[1] ?? '';

    // No purple anywhere (hard Indigo policy).
    expect(styleBlock.toLowerCase()).not.toContain('purple');

    // The only #hex allowed is the opaque mask sentinel (#000) used by the
    // name fade-out mask — same pattern as V4Sidebar. No other hex literals.
    const hexMatches = styleBlock.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hexMatches.every((hex) => hex === '#000')).toBe(true);
  });
});

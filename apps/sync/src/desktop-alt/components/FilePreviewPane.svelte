<script lang="ts">
  /**
   * FilePreviewPane — preview the selected company file beside the file tree
   * (Files mode + Knowledge tab).
   *
   * Self-fetching + presentational. On every `path` change it classifies the
   * file and loads a preview:
   *   * images (png/jpg/…) → size-capped bytes from an authorized native command
   *   * pdf → the same authorized native preview path
   *   * .md / .markdown → UTF-8 text via get_company_file_content + markdown
   *   * other text → monospaced pre
   *   * binary/oversized/unknown failure → friendly placeholder
   *
   * Preview, Claude Code, and Finder actions all accept only the selected
   * HQ-relative path. The native layer canonicalizes it and rechecks live
   * company membership before reading or dispatching anything.
   */
  import { invoke } from '@tauri-apps/api/core';
  import { renderMarkdownDocument } from '../lib/markdown';
  import { filePreviewKind } from '../lib/file-preview-kind';
  import OpenFileInClaudeCode from './OpenFileInClaudeCode.svelte';
  import '../v4/tokens.css';

  interface Props {
    /** HQ-folder-relative, forward-slash path of the selected file. */
    path: string;
  }

  interface AuthorizedFilePreview {
    mimeType: string;
    dataBase64: string;
  }

  let { path }: Props = $props();

  let content = $state<string | null>(null);
  let mediaUrl = $state<string | null>(null);
  let loading = $state(false);
  let unsupported = $state(false);
  let mediaError = $state(false);
  let revealError = $state<string | null>(null);
  let revealing = $state(false);
  let pathCopied = $state(false);
  let copyingPath = $state(false);
  let copyError = $state<string | null>(null);
  // Non-reactive operation identities prevent an async completion for a
  // previously selected file from mutating the newly selected file's pane.
  let revealGeneration = 0;
  let copyGeneration = 0;

  const fileName = $derived(path.split('/').pop() ?? path);
  const kind = $derived(filePreviewKind(path));
  const isMarkdown = $derived(kind === 'markdown');
  const isImage = $derived(kind === 'image');
  const isPdf = $derived(kind === 'pdf');
  const kindLabel = $derived(
    isMarkdown ? 'Markdown' : isImage ? 'Image' : isPdf ? 'PDF' : kind === 'text' ? 'Text' : 'File',
  );

  // Do not construct absolute filesystem targets in the renderer. Native file
  // commands accept and authorize only this HQ-relative value.
  const copyPathValue = $derived(path);

  const markdownHtml = $derived(
    isMarkdown && content !== null ? renderMarkdownDocument(content) : '',
  );

  // Fetch / resolve preview on every selected path change.
  $effect(() => {
    const current = path;
    const previewKind = filePreviewKind(current);
    content = null;
    mediaUrl = null;
    unsupported = false;
    mediaError = false;
    revealError = null;
    revealing = false;
    pathCopied = false;
    copyingPath = false;
    copyError = null;
    revealGeneration += 1;
    copyGeneration += 1;

    if (!current) {
      loading = false;
      return;
    }

    loading = true;
    let cancelled = false;

    if (previewKind === 'unknown') {
      unsupported = true;
      loading = false;
      return;
    }

    // Images + PDFs: native layer canonicalizes, authorizes, caps, and returns
    // bytes. SVG is intentionally unsupported rather than injecting active XML
    // into the webview.
    if (previewKind === 'image' || previewKind === 'pdf') {
      void invoke<AuthorizedFilePreview>('get_authorized_file_preview', {
        path: current,
      })
        .then(({ mimeType, dataBase64 }) => {
          if (!cancelled) {
            mediaUrl = `data:${mimeType};base64,${dataBase64}`;
            unsupported = false;
          }
        })
        .catch((err) => {
          console.error('get_authorized_file_preview failed:', err);
          if (!cancelled) {
            mediaUrl = null;
            unsupported = true;
          }
        })
        .finally(() => {
          if (!cancelled) loading = false;
        });
      return () => {
        cancelled = true;
      };
    }

    // Text / markdown: existing UTF-8 command (rejects binary + oversized).
    void invoke<string>('get_company_file_content', { path: current })
      .then((text) => {
        if (!cancelled) {
          content = text;
          unsupported = false;
        }
      })
      .catch((err) => {
        console.error('get_company_file_content failed:', err);
        if (!cancelled) {
          content = null;
          unsupported = true;
        }
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });

    return () => {
      cancelled = true;
    };
  });

  async function revealInFinder(): Promise<void> {
    if (!path || revealing) return;
    const actedPath = path;
    const generation = ++revealGeneration;
    revealing = true;
    revealError = null;
    try {
      await invoke('reveal_authorized_file', { path: actedPath });
    } catch (err) {
      console.error('Reveal in Finder failed:', err);
      if (generation === revealGeneration && path === actedPath) {
        revealError = 'Could not reveal file';
        setTimeout(() => {
          if (generation === revealGeneration) revealError = null;
        }, 4000);
      }
    } finally {
      if (generation === revealGeneration) revealing = false;
    }
  }

  async function copyPath(): Promise<void> {
    if (copyingPath) return;
    const actedPath = copyPathValue;
    const generation = ++copyGeneration;
    copyingPath = true;
    copyError = null;
    try {
      await navigator.clipboard.writeText(actedPath);
      if (generation === copyGeneration && copyPathValue === actedPath) {
        pathCopied = true;
        setTimeout(() => {
          if (generation === copyGeneration) pathCopied = false;
        }, 1800);
      }
    } catch (err) {
      console.error('Copy path failed:', err);
      if (generation === copyGeneration && copyPathValue === actedPath) {
        copyError = 'Could not copy path';
        setTimeout(() => {
          if (generation === copyGeneration) copyError = null;
        }, 4000);
      }
    } finally {
      if (generation === copyGeneration) copyingPath = false;
    }
  }

  function onMediaError(): void {
    mediaError = true;
    unsupported = true;
  }
</script>

<section
  class="preview-pane"
  data-testid="file-preview-pane"
  aria-label={`Preview of ${fileName}`}
>
  <header class="preview-header">
    <div class="preview-heading title-stack">
      <h3 class="preview-name" title={path}>{fileName}</h3>
      <span class="preview-meta" data-testid="file-preview-meta" title={path}>
        {kindLabel} · {path}
      </span>
    </div>
    <div class="preview-actions detail-primary-actions primary-actions">
      <OpenFileInClaudeCode file={path} authorizedFile variant="inline" />
      <button
        type="button"
        class="reveal-btn"
        class:error={!!copyError}
        class:copied={pathCopied}
        data-testid="copy-path"
        onclick={copyPath}
        disabled={copyingPath}
        aria-busy={copyingPath}
        title={copyError ?? (pathCopied ? 'Path copied' : `Copy path: ${copyPathValue}`)}
        aria-label={`Copy path: ${copyPathValue}`}
      >
        {#if copyingPath}
          <span class="action-spinner" aria-hidden="true"></span>
        {:else}<svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <rect x="5.5" y="5.5" width="7" height="8" rx="1" stroke="currentColor" stroke-width="1.2" />
          <path
            d="M3.5 10.5V3.5a1 1 0 0 1 1-1h6"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linecap="round"
          />
        </svg>{/if}
        <span class="reveal-label">
          {copyingPath ? 'Copying…' : copyError ? 'Failed' : pathCopied ? 'Copied' : 'Copy path'}
        </span>
      </button>
      <button
        type="button"
        class="reveal-btn"
        class:error={!!revealError}
        data-testid="reveal-in-finder"
        onclick={revealInFinder}
        disabled={revealing}
        aria-busy={revealing}
        title={revealError ?? `Reveal ${fileName} in Finder`}
        aria-label={`Reveal ${fileName} in Finder`}
      >
        {#if revealing}
          <span class="action-spinner" aria-hidden="true"></span>
        {:else}<svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path
            d="M2 4.5a1 1 0 0 1 1-1h3l1.2 1.4H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5z"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linejoin="round"
          />
        </svg>{/if}
        <span class="reveal-label">
          {revealing ? 'Opening…' : revealError ? 'Failed' : 'Reveal in Finder'}
        </span>
      </button>
    </div>
  </header>

  <div class="preview-body" class:media-body={isImage || isPdf}>
    {#if loading}
      <div class="preview-skeleton" aria-label="Loading preview">
        {#each Array(6) as _, index (index)}
          <span style={`width: ${92 - index * 9}%`}></span>
        {/each}
      </div>
    {:else if unsupported || mediaError}
      <div class="preview-unsupported" data-testid="file-preview-unsupported">
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path
            d="M6 3h8l4 4v14a0 0 0 0 1 0 0H6a0 0 0 0 1 0 0V3z"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linejoin="round"
          />
          <path
            d="M14 3v4h4"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linejoin="round"
          />
        </svg>
        <strong>Can&rsquo;t preview this file</strong>
        <span
          >It&rsquo;s unsupported or too large to show here. Use the actions above to open
          it.</span
        >
      </div>
    {:else if isImage && mediaUrl}
      <div class="image-frame" data-testid="file-preview-image">
        <img src={mediaUrl} alt={fileName} onerror={onMediaError} />
      </div>
    {:else if isPdf && mediaUrl}
      <object
        class="pdf-frame"
        data={mediaUrl}
        type="application/pdf"
        title={fileName}
        data-testid="file-preview-pdf"
      >
        <div class="preview-unsupported">
          <strong>PDF preview unavailable</strong>
          <span>Use Reveal in Finder or Open in Claude Code to open this file.</span>
        </div>
      </object>
    {:else if content !== null && isMarkdown}
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      <article class="markdown-body" data-testid="file-preview-markdown">{@html markdownHtml}</article>
    {:else if content !== null}
      <pre class="mono" data-testid="file-preview-monospace">{content}</pre>
    {/if}
  </div>
</section>

<style>
  .preview-pane {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
    background: transparent;
  }

  .preview-header {
    display: flex;
    flex: 0 0 auto;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3, 10px);
    min-width: 0;
    padding: 11px 13px;
    border-bottom: 1px solid var(--v4-hairline, var(--border));
    background: transparent;
  }

  .preview-heading {
    min-width: 0;
    flex: 1 1 auto;
  }

  .title-stack {
    display: grid;
    gap: var(--v4-row-stack-gap, 3px);
    min-width: 0;
  }

  .preview-name {
    min-width: 0;
    margin: 0;
    overflow: hidden;
    color: var(--v4-text-1, var(--fg));
    font-size: var(--type-section, var(--text-section, var(--text-base)));
    font-weight: 600;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .preview-meta {
    min-width: 0;
    overflow: hidden;
    color: var(--v4-text-3, var(--muted));
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 400;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .preview-actions {
    display: flex;
    flex: 0 0 auto;
    flex-shrink: 0;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .preview-actions > * {
    flex: 0 0 auto;
  }

  .reveal-btn {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: var(--space-1, 4px);
    padding: 2px 8px;
    border: 1px solid var(--v4-control-border, var(--border));
    border-radius: var(--v4-radius-button, var(--radius-sm, 6px));
    background: var(--v4-control-faint, var(--row-active));
    color: var(--v4-text-2, var(--muted-2));
    font: inherit;
    font-size: var(--type-secondary, var(--text-sm, var(--text-base)));
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
    transition:
      background 140ms ease,
      color 140ms ease,
      border-color 140ms ease;
  }

  .reveal-btn:hover:not(:disabled) {
    border-color: var(--v4-control-border, var(--border-strong));
    background: var(--v4-active-row, var(--row-hover));
    color: var(--v4-text-1, var(--fg));
  }

  .reveal-btn:focus-visible {
    outline: 2px solid var(--v4-control-border, var(--border-strong));
    outline-offset: 2px;
  }

  .reveal-btn.error {
    color: var(--v4-error, var(--red));
    opacity: 0.9;
  }

  .reveal-btn.copied {
    color: var(--v4-text-1, var(--fg));
    border-color: var(--v4-control-border, var(--border-strong));
  }

  .reveal-btn:disabled {
    opacity: 0.58;
    cursor: wait;
  }

  .action-spinner {
    width: 11px;
    height: 11px;
    border: 1.5px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: preview-action-spin 700ms linear infinite;
  }

  .reveal-label {
    line-height: 1;
  }

  .preview-body {
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    padding: 14px 13px;
    overflow: auto;
    background: transparent;
  }

  .preview-body.media-body {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }

  .image-frame {
    display: flex;
    align-items: center;
    justify-content: center;
    max-width: 100%;
    max-height: 100%;
  }

  .image-frame img {
    max-width: 100%;
    max-height: min(70vh, 100%);
    width: auto;
    height: auto;
    object-fit: contain;
    border-radius: var(--v4-radius-structure);
    border: 1px solid var(--v4-hairline, var(--border));
    background: var(--v4-inset, var(--bg-subtle, transparent));
  }

  .pdf-frame {
    width: 100%;
    height: 100%;
    min-height: 420px;
    border: 1px solid var(--v4-hairline, var(--border));
    border-radius: var(--v4-radius-structure);
    background: var(--v4-inset, var(--bg-subtle, transparent));
  }

  .preview-skeleton {
    display: grid;
    gap: 10px;
    width: 100%;
  }

  .preview-skeleton span {
    height: 16px;
    border-radius: 5px;
    background: linear-gradient(
      90deg,
      var(--v4-control-faint),
      var(--v4-hairline),
      var(--v4-control-faint)
    );
    background-size: 200% 100%;
    animation: preview-skeleton 1.2s ease-in-out infinite;
  }

  .preview-unsupported {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2, 6px);
    padding: 36px 16px;
    text-align: center;
    color: var(--v4-text-2, var(--muted));
  }

  .preview-unsupported svg {
    color: var(--v4-text-3, var(--muted-3));
  }

  .preview-unsupported strong {
    color: var(--v4-text-1, var(--fg));
    font-size: var(--type-body, var(--text-base));
    font-weight: 600;
  }

  .preview-unsupported span {
    max-width: 320px;
    color: var(--v4-text-2, var(--muted));
    font-size: var(--type-secondary, var(--text-sm, var(--text-base)));
    line-height: 1.35;
  }

  .mono {
    margin: 0;
    color: var(--v4-text-2, var(--muted));
    font-family: var(--font-mono);
    font-size: var(--type-body, var(--text-base));
    line-height: 1.55;
    white-space: pre;
    overflow-wrap: normal;
  }

  /* ---- markdown typography (mirrors LibraryDetailPanel .markdown-body) ----- */
  .markdown-body {
    color: var(--v4-text-1, var(--fg));
    font-size: var(--type-body, var(--text-base));
    line-height: 1.6;
  }

  .markdown-body :global(h1),
  .markdown-body :global(h2),
  .markdown-body :global(h3),
  .markdown-body :global(h4),
  .markdown-body :global(h5),
  .markdown-body :global(h6) {
    margin: var(--space-5, 16px) 0 var(--space-2, 6px);
    color: var(--v4-text-1, var(--fg));
    font-weight: 600;
    line-height: 1.3;
  }

  .markdown-body :global(h1) {
    font-size: var(--type-detail, var(--text-lg));
  }
  .markdown-body :global(h2) {
    padding-bottom: var(--space-1, 4px);
    border-bottom: 1px solid var(--v4-hairline, var(--border));
    font-size: var(--type-section, var(--text-section));
  }
  .markdown-body :global(h3) {
    font-size: var(--type-body, var(--text-base));
  }

  .markdown-body :global(p) {
    margin: var(--space-2, 6px) 0;
    color: var(--v4-text-2, var(--muted));
  }

  .markdown-body :global(ul),
  .markdown-body :global(ol) {
    margin: var(--space-2, 6px) 0;
    padding-left: var(--space-5, 16px);
    color: var(--v4-text-2, var(--muted));
  }

  .markdown-body :global(li) {
    margin: var(--space-1, 4px) 0;
  }

  .markdown-body :global(.task-list) {
    padding-left: 0;
    list-style: none;
  }

  .markdown-body :global(.task-list-item) {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2, 6px);
  }

  .markdown-body :global(.task-list-item input) {
    flex: 0 0 auto;
    margin: 0.3em 0 0;
    accent-color: var(--v4-text-2, var(--muted));
  }

  .markdown-body :global(.task-list-content) {
    min-width: 0;
  }

  .markdown-body :global(a) {
    color: var(--v4-text-1, var(--fg));
    text-decoration-color: var(--v4-control-border, var(--border-strong));
    text-underline-offset: 0.14em;
  }

  .markdown-body :global(a:hover) {
    text-decoration: underline;
  }

  .markdown-body :global(code) {
    padding: 1px var(--space-1, 4px);
    border-radius: var(--v4-radius-button, var(--radius-sm, 6px));
    background: var(--v4-control-faint, var(--row-active));
    color: var(--v4-text-1, var(--fg));
    font-family: var(--font-mono);
    font-size: var(--type-secondary, var(--text-sm));
  }

  .markdown-body :global(pre) {
    margin: var(--space-3, 10px) 0;
    padding: var(--space-3, 10px);
    overflow-x: auto;
    border: 1px solid var(--v4-hairline, var(--border));
    border-radius: 0;
    background: var(--v4-inset, var(--bg-subtle));
  }

  .markdown-body :global(pre code) {
    padding: 0;
    background: transparent;
  }

  .markdown-body :global(blockquote) {
    margin: var(--space-3, 10px) 0;
    padding: var(--space-1, 4px) var(--space-3, 10px);
    border-left: 3px solid var(--v4-control-border, var(--border-strong));
    color: var(--v4-text-3, var(--muted-3));
  }

  .markdown-body :global(hr) {
    margin: var(--space-4, 12px) 0;
    border: 0;
    border-top: 1px solid var(--v4-hairline, var(--border));
  }

  .markdown-body :global(strong) {
    color: var(--v4-text-1, var(--fg));
    font-weight: 600;
  }

  .markdown-body :global(del) {
    color: var(--v4-text-3, var(--muted-3));
  }

  .markdown-body :global(img) {
    display: block;
    max-width: 100%;
    height: auto;
    margin: var(--space-3, 10px) 0;
  }

  .markdown-body :global(.markdown-table-scroll) {
    max-width: 100%;
    margin: var(--space-3, 10px) 0;
    overflow-x: auto;
    border: 0;
    border-radius: 0;
    background: transparent;
    scrollbar-color: var(--v4-control-border, var(--border-strong)) transparent;
  }

  .markdown-body :global(table) {
    width: 100%;
    min-width: max-content;
    border-spacing: 0;
    border-collapse: collapse;
    color: var(--v4-text-2, var(--muted));
    font-size: var(--type-secondary, var(--text-sm, var(--text-base)));
    line-height: 1.45;
  }

  .markdown-body :global(th),
  .markdown-body :global(td) {
    padding: var(--space-2, 6px) var(--space-3, 10px);
    border-right: 1px solid var(--v4-hairline, var(--border));
    border-bottom: 1px solid var(--v4-hairline, var(--border));
    text-align: left;
    vertical-align: top;
  }

  .markdown-body :global(th:first-child),
  .markdown-body :global(td:first-child) {
    padding-left: 0;
  }

  .markdown-body :global(th:last-child),
  .markdown-body :global(td:last-child) {
    padding-right: 0;
    border-right: 0;
  }

  .markdown-body :global(tbody tr:last-child td) {
    border-bottom: 0;
  }

  .markdown-body :global(th) {
    color: var(--v4-text-1, var(--fg));
    font-weight: 600;
  }

  .markdown-body :global(.markdown-align-center) {
    text-align: center;
  }

  .markdown-body :global(.markdown-align-center img) {
    margin-inline: auto;
  }

  .markdown-body :global(.markdown-align-right) {
    text-align: right;
  }

  .markdown-body :global(.markdown-align-right img) {
    margin-left: auto;
  }

  .markdown-body :global(details) {
    margin: var(--space-3, 10px) 0;
    padding: var(--space-2, 6px) 0;
    border-top: 1px solid var(--v4-hairline, var(--border));
    border-bottom: 1px solid var(--v4-hairline, var(--border));
  }

  .markdown-body :global(summary) {
    color: var(--v4-text-1, var(--fg));
    font-weight: 600;
    cursor: pointer;
  }

  .markdown-body :global(summary:focus-visible) {
    outline: 2px solid var(--v4-focus-ring, var(--focus));
    outline-offset: 3px;
  }

  .markdown-body :global(details > :last-child) {
    margin-bottom: 0;
  }

  @keyframes preview-skeleton {
    from {
      background-position: 0 0;
    }
    to {
      background-position: -200% 0;
    }
  }

  @keyframes preview-action-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .preview-skeleton span {
      animation: none;
    }

    .reveal-btn {
      transition: none;
    }
  }

  @media (prefers-reduced-transparency: reduce) {
    .preview-pane,
    .preview-header,
    .preview-body {
      background: var(--v4-ground, var(--bg));
    }
  }
</style>

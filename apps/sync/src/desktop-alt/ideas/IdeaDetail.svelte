<script lang="ts">
  /**
   * Card detail (US-010): everything known about one capture, plus the
   * corrections that keep a wrong guess from becoming distrust.
   */
  import { onMount } from 'svelte';
  import { openBrowserUrl } from '../external-open';
  import { citedLabel } from '../../lib/ideas-cited-label';
  import type { IdeaCapture, IdeaKind } from '../../stores/ideaCaptures';
  import { createIdeaCapturesStore } from '../../stores/ideaCaptures';


  const KINDS: { id: IdeaKind; label: string }[] = [
    { id: 'x_post', label: 'X post' },
    { id: 'article', label: 'Article' },
    { id: 'quote', label: 'Quote' },
    { id: 'product', label: 'Product' },
    { id: 'color', label: 'Color' },
    { id: 'image', label: 'Plain image' },
  ];

  interface Props {
    record: IdeaCapture;
    imageSrc?: string | null;
    companies?: string[];
    store?: ReturnType<typeof createIdeaCapturesStore>;
    onclose?: () => void;
    onprev?: () => void;
    onnext?: () => void;
    /** Test injection for the host opener. */
    openUrl?: (url: string) => Promise<void>;
  }

  const {
    record,
    imageSrc = null,
    companies = [],
    store,
    onclose,
    onprev,
    onnext,
    openUrl,
  }: Props = $props();

  let noteDraft = $state('');
  let tagsDraft = $state('');
  let confirmDelete = $state(false);
  let ocrOpen = $state(false);

  let hydratedId = $state('');

  $effect(() => {
    if (record.id === hydratedId) return;
    hydratedId = record.id;
    noteDraft = record.note ?? '';
    tagsDraft = (record.tags ?? []).join(', ');
    confirmDelete = false;
  });

  const source = $derived(record.extraction_source ?? 'local');
  const confidencePct = $derived(
    record.confidence == null ? '—' : `${Math.round(record.confidence * 100)}%`,
  );
  const cited = $derived(citedLabel(record.cited_count));
  const extractedEntries = $derived(
    Object.entries(record.extracted ?? {}).filter(([, v]) => v != null && v !== ''),
  );

  const destinations = $derived(companies.filter((s) => s !== record.company_slug));

  async function persistNote(): Promise<void> {
    if (!store) return;
    if ((record.note ?? '') === noteDraft.trim()) return;
    await store.setNote(record.id, noteDraft);
  }

  async function persistTags(): Promise<void> {
    if (!store) return;
    const tags = tagsDraft
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const current = record.tags ?? [];
    if (tags.join('\0') === current.join('\0')) return;
    await store.setTags(record.id, tags);
  }

  async function changeKind(kind: IdeaKind): Promise<void> {
    if (!store || kind === record.kind) return;
    await store.correctKind(record.id, kind);
  }

  async function reassign(to: string): Promise<void> {
    if (!store || !to) return;
    if (await store.moveCapture(record.id, to)) onclose?.();
  }

  async function confirmAndDelete(): Promise<void> {
    if (!store) return;
    if (await store.deleteCapture(record.id)) onclose?.();
    else confirmDelete = false;
  }

  async function openProvenanceUrl(event: Event, url: string): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    const opener = openUrl ?? openBrowserUrl;
    await opener(url);
  }

  /** Flush blur-only drafts, then close. Escape never fires blur. */
  async function closeWithSave(): Promise<void> {
    await persistNote();
    await persistTags();
    onclose?.();
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      void closeWithSave();
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      onprev?.();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      onnext?.();
    }
  }

  onMount(() => {
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
</script>

<div
  class="idea-detail"
  data-testid="idea-detail"
  data-id={record.id}
  role="dialog"
  aria-modal="true"
  aria-label="Capture detail"
>
  <button type="button" class="idea-detail-close" data-testid="idea-detail-close" onclick={() => void closeWithSave()}>
    Close
  </button>

  <div class="idea-detail-image">
    {#if imageSrc}
      <img src={imageSrc} alt="" data-testid="idea-detail-image" />
    {:else}
      <div class="idea-detail-image-empty" data-testid="idea-detail-image-empty"></div>
    {/if}
  </div>

  <div class="idea-detail-meta">
    <label class="idea-detail-field">
      <span>Kind</span>
      <select
        data-testid="idea-detail-kind"
        value={record.kind === 'unknown' ? 'image' : record.kind}
        onchange={(e) => void changeKind((e.currentTarget.value as IdeaKind))}
      >
        {#each KINDS as option (option.id)}
          <option value={option.id}>{option.label}</option>
        {/each}
      </select>
    </label>
    <p class="idea-detail-confidence" data-testid="idea-detail-confidence">
      {confidencePct} · {source}
    </p>
  </div>

  {#if extractedEntries.length > 0}
    <dl class="idea-detail-extracted" data-testid="idea-detail-extracted">
      {#each extractedEntries as [key, value] (`${record.id}:${key}`)}
        <dt>{key}</dt>
        <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
      {/each}
    </dl>
  {/if}

  <label class="idea-detail-field">
    <span>Tags</span>
    <input
      data-testid="idea-detail-tags"
      type="text"
      bind:value={tagsDraft}
      onblur={() => void persistTags()}
    />
  </label>

  {#if record.ocr_text}
    <details class="idea-detail-ocr" data-testid="idea-detail-ocr" bind:open={ocrOpen}>
      <summary>OCR text</summary>
      <pre>{record.ocr_text}</pre>
    </details>
  {/if}

  <dl class="idea-detail-provenance" data-testid="idea-detail-provenance">
    <dt>App</dt>
    <dd>{record.provenance.app || '—'}</dd>
    <dt>Window</dt>
    <dd>{record.provenance.window_title || '—'}</dd>
    {#if record.provenance.url}
      <dt>URL</dt>
      <dd>
        <button
          type="button"
          class="idea-detail-url"
          data-testid="idea-detail-url"
          onclick={(e) => void openProvenanceUrl(e, record.provenance.url ?? '')}
          onauxclick={(e) => void openProvenanceUrl(e, record.provenance.url ?? '')}
        >{record.provenance.url}</button>
      </dd>
    {/if}
  </dl>

  <label class="idea-detail-field">
    <span>Note</span>
    <textarea
      data-testid="idea-detail-note"
      bind:value={noteDraft}
      onblur={() => void persistNote()}
      rows="3"
    ></textarea>
  </label>

  {#if cited}
    <p class="idea-detail-cited" data-testid="idea-detail-cited">{cited}</p>
  {/if}

  <p class="idea-detail-times" data-testid="idea-detail-times">
    Captured {record.created_at} · Updated {record.updated_at}
  </p>

  {#if destinations.length > 0}
    <label class="idea-detail-field">
      <span>Move to company</span>
      <select
        data-testid="idea-detail-move"
        value=""
        onchange={(e) => {
          const to = e.currentTarget.value;
          e.currentTarget.value = '';
          if (to) void reassign(to);
        }}
      >
        <option value="">Stay in {record.company_slug}</option>
        {#each destinations as slug (slug)}
          <option value={slug}>{slug}</option>
        {/each}
      </select>
    </label>
  {/if}

  {#if store?.writeError}
    <p class="idea-detail-error" data-testid="idea-detail-error" role="alert">
      That didn't save: {store.writeError}
    </p>
  {/if}

  {#if confirmDelete}
    <div class="idea-detail-confirm" data-testid="idea-detail-confirm">
      <p>Delete this capture?</p>
      <button type="button" data-testid="idea-detail-delete-yes" onclick={() => void confirmAndDelete()}>
        Delete
      </button>
      <button type="button" data-testid="idea-detail-delete-no" onclick={() => (confirmDelete = false)}>
        Cancel
      </button>
    </div>
  {:else}
    <button
      type="button"
      class="idea-detail-delete"
      data-testid="idea-detail-delete"
      onclick={() => (confirmDelete = true)}
    >
      Delete
    </button>
  {/if}
</div>

<style>
  .idea-detail-error {
    margin: 8px 0;
    font-size: 12px;
    color: var(--danger, #c45);
  }

  .idea-detail-url {
    padding: 0;
    border: 0;
    background: transparent;
    font: inherit;
    text-align: left;
    color: var(--accent, inherit);
    cursor: pointer;
    text-decoration: underline;
    word-break: break-all;
  }

  .idea-detail {
    position: fixed;
    inset: 0 auto 0 0;
    width: min(420px, 100vw);
    overflow: auto;
    background: var(--bg);
    border-right: 1px solid var(--border);
    padding: 16px;
    z-index: 40;
    font-family: var(--font-sans);
    color: var(--fg);
    box-shadow: 8px 0 24px color-mix(in srgb, var(--fg) 8%, transparent);
  }

  .idea-detail-close {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    background: transparent;
    border: 1px solid var(--border);
    color: var(--muted);
    border-radius: 4px;
    padding: 4px 8px;
    cursor: pointer;
  }

  .idea-detail-image {
    margin: 12px 0;
    background: var(--surface-panel);
  }

  .idea-detail-image img,
  .idea-detail-image-empty {
    width: 100%;
    display: block;
    max-height: 280px;
    object-fit: contain;
    min-height: 120px;
  }

  .idea-detail-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 10px 0;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .idea-detail-field input,
  .idea-detail-field select,
  .idea-detail-field textarea {
    font-family: var(--font-sans);
    font-size: 13px;
    letter-spacing: 0;
    text-transform: none;
    color: var(--fg);
    background: var(--surface-raise);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 6px 8px;
  }

  .idea-detail-confidence,
  .idea-detail-cited,
  .idea-detail-times {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--muted);
  }

  .idea-detail-extracted,
  .idea-detail-provenance {
    display: grid;
    grid-template-columns: 88px 1fr;
    gap: 4px 10px;
    font-size: 12px;
  }

  .idea-detail-extracted dt,
  .idea-detail-provenance dt {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .idea-detail-ocr {
    margin: 10px 0;
    font-size: 12px;
  }

  .idea-detail-ocr pre {
    white-space: pre-wrap;
    font-size: 11px;
  }


  .idea-detail-delete,
  .idea-detail-confirm button {
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    border-radius: 4px;
    padding: 6px 10px;
    cursor: pointer;
  }

  .idea-detail-delete {
    color: var(--danger, #c45);
    background: transparent;
    border: 1px solid currentColor;
  }

  .idea-detail-confirm {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
</style>

<script lang="ts">
  /**
   * Capture detail: everything known about one capture, plus the corrections
   * that keep a wrong guess from becoming distrust.
   */
  import type { IdeaCapture, IdeaKind } from "@hq/platform";
  import type { IdeaCapturesStore } from "./idea-captures.svelte.js";
  import { citedLabel, safeSourceUrl } from "./ideas-badges.js";

  const KINDS: { id: IdeaKind; label: string }[] = [
    { id: "x_post", label: "X post" },
    { id: "article", label: "Article" },
    { id: "quote", label: "Quote" },
    { id: "product", label: "Product" },
    { id: "color", label: "Color" },
    { id: "image", label: "Plain image" },
  ];

  interface Props {
    record: IdeaCapture;
    imageSrc?: string | null;
    companies?: string[];
    store?: IdeaCapturesStore;
    onclose?: () => void;
    onprev?: () => void;
    onnext?: () => void;
    /** Test injection for the host opener. */
    openUrl?: (url: string) => void;
  }

  let {
    record,
    imageSrc = null,
    companies = [],
    store,
    onclose,
    onprev,
    onnext,
    openUrl,
  }: Props = $props();

  let noteDraft = $state("");
  let tagsDraft = $state("");
  let confirmDelete = $state(false);
  let hydratedId = $state("");

  $effect(() => {
    if (record.id === hydratedId) return;
    hydratedId = record.id;
    noteDraft = record.note ?? "";
    tagsDraft = (record.tags ?? []).join(", ");
    confirmDelete = false;
  });

  const source = $derived(record.extraction_source ?? "local");
  const confidencePct = $derived(
    record.confidence == null ? "—" : `${Math.round(record.confidence * 100)}%`,
  );
  const cited = $derived(citedLabel(record.cited_count));
  const extractedEntries = $derived(
    Object.entries(record.extracted ?? {}).filter(
      ([, v]) => v != null && v !== "",
    ),
  );
  const sourceUrl = $derived(safeSourceUrl(record.provenance?.url));
  const destinations = $derived(
    companies.filter((s) => s !== record.company_slug),
  );

  async function persistNote(): Promise<void> {
    if (!store) return;
    if ((record.note ?? "") === noteDraft.trim()) return;
    await store.setNote(record.id, noteDraft);
  }

  async function persistTags(): Promise<void> {
    if (!store) return;
    const tags = tagsDraft
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const current = record.tags ?? [];
    if (tags.join("\0") === current.join("\0")) return;
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

  function openSource(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    if (!sourceUrl) return;
    if (openUrl) {
      openUrl(sourceUrl);
      return;
    }
    window.open(sourceUrl, "_blank", "noopener,noreferrer");
  }

  /** Flush blur-only drafts, then close. Escape never fires blur. */
  async function closeWithSave(): Promise<void> {
    await persistNote();
    await persistTags();
    onclose?.();
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      void closeWithSave();
      return;
    }
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT")
    ) {
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onprev?.();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onnext?.();
    }
  }
</script>

<svelte:window on:keydown={onKey} />

<div
  class="idea-detail"
  data-testid="idea-detail"
  data-id={record.id}
  role="dialog"
  aria-modal="true"
  aria-label="Capture detail"
>
  <div class="idea-detail-head">
    <h2 class="idea-detail-title">Capture</h2>
    <button
      type="button"
      class="idea-detail-close"
      data-testid="idea-detail-close"
      onclick={() => void closeWithSave()}
    >
      Close
    </button>
  </div>

  <div class="idea-detail-image">
    {#if imageSrc}
      <img src={imageSrc} alt="" data-testid="idea-detail-image" />
    {:else}
      <div
        class="idea-detail-image-empty"
        data-testid="idea-detail-image-empty"
      ></div>
    {/if}
  </div>

  <label class="idea-field">
    <span class="idea-k">Kind</span>
    <select
      class="idea-sel"
      data-testid="idea-detail-kind"
      value={record.kind === "unknown" ? "image" : record.kind}
      onchange={(e) => void changeKind(e.currentTarget.value as IdeaKind)}
    >
      {#each KINDS as option (option.id)}
        <option value={option.id}>{option.label}</option>
      {/each}
    </select>
  </label>
  <p class="idea-val" data-testid="idea-detail-confidence">
    {confidencePct} · {source}
  </p>

  {#if extractedEntries.length > 0}
    <dl class="idea-dl" data-testid="idea-detail-extracted">
      {#each extractedEntries as [key, value] (`${record.id}:${key}`)}
        <dt>{key}</dt>
        <dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd>
      {/each}
    </dl>
  {/if}

  <label class="idea-field">
    <span class="idea-k">Tags</span>
    <input
      class="idea-in"
      data-testid="idea-detail-tags"
      type="text"
      bind:value={tagsDraft}
      onblur={() => void persistTags()}
    />
  </label>

  {#if record.ocr_text}
    <details class="idea-ocr" data-testid="idea-detail-ocr">
      <summary>OCR text</summary>
      <pre>{record.ocr_text}</pre>
    </details>
  {/if}

  <dl class="idea-dl" data-testid="idea-detail-provenance">
    <dt>App</dt>
    <dd>{record.provenance.app || "—"}</dd>
    <dt>Window</dt>
    <dd>{record.provenance.window_title || "—"}</dd>
    {#if sourceUrl}
      <dt>URL</dt>
      <dd>
        <button
          type="button"
          class="idea-url"
          data-testid="idea-detail-url"
          onclick={openSource}
          onauxclick={openSource}>{sourceUrl}</button
        >
      </dd>
    {/if}
  </dl>

  <label class="idea-field">
    <span class="idea-k">Note</span>
    <textarea
      class="idea-in idea-textarea"
      data-testid="idea-detail-note"
      bind:value={noteDraft}
      onblur={() => void persistNote()}
      rows="3"
    ></textarea>
  </label>

  {#if cited}
    <p class="idea-cited-line" data-testid="idea-detail-cited">{cited}</p>
  {/if}

  <p class="idea-val" data-testid="idea-detail-times">
    Captured {record.created_at} · Updated {record.updated_at}
  </p>

  {#if destinations.length > 0}
    <label class="idea-field">
      <span class="idea-k">Move to company</span>
      <select
        class="idea-sel"
        data-testid="idea-detail-move"
        value=""
        onchange={(e) => {
          const to = e.currentTarget.value;
          e.currentTarget.value = "";
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
    <p class="idea-error" data-testid="idea-detail-error" role="alert">
      That didn't save: {store.writeError}
    </p>
  {/if}

  {#if confirmDelete}
    <div class="idea-confirm" data-testid="idea-detail-confirm">
      <p>Delete this capture?</p>
      <button
        type="button"
        data-testid="idea-detail-delete-yes"
        onclick={() => void confirmAndDelete()}
      >
        Delete
      </button>
      <button
        type="button"
        data-testid="idea-detail-delete-no"
        onclick={() => (confirmDelete = false)}
      >
        Cancel
      </button>
    </div>
  {:else}
    <button
      type="button"
      class="idea-delete"
      data-testid="idea-detail-delete"
      onclick={() => (confirmDelete = true)}
    >
      Delete
    </button>
  {/if}
</div>

<style>
  .idea-detail {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 340px;
    z-index: 2;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px 18px 24px;
    overflow: auto;
    background: var(--raised, #1c1c1c);
    border-left: 1px solid color-mix(in srgb, var(--t1) 10%, transparent);
    color: var(--t1);
  }

  .idea-detail-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .idea-detail-title {
    margin: 0;
    font-size: 20px;
    font-weight: 500;
    color: var(--t1);
  }

  .idea-detail-image img,
  .idea-detail-image-empty {
    width: 100%;
    max-height: 200px;
    object-fit: cover;
    display: block;
    border-radius: 6px;
    background: color-mix(in srgb, var(--t1) 6%, transparent);
  }

  .idea-detail-image-empty {
    height: 120px;
  }

  .idea-field {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .idea-k {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--t3);
  }

  .idea-val {
    margin: 0;
    font-size: 13px;
    color: var(--t2);
  }

  .idea-in,
  .idea-sel {
    min-height: 28px;
    padding: 4px 8px;
    border: 1px solid color-mix(in srgb, var(--t1) 12%, transparent);
    border-radius: 6px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 13px;
  }

  .idea-textarea {
    resize: vertical;
  }

  .idea-dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 4px 10px;
    margin: 0;
    font-size: 13px;
  }

  .idea-dl dt {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--t3);
  }

  .idea-dl dd {
    margin: 0;
    color: var(--t2);
    overflow-wrap: anywhere;
  }

  .idea-ocr {
    font-size: 13px;
    color: var(--t2);
  }

  .idea-ocr pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 13px;
    color: var(--t2);
  }

  .idea-url {
    padding: 0;
    border: none;
    background: none;
    color: var(--t1);
    font: inherit;
    font-size: 13px;
    text-align: left;
    text-decoration: underline;
    cursor: pointer;
    overflow-wrap: anywhere;
  }

  .idea-cited-line {
    margin: 0;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--ok, #3fb950);
  }

  .idea-error {
    margin: 0;
    font-size: 13px;
    color: var(--danger, #f85149);
  }

  .idea-confirm {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 13px;
  }

  .idea-confirm p {
    margin: 0;
    flex: 1 1 100%;
  }

  .idea-confirm button,
  .idea-delete {
    align-self: flex-start;
    min-height: 28px;
    padding: 0 10px;
    border: 1px solid color-mix(in srgb, var(--t1) 14%, transparent);
    border-radius: 6px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .idea-detail-close {
    min-height: 28px;
    padding: 0 10px;
    border: 1px solid color-mix(in srgb, var(--t1) 14%, transparent);
    border-radius: 6px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .idea-confirm button:hover,
  .idea-delete:hover,
  .idea-detail-close:hover {
    background: var(--sel, color-mix(in srgb, var(--t1) 8%, transparent));
  }

  .idea-confirm button:focus-visible,
  .idea-delete:focus-visible,
  .idea-detail-close:focus-visible,
  .idea-url:focus-visible {
    outline: 2px solid var(--t1);
    outline-offset: 2px;
  }
</style>

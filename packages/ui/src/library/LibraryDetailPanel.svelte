<script lang="ts">
  /**
   * LibraryDetailPanel — right-side slide-over for a library item (worker or
   * skill). Structurally mirrors StoryDetailPanel (backdrop, Escape/backdrop/X
   * close, .detail-panel layout). On open it lazily loads the full detail:
   *
   *   * worker → loadWorkerDetail(path): name, type/team chips, description, a
   *     Skills section (name + optional description), and Instructions rendered
   *     as markdown.
   *   * skill  → loadSkillDetail(path): name, description, Allowed Tools chips,
   *     and the SKILL.md body rendered as markdown.
   *
   * Markdown is rendered by the dependency-free, CSP-safe lib/markdown.ts helper
   * (same as ProjectDetailView) — no `marked`, no DOM sanitizer.
   */
  import {
    loadSkillDetail,
    loadWorkerDetail,
    type LibraryItem,
    type SkillDetail,
    type WorkerDetail,
  } from "./library.js";
  import type { LibraryApi } from "@hq/platform";
  import { renderMarkdown } from "../common/markdown.js";
  import LabelChip from "../common/LabelChip.svelte";

  interface Props {
    /** Platform library seam for the lazy detail loads. Null renders the
     *  standard could-not-load state instead of a dead panel. */
    library: LibraryApi | null;
    /** The item to display. When null, the panel renders nothing. */
    item: LibraryItem | null;
    /** Called when the panel should close (Escape / backdrop / X). */
    onclose: () => void;
  }

  let { library, item, onclose }: Props = $props();

  let workerDetail = $state<WorkerDetail | null>(null);
  let skillDetail = $state<SkillDetail | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let reloadToken = $state(0);

  const title = $derived(
    item === null
      ? ""
      : item.kind === "worker"
        ? item.worker.name
        : item.skill.name,
  );
  const kindLabel = $derived(item?.kind === "worker" ? "Worker" : "Skill");

  // Load detail whenever the open item changes. Cancel-flag guards against an
  // out-of-order completion when the user clicks through items quickly.
  $effect(() => {
    const current = item;
    reloadToken;
    workerDetail = null;
    skillDetail = null;
    error = null;

    if (!current) {
      loading = false;
      return;
    }

    loading = true;
    let cancelled = false;

    void (async () => {
      if (!library) {
        error = "Details are not available here yet.";
        loading = false;
        return;
      }
      if (current.kind === "worker") {
        const res = await loadWorkerDetail(library, current.worker.path);
        if (cancelled) return;
        if (res.ok) workerDetail = res.value;
        else {
          console.error("LibraryDetailPanel load failed:", res.message);
          error =
            res.reason === "unavailable"
              ? "Details are not available here yet."
              : "Could not load details.";
        }
      } else {
        const res = await loadSkillDetail(library, current.skill.path);
        if (cancelled) return;
        if (res.ok) skillDetail = res.value;
        else {
          console.error("LibraryDetailPanel load failed:", res.message);
          error =
            res.reason === "unavailable"
              ? "Details are not available here yet."
              : "Could not load details.";
        }
      }
      loading = false;
    })();

    return () => {
      cancelled = true;
    };
  });

  const workerInstructionsHtml = $derived(
    workerDetail && workerDetail.instructions.trim() !== ""
      ? renderMarkdown(workerDetail.instructions)
      : "",
  );
  const skillBodyHtml = $derived(
    skillDetail && skillDetail.body.trim() !== ""
      ? renderMarkdown(skillDetail.body)
      : "",
  );

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.stopPropagation();
      onclose();
    }
  }

  function retryLoad(): void {
    if (loading) return;
    error = null;
    loading = true;
    reloadToken += 1;
  }
</script>

<svelte:window onkeydown={item ? handleKeydown : undefined} />

{#if item}
  <div
    class="detail-backdrop"
    data-testid="library-detail-backdrop"
    onclick={onclose}
    aria-hidden="true"
  ></div>

  <div
    class="detail-panel"
    role="dialog"
    aria-modal="true"
    aria-label={`${kindLabel}: ${title}`}
    aria-busy={loading}
    data-testid="library-detail-panel"
  >
    <header class="detail-header">
      <div class="header-text">
        <span class="kind-tag">{kindLabel}</span>
        <h2 class="detail-title">{title}</h2>
        <div class="badges">
          {#if item.kind === "worker"}
            {#if item.worker.type}
              <LabelChip label={item.worker.type} />
            {/if}
            {#if item.worker.team}
              <LabelChip label={item.worker.team} />
            {/if}
            <span class="scope-badge">
              {item.worker.scope === "company"
                ? (item.worker.company ?? "company")
                : "shared"}
            </span>
          {:else}
            <span class="scope-badge">
              {item.skill.scope === "company"
                ? (item.skill.company ?? "company")
                : item.skill.scope}
            </span>
          {/if}
        </div>
      </div>
      <button
        type="button"
        class="close-button"
        data-testid="library-detail-close"
        aria-label="Close details"
        onclick={onclose}
      >
        <span aria-hidden="true">×</span>
      </button>
    </header>

    <div class="detail-body">
      {#if error}
        <div class="detail-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            class="retry-button"
            data-testid="library-detail-retry"
            onclick={retryLoad}
            disabled={loading}
            aria-busy={loading}
          >
            {loading ? "Loading…" : "Retry"}
          </button>
        </div>
      {/if}

      {#if item.kind === "worker"}
        {#if item.worker.description}
          <section class="detail-section">
            <h3 class="section-title">Description</h3>
            <p class="section-body">{item.worker.description}</p>
          </section>
        {/if}

        {#if loading}
          <p class="muted-note">Loading…</p>
        {:else if workerDetail}
          {#if workerDetail.skills.length > 0}
            <section class="detail-section">
              <h3 class="section-title">Skills</h3>
              <ul class="skill-list">
                {#each workerDetail.skills as skill (skill.name)}
                  <li class="skill-item">
                    <span class="skill-name">{skill.name}</span>
                    {#if skill.description}
                      <span class="skill-desc">{skill.description}</span>
                    {/if}
                  </li>
                {/each}
              </ul>
            </section>
          {/if}

          {#if workerInstructionsHtml}
            <section class="detail-section">
              <h3 class="section-title">Instructions</h3>
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              <article class="markdown-body" data-testid="worker-instructions">
                {@html workerInstructionsHtml}
              </article>
            </section>
          {/if}
        {/if}
      {:else}
        {#if item.skill.description}
          <section class="detail-section">
            <h3 class="section-title">Description</h3>
            <p class="section-body">{item.skill.description}</p>
          </section>
        {/if}

        {#if item.skill.allowedTools.length > 0}
          <section class="detail-section">
            <h3 class="section-title">Allowed Tools</h3>
            <div class="chip-row">
              {#each item.skill.allowedTools as tool (tool)}
                <span class="tool-chip">{tool}</span>
              {/each}
            </div>
          </section>
        {/if}

        {#if loading}
          <p class="muted-note">Loading…</p>
        {:else if skillBodyHtml}
          <section class="detail-section">
            <h3 class="section-title">Details</h3>
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            <article class="markdown-body" data-testid="skill-body">
              {@html skillBodyHtml}
            </article>
          </section>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .detail-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: rgba(0, 0, 0, 0.14);
    animation: backdrop-fade 160ms ease;
  }

  .detail-panel {
    position: fixed;
    inset-block: 0;
    inset-inline-end: 0;
    z-index: 50;
    display: flex;
    flex-direction: column;
    width: 520px;
    max-width: 94vw;
    border-left: 1px solid var(--v4-hairline);
    background: var(--v4-popover);
    backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    -webkit-backdrop-filter: var(
      --v4-glass-filter-popover,
      var(--v4-glass-filter)
    );
    box-shadow:
      var(--v4-shadow-popover),
      inset 1px 0 0 var(--v4-glass-highlight);
    animation: panel-slide-in 200ms cubic-bezier(0.2, 0.7, 0.2, 1);
  }

  .detail-header {
    display: flex;
    flex-shrink: 0;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--v4-space-3);
    padding: var(--v4-space-5) var(--v4-space-5) var(--v4-space-4);
    border-bottom: 1px solid var(--v4-hairline);
  }

  .header-text {
    min-width: 0;
  }

  .kind-tag {
    color: var(--v4-text-2);
    font-size: var(--text-micro);
    font-weight: 600;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  .detail-title {
    margin: var(--v4-space-1) 0 0;
    color: var(--v4-text-1);
    font-size: var(--text-base);
    font-weight: 600;
    line-height: 22px;
    overflow-wrap: anywhere;
  }

  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: var(--v4-space-1);
    margin-top: var(--v4-space-2);
  }

  .scope-badge {
    display: inline-flex;
    align-items: center;
    padding: 1px 7px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
    color: var(--v4-text-3);
    font-size: var(--text-base);
    font-weight: 600;
    line-height: 16px;
    text-transform: lowercase;
  }

  .close-button {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-2);
    font-size: var(--text-base);
    line-height: 1;
    cursor: pointer;
    transition:
      background 140ms ease,
      color 140ms ease;
  }

  .close-button:hover {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .close-button:focus-visible {
    outline: 2px solid var(--v4-control-border);
    outline-offset: 2px;
  }

  .detail-body {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: var(--v4-space-5);
    min-height: 0;
    padding: var(--v4-space-5);
    overflow-y: auto;
  }

  .detail-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--v4-space-3);
    padding: var(--v4-space-3) 0;
    border: 0;
    border-top: 1px solid var(--v4-hairline);
    border-radius: 0;
    background: transparent;
    color: var(--v4-error);
    font-size: var(--text-base);
  }

  .retry-button {
    flex: 0 0 auto;
    min-height: 28px;
    padding: 0 var(--v4-space-3);
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-1);
    font: inherit;
    font-size: var(--text-base);
    cursor: pointer;
  }

  .retry-button:disabled {
    cursor: default;
    opacity: 0.55;
  }

  .retry-button:focus-visible {
    outline: 2px solid var(--v4-control-border);
    outline-offset: 2px;
  }

  .detail-section {
    min-width: 0;
  }

  .section-title {
    margin: 0 0 var(--v4-space-2);
    color: var(--v4-text-3);
    font-size: var(--text-micro);
    font-weight: 600;
    letter-spacing: 0;
    text-transform: uppercase;
  }

  .section-body {
    margin: 0;
    color: var(--v4-text-2);
    font-size: var(--text-base);
    line-height: 19px;
    overflow-wrap: anywhere;
  }

  .muted-note {
    margin: 0;
    color: var(--v4-text-3);
    font-size: var(--text-base);
  }

  .skill-list {
    display: flex;
    flex-direction: column;
    gap: 0;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .skill-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding: var(--v4-space-2) 0;
    border: 0;
    border-top: 1px solid var(--v4-hairline);
    border-radius: 0;
    background: transparent;
  }

  .skill-name {
    color: var(--v4-text-1);
    font-size: var(--text-base);
    font-weight: 600;
  }

  .skill-desc {
    color: var(--v4-text-2);
    font-size: var(--text-base);
    line-height: 16px;
  }

  .chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--v4-space-1);
  }

  .tool-chip {
    display: inline-flex;
    align-items: center;
    padding: 2px 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
    color: var(--v4-text-2);
    font-family: var(--font-mono);
    font-size: var(--text-base);
    font-weight: 600;
  }

  /* ---- markdown typography (mirrors ProjectDetailView .markdown-body) ----- */
  .markdown-body {
    color: var(--v4-text-1);
    font-size: var(--text-base);
    line-height: 1.6;
  }

  .markdown-body :global(h1),
  .markdown-body :global(h2),
  .markdown-body :global(h3),
  .markdown-body :global(h4),
  .markdown-body :global(h5),
  .markdown-body :global(h6) {
    margin: var(--v4-space-5) 0 var(--v4-space-2);
    color: var(--v4-text-1);
    font-weight: 600;
    line-height: 1.3;
  }

  .markdown-body :global(h1) {
    font-size: var(--text-base);
  }
  .markdown-body :global(h2) {
    padding-bottom: var(--v4-space-1);
    border-bottom: 1px solid var(--v4-hairline);
    font-size: var(--text-base);
  }
  .markdown-body :global(h3) {
    font-size: var(--text-base);
  }

  .markdown-body :global(p) {
    margin: var(--v4-space-2) 0;
    color: var(--v4-text-2);
  }

  .markdown-body :global(ul),
  .markdown-body :global(ol) {
    margin: var(--v4-space-2) 0;
    padding-left: var(--v4-space-5);
    color: var(--v4-text-2);
  }

  .markdown-body :global(li) {
    margin: var(--v4-space-1) 0;
  }

  .markdown-body :global(.task-list) {
    padding-left: 0;
    list-style: none;
  }

  .markdown-body :global(.task-list-item) {
    display: flex;
    align-items: flex-start;
    gap: var(--v4-space-2);
  }

  .markdown-body :global(.task-list-item input) {
    flex: 0 0 auto;
    margin: 0.3em 0 0;
    accent-color: var(--v4-text-2);
  }

  .markdown-body :global(.task-list-content) {
    min-width: 0;
  }

  .markdown-body :global(a) {
    color: var(--v4-text-1);
    text-decoration-color: var(--v4-control-border);
    text-underline-offset: 0.14em;
  }

  .markdown-body :global(a:hover) {
    text-decoration: underline;
  }

  .markdown-body :global(code) {
    padding: 1px var(--v4-space-1);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-faint);
    color: var(--v4-text-1);
    font-family: var(--font-mono);
    font-size: var(--text-base);
  }

  .markdown-body :global(pre) {
    margin: var(--v4-space-3) 0;
    padding: var(--v4-space-3);
    overflow-x: auto;
    border: 1px solid var(--v4-hairline);
    border-radius: 0;
    background: var(--v4-inset);
  }

  .markdown-body :global(pre code) {
    padding: 0;
    background: transparent;
  }

  .markdown-body :global(blockquote) {
    margin: var(--v4-space-3) 0;
    padding: var(--v4-space-1) var(--v4-space-3);
    border-left: 3px solid var(--v4-control-border);
    color: var(--v4-text-3);
  }

  .markdown-body :global(hr) {
    margin: var(--v4-space-4) 0;
    border: 0;
    border-top: 1px solid var(--v4-hairline);
  }

  .markdown-body :global(strong) {
    color: var(--v4-text-1);
    font-weight: 600;
  }

  .markdown-body :global(del) {
    color: var(--v4-text-3);
  }

  .markdown-body :global(img) {
    display: block;
    max-width: 100%;
    height: auto;
    margin: var(--v4-space-3) 0;
  }

  .markdown-body :global(.markdown-table-scroll) {
    max-width: 100%;
    margin: var(--v4-space-3) 0;
    overflow-x: auto;
    border: 0;
    border-radius: 0;
    background: transparent;
    scrollbar-color: var(--v4-control-border) transparent;
  }

  .markdown-body :global(table) {
    width: 100%;
    min-width: max-content;
    border-spacing: 0;
    border-collapse: collapse;
    color: var(--v4-text-2);
    font-size: var(--text-base);
    line-height: 1.45;
  }

  .markdown-body :global(th),
  .markdown-body :global(td) {
    padding: var(--v4-space-2) var(--v4-space-3);
    border-right: 1px solid var(--v4-hairline);
    border-bottom: 1px solid var(--v4-hairline);
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
    color: var(--v4-text-1);
    font-weight: 600;
  }

  .markdown-body :global(.markdown-align-center) {
    text-align: center;
  }

  .markdown-body :global(.markdown-align-right) {
    text-align: right;
  }

  @keyframes backdrop-fade {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @keyframes panel-slide-in {
    from {
      transform: translateX(16px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .detail-backdrop,
    .detail-panel {
      animation: none;
    }
  }

  @media (prefers-reduced-transparency: reduce) {
    .detail-backdrop {
      background: color-mix(in srgb, var(--c-bg) 74%, transparent);
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }

    .detail-panel {
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
  }
</style>

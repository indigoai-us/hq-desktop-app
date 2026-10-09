<script lang="ts">
  // Hovercard for a link inside a chat message. Opened by Conversation on
  // hover or keyboard focus of a `[data-link-preview]` anchor. Non-modal: it
  // never takes or traps focus, Escape closes it, and the link itself still
  // opens on click. Layout varies by provider (see lib/linkPreview.ts).
  import type { LinkPreview, LinkProvider } from '../../common/linkPreview';

  interface Props {
    id: string;
    href: string;
    preview: LinkPreview;
    /** Fetched page title for generic links, when known. */
    pageTitle?: string;
    /** Anchor rect in viewport coordinates. */
    rect: { left: number; top: number; bottom: number; width: number };
    onopen: (url: string) => void;
    oncopy: (url: string) => Promise<void> | void;
    onpointerenter?: () => void;
    onpointerleave?: () => void;
  }

  let {
    id,
    href,
    preview,
    pageTitle,
    rect,
    onopen,
    oncopy,
    onpointerenter,
    onpointerleave,
  }: Props = $props();

  const CARD_WIDTH = 300;
  const GAP = 6;

  let copied = $state(false);
  let cardEl = $state<HTMLDivElement | null>(null);
  let cardHeight = $state(0);

  const title = $derived(
    preview.wantsPageTitle && pageTitle ? pageTitle : preview.title,
  );
  const position = $derived.by(() => {
    const vw = typeof window === 'undefined' ? 1024 : window.innerWidth;
    const vh = typeof window === 'undefined' ? 768 : window.innerHeight;
    const left = Math.max(8, Math.min(rect.left, vw - CARD_WIDTH - 8));
    const below = rect.bottom + GAP;
    const fitsBelow = below + cardHeight <= vh - 8 || rect.top - GAP - cardHeight < 8;
    const top = fitsBelow ? below : rect.top - GAP - cardHeight;
    return { left, top };
  });

  $effect(() => {
    if (cardEl) cardHeight = cardEl.offsetHeight;
  });

  async function copy(): Promise<void> {
    await oncopy(href);
    copied = true;
    setTimeout(() => (copied = false), 1400);
  }

  const ICON_PATHS: Record<LinkProvider, string> = {
    calendar: 'M4 6.5h16M8 3v4M16 3v4M5 5h14v15H5z',
    github:
      'M9 19c-4 1.3-4-2-6-2.5M15 21v-3.4c0-1 .1-1.5-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6.2 0C6.6 2.9 5.6 3.2 5.6 3.2a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 4.2 9.6c0 4.6 2.7 5.7 5.5 6-.6.5-.6 1.1-.5 2V21',
    deploy: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
    linear: 'M4 14l6 6M4 9.5L14.5 20M5.5 6L18 18.5M9 4.3L19.7 15A8 8 0 0 0 9 4.3z',
    notion: 'M5 4h11l3 3v13H5zM9 9v7M9 9l6 7M15 9v7',
    'google-docs': 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 15h6M9 18h4',
    slack: 'M9 3v18M15 3v18M3 9h18M3 15h18',
    figma: 'M9 3h6a3 3 0 0 1 0 6H9zM9 9h6a3 3 0 1 1 0 6H9zM9 3a3 3 0 0 0 0 6M9 9a3 3 0 0 0 0 6M9 15a3 3 0 1 0 3 3v-3',
    loom: 'M12 3v6M12 15v6M3 12h6M15 12h6M5.6 5.6l4.3 4.3M14.1 14.1l4.3 4.3M5.6 18.4l4.3-4.3M14.1 9.9l4.3-4.3',
    youtube: 'M3 7.5A2.5 2.5 0 0 1 5.5 5h13A2.5 2.5 0 0 1 21 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5zM10 9l5 3-5 3z',
    generic: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z',
  };
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={cardEl}
  {id}
  class="link-card"
  data-link-card
  role="group"
  aria-label={`${preview.kind}: ${title}`}
  data-provider={preview.provider}
  style:left={`${position.left}px`}
  style:top={`${position.top}px`}
  style:width={`${CARD_WIDTH}px`}
  onpointerenter={onpointerenter}
  onpointerleave={onpointerleave}
>
  <div class="link-card-head">
    <svg
      class="link-card-icon"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    ><path d={ICON_PATHS[preview.provider]} /></svg>
    <span class="link-card-kind">{preview.kind}</span>
  </div>
  <div class="link-card-title">{title}</div>
  {#if preview.fields.length > 0}
    <dl class="link-card-fields">
      {#each preview.fields as field (field.label)}
        <div class="link-card-field">
          <dt>{field.label}</dt>
          <dd>{field.value}</dd>
        </div>
      {/each}
    </dl>
  {/if}
  <div class="link-card-url" title={href}>{href}</div>
  <div class="link-card-actions">
    {#if preview.action}
      <button
        type="button"
        class="link-card-btn"
        onclick={() => onopen(preview.action!.href)}
      >{preview.action.label}</button>
    {:else}
      <button type="button" class="link-card-btn" onclick={() => onopen(href)}>Open</button>
    {/if}
    <button type="button" class="link-card-btn" onclick={() => void copy()}>
      {copied ? 'Copied' : 'Copy link'}
    </button>
  </div>
</div>

<style>
  .link-card {
    position: fixed;
    z-index: 40;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--pop-border);
    border-radius: 6px;
    background: var(--pop-bg);
    color: var(--pop-text);
    box-shadow: 0 8px 24px color-mix(in srgb, #000 16%, transparent);
    font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, sans-serif);
    font-size: var(--text-base);
    line-height: 1.4;
    font-weight: 400;
  }

  .link-card-head {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    color: var(--pop-muted, var(--muted));
  }

  .link-card-icon {
    flex: none;
  }

  .link-card-kind {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .link-card-title {
    font-weight: 500;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .link-card-fields {
    display: grid;
    gap: 0.125rem;
    margin: 0;
  }

  .link-card-field {
    display: grid;
    grid-template-columns: 5.5rem 1fr;
    gap: 0.5rem;
  }

  .link-card-field dt {
    color: var(--pop-muted, var(--muted));
  }

  .link-card-field dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .link-card-url {
    color: var(--pop-muted, var(--muted));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .link-card-actions {
    display: flex;
    gap: 0.375rem;
    margin-top: 0.125rem;
  }

  .link-card-btn {
    padding: 0.1875rem 0.5rem;
    border: 1px solid var(--pop-border);
    border-radius: 6px;
    background: transparent;
    color: var(--pop-text);
    font: inherit;
    font-weight: 400;
    cursor: pointer;
    transition: background-color 0.12s ease;
  }

  .link-card-btn:hover {
    background: var(--pop-hover);
  }

  .link-card-btn:focus-visible {
    outline: 2px solid var(--pop-text);
    outline-offset: 2px;
  }
</style>

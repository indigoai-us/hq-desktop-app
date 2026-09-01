<script lang="ts">
  // Slack-style searchable emoji popover. Opened by the ReactionBar "+"
  // trigger; renders the full bundled dataset (lib/emoji-data.ts — plain
  // strings, no npm emoji dependency, bundle budget <15MB per tests/PERF.md)
  // with a search field, a "Frequently used" section first, and full keyboard
  // navigation (type to filter, arrows move, Enter picks, Escape closes).
  //
  // Positioning/stacking: the picker PORTALS itself to document.body and is
  // position:fixed, anchored to the "+" button's viewport rect. The previous
  // in-place absolute popover was clipped by ancestor overflow/stacking
  // contexts (message scroll panes, the thread-pane divider) and its z-index
  // lost to sibling panes — portaling sidesteps every ancestor clip/stack, and
  // the fixed position is recomputed on resize + capture-phase scroll with
  // viewport-edge flipping (above by default, below when there's no room) and
  // horizontal clamping so it never renders off-screen.
  import { buildSections, readFrequentCounts, recordEmojiUse } from '../../lib/emojiSearch';
  import type { EmojiEntry } from '../../lib/emoji-data';

  interface Props {
    // The element the popover anchors to (the ReactionBar "+" button).
    anchor: HTMLElement | null;
    // Called with the chosen emoji. The parent (ReactionBar) toggles + closes.
    onpick: (emoji: string) => void;
    // Called when the popover should dismiss without a pick (Escape / outside
    // click).
    onclose: () => void;
  }

  let { anchor, onpick, onclose }: Props = $props();

  const PICKER_WIDTH = 280;
  const PICKER_HEIGHT = 360;
  const MARGIN = 8; // viewport clamp margin
  const GAP = 4; // gap between anchor and popover

  let rootEl = $state<HTMLDivElement | null>(null);
  let listEl = $state<HTMLDivElement | null>(null);
  let inputEl = $state<HTMLInputElement | null>(null);
  let query = $state('');
  let activeIndex = $state(0);
  let top = $state(0);
  let left = $state(0);

  const storage = typeof localStorage === 'undefined' ? null : localStorage;
  let counts = $state(readFrequentCounts(storage));

  const sections = $derived(buildSections(query, counts));
  // Flat pick order across sections — drives arrow/Enter navigation.
  const flat = $derived(sections.flatMap((s) => s.entries));

  function pick(entry: EmojiEntry): void {
    recordEmojiUse(storage, entry.emoji);
    onpick(entry.emoji);
  }

  // ── Anchored fixed positioning with viewport flipping ────────────────────
  function reposition(): void {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = rootEl?.offsetWidth || PICKER_WIDTH;
    const height = rootEl?.offsetHeight || PICKER_HEIGHT;

    // Prefer above the trigger; flip below when there's not enough headroom.
    let nextTop = rect.top - height - GAP;
    if (nextTop < MARGIN) {
      const below = rect.bottom + GAP;
      // Only flip when below actually fits better; otherwise clamp above.
      nextTop = below + height + MARGIN <= vh ? below : Math.max(MARGIN, vh - height - MARGIN);
    }

    // Left-align to the trigger, clamped inside the viewport.
    let nextLeft = rect.left;
    if (nextLeft + width + MARGIN > vw) nextLeft = vw - width - MARGIN;
    if (nextLeft < MARGIN) nextLeft = MARGIN;

    top = nextTop;
    left = nextLeft;
  }

  // ── Dismissal (outside click / Escape) — portal-aware ────────────────────
  function onDocPointerDown(e: PointerEvent): void {
    if (!(e.target instanceof Node)) return;
    // Inside the portaled picker, or on the anchor button itself (its own
    // click handler toggles the open state) → not an outside click.
    if (rootEl?.contains(e.target)) return;
    if (anchor?.contains(e.target)) return;
    onclose();
  }

  function onDocKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      onclose();
    }
  }

  function onScrollOrResize(): void {
    reposition();
  }

  $effect(() => {
    const el = rootEl;
    if (!el) return;
    // Portal: re-home the popover under <body> so no ancestor overflow or
    // stacking context can clip it or stack panes above it.
    document.body.appendChild(el);
    reposition();
    inputEl?.focus();

    // Defer the pointer listener so the same tap that opened the picker
    // (still bubbling) doesn't immediately close it.
    const id = setTimeout(() => {
      document.addEventListener('pointerdown', onDocPointerDown, true);
    }, 0);
    document.addEventListener('keydown', onDocKeydown, true);
    window.addEventListener('resize', onScrollOrResize);
    // Capture-phase so scrolls inside any ancestor pane re-anchor the popover.
    document.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      clearTimeout(id);
      document.removeEventListener('pointerdown', onDocPointerDown, true);
      document.removeEventListener('keydown', onDocKeydown, true);
      window.removeEventListener('resize', onScrollOrResize);
      document.removeEventListener('scroll', onScrollOrResize, true);
      el.remove();
    };
  });

  // Keep the active cell valid + visible as the filter changes.
  $effect(() => {
    if (activeIndex >= flat.length) activeIndex = Math.max(0, flat.length - 1);
  });

  function scrollActiveIntoView(): void {
    const active = listEl?.querySelector('[data-active="true"]');
    if (active instanceof HTMLElement) active.scrollIntoView({ block: 'nearest' });
  }

  const COLUMNS = 8;

  function onInputKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      const entry = flat[activeIndex];
      if (entry) pick(entry);
      return;
    }
    let delta = 0;
    if (e.key === 'ArrowRight') delta = 1;
    else if (e.key === 'ArrowLeft') delta = -1;
    else if (e.key === 'ArrowDown') delta = COLUMNS;
    else if (e.key === 'ArrowUp') delta = -COLUMNS;
    else return;
    e.preventDefault();
    if (flat.length === 0) return;
    activeIndex = Math.min(flat.length - 1, Math.max(0, activeIndex + delta));
    scrollActiveIntoView();
  }

  function indexOfEntry(entry: EmojiEntry): number {
    return flat.indexOf(entry);
  }
</script>

<div
  class="emoji-picker"
  bind:this={rootEl}
  style:top={`${top}px`}
  style:left={`${left}px`}
  role="dialog"
  aria-label="Add a reaction"
  tabindex="-1"
>
  <input
    class="emoji-search"
    bind:this={inputEl}
    bind:value={query}
    oninput={() => (activeIndex = 0)}
    onkeydown={onInputKeydown}
    type="text"
    placeholder="Search emoji"
    aria-label="Search emoji"
    autocomplete="off"
    autocorrect="off"
    autocapitalize="off"
    spellcheck="false"
  />
  <div class="emoji-list" bind:this={listEl} role="listbox" aria-label="Emoji results">
    {#if flat.length === 0}
      <div class="emoji-empty">No emoji found</div>
    {:else}
      {#each sections as section (section.title)}
        <div class="emoji-section-title">{section.title}</div>
        <div class="emoji-grid">
          {#each section.entries as entry (entry.emoji)}
            <button
              class="emoji-cell"
              class:active={indexOfEntry(entry) === activeIndex}
              data-active={indexOfEntry(entry) === activeIndex ? 'true' : undefined}
              type="button"
              role="option"
              aria-selected={indexOfEntry(entry) === activeIndex}
              onclick={() => pick(entry)}
              onpointerenter={() => (activeIndex = indexOfEntry(entry))}
              aria-label={entry.name ? `React with ${entry.name}` : `React with ${entry.emoji}`}
              title={entry.name}
            >
              {entry.emoji}
            </button>
          {/each}
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .emoji-picker {
    position: fixed;
    z-index: 1000; /* above every pane — the popover is portaled to <body> */
    display: flex;
    flex-direction: column;
    width: 280px;
    max-height: 360px;
    padding: 0.375rem;
    border-radius: 12px;
    background: var(--pop-bg);
    border: 1px solid var(--pop-border);
    box-shadow: var(--pop-shadow), inset 0 1px 0 var(--pop-highlight);
    backdrop-filter: var(--glass-filter-soft, blur(16px) saturate(112%) contrast(101%));
    -webkit-backdrop-filter: var(--glass-filter-soft, blur(16px) saturate(112%) contrast(101%));
  }

  .emoji-picker:focus {
    outline: none;
  }

  .emoji-search {
    flex: none;
    width: 100%;
    box-sizing: border-box;
    margin-bottom: 0.375rem;
    padding: 0.375rem 0.5rem;
    border: 1px solid var(--c-field-border);
    border-radius: 8px;
    background: var(--c-field-bg);
    color: var(--pop-text);
    font-family: inherit;
    font-size: var(--text-base);
    line-height: 1.2;
  }

  .emoji-search::placeholder {
    color: var(--pop-muted);
  }

  .emoji-search:focus {
    outline: none;
    border-color: var(--c-field-border);
    background: var(--pop-hover);
  }

  .emoji-list {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .emoji-section-title {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 0.25rem 0.25rem 0.125rem;
    background: var(--pop-bg);
    color: var(--pop-muted);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .emoji-grid {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 0.125rem;
    padding-bottom: 0.25rem;
  }

  .emoji-empty {
    padding: 1.5rem 0;
    color: var(--pop-muted);
    font-size: var(--text-base);
    text-align: center;
  }

  .emoji-cell {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 2rem; /* 32px tap target */
    height: 2rem;
    padding: 0;
    border: none;
    border-radius: 8px;
    background: transparent;
    font-size: var(--text-lg);
    line-height: 1;
    cursor: pointer;
    transition: background-color 0.1s ease, transform 0.06s ease;
  }

  .emoji-cell.active,
  .emoji-cell:focus-visible {
    background: var(--pop-hover);
    outline: none;
  }

  @media (hover: hover) and (pointer: fine) {
    .emoji-cell:hover {
      background: var(--pop-hover);
    }
  }

  @media (prefers-reduced-transparency: reduce) {
    .emoji-picker {
      background: var(--c-bg);
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
  }

  .emoji-cell:active {
    transform: scale(0.9);
  }

  @media (prefers-reduced-motion: reduce) {
    .emoji-cell {
      transition: none;
    }

    .emoji-cell:active {
      transform: none;
    }
  }
</style>

<script lang="ts">
  // Compact emoji popover (US-025, ported from hq-sync desktop source). Renders
  // the CURATED ~24-emoji set as a grid of tap targets. Opened by an explicit
  // tap on the add-reaction trigger; closes on pick, Escape, or outside click.
  import { CURATED_EMOJI } from "./reactions";

  interface Props {
    onpick: (emoji: string) => void;
    onclose: () => void;
  }

  let { onpick, onclose }: Props = $props();

  let rootEl = $state<HTMLDivElement | null>(null);
  // Collision-aware placement: default opens above/left-aligned; flip when the
  // measured rect would clip the viewport (timeline top, window right edge).
  let placeBelow = $state(false);
  let alignRight = $state(false);

  $effect(() => {
    const el = rootEl;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (!placeBelow && rect.top < 8) placeBelow = true;
    if (!alignRight && rect.right > window.innerWidth - 8) alignRight = true;
  });

  function onDocPointerDown(e: PointerEvent): void {
    if (rootEl && e.target instanceof Node && !rootEl.contains(e.target)) {
      onclose();
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
    }
  }

  $effect(() => {
    // Defer adding the pointer listener so the same tap that opened the picker
    // (still bubbling) doesn't immediately close it.
    const id = setTimeout(() => {
      document.addEventListener("pointerdown", onDocPointerDown, true);
    }, 0);
    document.addEventListener("keydown", onKeydown, true);
    rootEl?.focus();
    return () => {
      clearTimeout(id);
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      document.removeEventListener("keydown", onKeydown, true);
    };
  });
</script>

<div
  class="emoji-picker"
  class:place-below={placeBelow}
  class:align-right={alignRight}
  bind:this={rootEl}
  role="menu"
  tabindex="-1"
  aria-label="Add a reaction"
>
  {#each CURATED_EMOJI as emoji (emoji)}
    <button
      class="emoji-cell"
      type="button"
      role="menuitem"
      onclick={() => onpick(emoji)}
      aria-label={`React with ${emoji}`}
    >
      {emoji}
    </button>
  {/each}
</div>

<style>
  .emoji-picker {
    position: absolute;
    z-index: 30;
    bottom: calc(100% + 0.25rem);
    left: 0;
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 0.125rem;
    padding: 0.375rem;
    width: max-content;
    max-width: 13.5rem;
    border-radius: 12px;
    background: var(--pop-bg);
    border: 1px solid var(--pop-border);
    box-shadow:
      var(--pop-shadow),
      inset 0 1px 0 var(--pop-highlight);
    backdrop-filter: var(
      --glass-filter-soft,
      blur(16px) saturate(112%) contrast(101%)
    );
    -webkit-backdrop-filter: var(
      --glass-filter-soft,
      blur(16px) saturate(112%) contrast(101%)
    );
  }

  .emoji-picker.place-below {
    bottom: auto;
    top: calc(100% + 0.25rem);
  }

  .emoji-picker.align-right {
    left: auto;
    right: 0;
  }

  .emoji-picker:focus {
    outline: none;
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
    transition:
      background-color 0.1s ease,
      transform 0.06s ease;
  }

  .emoji-cell:focus-visible {
    background: var(--pop-hover);
    outline: none;
  }

  @media (hover: hover) and (pointer: fine) {
    .emoji-cell:hover {
      background: var(--pop-hover);
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

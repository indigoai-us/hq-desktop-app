<!--
  Sidepane host (console-rail US-006).

  One host for every rail destination's left pane: a header slot, a scrolling
  body, and a pinned footer. Content models (Home, Company, Atlas) are swapped
  through `modelKey` without remounting the host, and the host remembers each
  model's scroll offset so switching to a company and back lands Home where it
  was.

  When the body content brings its own scroller (Home renders ChatSidebar,
  which scrolls `.chat-scroll`), pass `scrollSelector` and omit header/footer:
  the host then renders as `display: contents` so Home stays pixel-identical,
  and it tracks and restores the inner scroller instead of its own body.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { onDestroy } from "svelte";
  import { SidepaneScrollMemory } from "./sidepane-models.js";

  interface Props {
    modelKey: string;
    header?: Snippet;
    footer?: Snippet;
    children: Snippet;
    /** Inner scroller to track instead of the host body (Home / ChatSidebar). */
    scrollSelector?: string;
    /** Inject for tests; one memory lives with each host otherwise. */
    memory?: SidepaneScrollMemory;
    label?: string;
  }

  let {
    modelKey,
    header,
    footer,
    children,
    scrollSelector,
    memory,
    label = "Sidepane",
  }: Props = $props();

  const ownMemory = new SidepaneScrollMemory();
  const store = $derived(memory ?? ownMemory);

  let root = $state<HTMLElement | null>(null);
  let body = $state<HTMLElement | null>(null);

  // Updated before the DOM swaps so scroll events from the new model's
  // scroller are never filed under the previous key.
  let activeKey = "";
  let restoring = false;
  let restoreFrame = 0;

  const transparent = $derived(Boolean(scrollSelector) && !header && !footer);

  function scroller(): HTMLElement | null {
    if (scrollSelector) {
      return (root?.querySelector(scrollSelector) as HTMLElement | null) ?? null;
    }
    return body;
  }

  function isTracked(target: EventTarget | null): target is HTMLElement {
    if (!(target instanceof HTMLElement)) return false;
    if (scrollSelector) return target.matches(scrollSelector);
    return target === body;
  }

  function onScroll(event: Event): void {
    if (restoring || !activeKey) return;
    if (!isTracked(event.target)) return;
    store.save(activeKey, event.target.scrollTop);
  }

  function cancelRestore(): void {
    if (restoreFrame) cancelAnimationFrame(restoreFrame);
    restoreFrame = 0;
    restoring = false;
  }

  /**
   * Content paints from cache first and may grow over a few frames, so the
   * restore retries each frame until the offset sticks (bounded, ~1 s).
   * Any user input cancels it.
   */
  function restore(key: string): void {
    cancelRestore();
    const target = store.get(key);
    if (target <= 0) return;
    restoring = true;
    let frames = 0;
    const step = () => {
      restoreFrame = 0;
      if (key !== activeKey) return cancelRestore();
      const el = scroller();
      if (el) {
        el.scrollTop = target;
        if (Math.abs(el.scrollTop - target) < 1) return cancelRestore();
      }
      if (++frames >= 60) return cancelRestore();
      restoreFrame = requestAnimationFrame(step);
    };
    step();
  }

  $effect.pre(() => {
    const key = modelKey;
    if (key === activeKey) return;
    if (activeKey && !restoring) {
      const el = scroller();
      if (el) store.save(activeKey, el.scrollTop);
    }
    activeKey = key;
  });

  $effect(() => {
    const key = modelKey;
    if (!root) return;
    restore(key);
  });

  onDestroy(cancelRestore);
</script>

<div
  bind:this={root}
  class="sidepane"
  class:transparent
  data-testid="sidepane"
  data-sidepane-model={modelKey}
  role={transparent ? undefined : "navigation"}
  aria-label={transparent ? undefined : label}
  onscrollcapture={onScroll}
  onwheelcapture={cancelRestore}
  onpointerdowncapture={cancelRestore}
  onkeydowncapture={cancelRestore}
>
  {#if transparent}
    {@render children()}
  {:else}
    {#if header}
      <header class="sidepane-header" data-testid="sidepane-header">{@render header()}</header>
    {/if}
    <div class="sidepane-body" bind:this={body} data-testid="sidepane-body">
      {@render children()}
    </div>
    {#if footer}
      <footer class="sidepane-footer" data-testid="sidepane-footer">{@render footer()}</footer>
    {/if}
  {/if}
</div>

<style>
  .sidepane {
    display: flex;
    flex: 0 0 var(--sidebar-width, 260px);
    flex-direction: column;
    width: var(--sidebar-width, 260px);
    min-width: 0;
    min-height: 0;
    background: var(--side-bg);
    border-right: 1px solid var(--line);
    color: var(--t1);
    font-family: var(--font-ui);
  }

  .sidepane.transparent {
    display: contents;
  }

  .sidepane-header {
    flex: 0 0 auto;
    padding: 10px 8px 4px;
  }

  .sidepane-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    contain: layout paint;
    padding: 0 8px 12px;
    /* Bar comes from the shell's shared rule (chat/scrollbars.css). No
       scrollbar-width/-color: the standard properties beat
       ::-webkit-scrollbar and draw an ~11px bar through the 4px one. */
  }

  .sidepane-footer {
    flex: 0 0 auto;
    padding: 6px 8px 8px;
    border-top: 1px solid var(--line);
  }
</style>

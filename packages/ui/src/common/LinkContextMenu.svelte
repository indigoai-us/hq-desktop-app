<script lang="ts">
  /**
   * Ghost context menu for an external link. Open Link uses the host opener;
   * Copy Link writes the href. The native WebKit menu is already suppressed
   * by the caller via preventDefault.
   */
  import { onMount } from "svelte";

  import { copyLinkHref, type LinkMenuAnchor } from "./external-links.js";

  interface Props {
    menu: LinkMenuAnchor;
    onopenurl?: (url: string) => void;
    onclose: () => void;
  }

  let { menu, onopenurl, onclose }: Props = $props();

  let rootEl = $state<HTMLDivElement | null>(null);

  function portal(node: HTMLElement) {
    if (typeof document === "undefined") return {};
    const host =
      document.querySelector<HTMLElement>(".desktop-shell") ?? document.body;
    host.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }

  function openLink(): void {
    onopenurl?.(menu.href);
    onclose();
  }

  async function copyLink(): Promise<void> {
    const href = menu.href;
    onclose();
    try {
      await copyLinkHref(href);
    } catch {
      // Clipboard can be missing in tests / locked webviews.
    }
  }

  onMount(() => {
    function onPointerDown(event: PointerEvent): void {
      if (rootEl?.contains(event.target as Node)) return;
      onclose();
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onclose();
    }
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="link-context-menu"
  data-testid="link-context-menu"
  role="menu"
  tabindex="-1"
  aria-label="Link actions"
  use:portal
  bind:this={rootEl}
  style="left:{menu.x}px; top:{menu.y}px;"
  onmousedown={(e) => e.stopPropagation()}
>
  <button
    type="button"
    class="link-context-row"
    role="menuitem"
    data-testid="link-context-open"
    onclick={openLink}
  >
    Open Link
  </button>
  <button
    type="button"
    class="link-context-row"
    role="menuitem"
    data-testid="link-context-copy"
    onclick={() => void copyLink()}
  >
    Copy Link
  </button>
</div>

<style>
  .link-context-menu {
    position: fixed;
    z-index: 80;
    display: flex;
    flex-direction: column;
    min-width: 168px;
    padding: 6px;
    border: 1px solid var(--panel-border, var(--v4-hairline, rgba(255, 255, 255, 0.1)));
    border-radius: 12px;
    background: var(--panel-bg, rgba(44, 44, 54, 0.94));
    box-shadow: var(--panel-shadow, 0 16px 40px rgba(0, 0, 0, 0.4));
    backdrop-filter: blur(40px) saturate(1.5);
    -webkit-backdrop-filter: blur(40px) saturate(1.5);
    color: var(--t1, var(--v4-text-1, inherit));
    font: 400 12px/1.35 var(--font-ui, inherit);
  }

  .link-context-row {
    display: block;
    width: 100%;
    padding: 6px 8px;
    border: none;
    border-radius: 8px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-weight: 400;
    text-align: left;
    cursor: pointer;
  }

  .link-context-row:hover,
  .link-context-row:focus-visible {
    background: var(--hover, rgba(255, 255, 255, 0.06));
    outline: none;
  }
</style>

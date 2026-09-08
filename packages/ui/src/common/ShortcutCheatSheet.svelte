<script lang="ts">
  import { onMount } from "svelte";
  import {
    SHELL_FOCUS_FALLBACK,
    formatShortcut,
    listShortcuts,
    type ShortcutBinding,
  } from "./keyboard-shortcuts";

  interface Props {
    onclose: () => void;
    /** Override for tests; defaults to the live registry. */
    bindings?: ShortcutBinding[] | null;
    /**
     * Stable selector for where focus should land on close when the element
     * that opened the sheet is gone (policy
     * `indigo-app-wide-modal-focus-return-survives-trigger-unmount`). The
     * shell-level fallback below is tried last.
     */
    returnFocusSelector?: string | null;
  }

  let {
    onclose,
    bindings = null,
    returnFocusSelector = null,
  }: Props = $props();

  interface CheatSheetGroup {
    group: string;
    items: ShortcutBinding[];
  }

  /** Registry snapshot taken on open — the sheet is static while shown. */
  const groups: CheatSheetGroup[] = (() => {
    const source = bindings ?? listShortcuts();
    const byGroup = new Map<string, ShortcutBinding[]>();
    for (const binding of source) {
      const list = byGroup.get(binding.group) ?? [];
      list.push(binding);
      byGroup.set(binding.group, list);
    }
    return [...byGroup.entries()].map(([group, items]) => ({ group, items }));
  })();

  let panelEl = $state<HTMLDivElement | null>(null);
  let backdropEl = $state<HTMLDivElement | null>(null);

  const FOCUSABLE = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  /** Tab-order elements inside the panel, panel itself as the last resort. */
  function focusables(): HTMLElement[] {
    if (!panelEl) return [];
    return [...panelEl.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true",
    );
  }

  /**
   * Keep Tab inside the sheet. `aria-modal` alone does not constrain Tab in
   * any engine we ship on, so without this the next Tab walks the (visually
   * covered) app behind the dialog.
   */
  function trapTab(event: KeyboardEvent): void {
    if (event.key !== "Tab") return;
    const items = focusables();
    if (items.length === 0) {
      // Nothing tabbable: hold focus on the panel rather than leaking out.
      event.preventDefault();
      panelEl?.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey && (active === first || active === panelEl)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    } else if (active && !panelEl?.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  }

  /**
   * Hide everything that is not the dialog from AT and from tab order.
   *
   * Walks from the backdrop up to <body>, marking each ancestor's siblings
   * inert. That keeps the dialog's own subtree live without needing a portal.
   */
  function inertBackground(): () => void {
    const root = backdropEl;
    if (!root || typeof document === "undefined") return () => {};
    const touched: HTMLElement[] = [];
    let node: HTMLElement | null = root;
    while (node && node.parentElement) {
      const parent: HTMLElement = node.parentElement;
      for (const sibling of [...parent.children]) {
        if (sibling === node) continue;
        if (!(sibling instanceof HTMLElement)) continue;
        if (sibling.hasAttribute("inert")) continue;
        sibling.setAttribute("inert", "");
        sibling.setAttribute("aria-hidden", "true");
        touched.push(sibling);
      }
      if (parent === document.body) break;
      node = parent;
    }
    return () => {
      for (const el of touched) {
        el.removeAttribute("inert");
        el.removeAttribute("aria-hidden");
      }
    };
  }

  /**
   * Restore focus to the first still-connected candidate: the element that had
   * focus when the sheet opened, then the caller's stable selector, then the
   * shell fallback. The opener can unmount while the sheet is up (switching
   * views, a rail row disappearing), so a single retained node is not enough.
   */
  function restoreFocus(opener: HTMLElement | null): void {
    if (typeof document === "undefined") return;
    const candidates: Array<HTMLElement | null> = [opener];
    if (returnFocusSelector) {
      candidates.push(document.querySelector<HTMLElement>(returnFocusSelector));
    }
    candidates.push(document.querySelector<HTMLElement>(SHELL_FOCUS_FALLBACK));
    for (const candidate of candidates) {
      if (!candidate || !candidate.isConnected) continue;
      candidate.focus();
      if (document.activeElement === candidate) return;
    }
  }

  onMount(() => {
    const opener =
      typeof document === "undefined"
        ? null
        : (document.activeElement as HTMLElement | null);
    const releaseInert = inertBackground();
    panelEl?.focus();
    return () => {
      releaseInert();
      restoreFocus(opener);
    };
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="cheat-backdrop"
  data-testid="shortcut-cheat-sheet"
  bind:this={backdropEl}
  onclick={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    class="cheat-sheet"
    role="dialog"
    aria-modal="true"
    aria-labelledby="shortcut-cheat-sheet-title"
    tabindex="-1"
    bind:this={panelEl}
    onkeydown={(e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onclose();
        return;
      }
      trapTab(e);
    }}
  >
    <div class="cheat-head">
      <h2 id="shortcut-cheat-sheet-title">Keyboard shortcuts</h2>
      <button
        type="button"
        class="cheat-close"
        aria-label="Close keyboard shortcuts"
        onclick={onclose}
      >
        <kbd>Esc</kbd>
      </button>
    </div>
    <div class="cheat-list">
      {#if groups.length === 0}
        <div class="cheat-empty" role="status">No shortcuts registered</div>
      {:else}
        {#each groups as section (section.group)}
          <div class="cheat-section">
            <div class="cheat-section-title">{section.group}</div>
            {#each section.items as binding (binding.id)}
              <div class="cheat-row">
                <span class="cheat-label">{binding.label}</span>
                <kbd>{formatShortcut(binding.keys)}</kbd>
              </div>
            {/each}
          </div>
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  .cheat-backdrop {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: clamp(48px, 9vh, 72px) 20px 20px;
    background: color-mix(in srgb, var(--v4-text-1, #000) 22%, transparent);
  }

  .cheat-sheet {
    display: flex;
    flex-direction: column;
    width: min(480px, 100%);
    max-height: min(640px, calc(100dvh - 96px));
    min-height: 0;
    overflow: hidden;
    border: 1px solid var(--v4-hairline, var(--pop-border));
    border-radius: var(--v4-radius-popover);
    background: var(--v4-popover-strong, var(--pop-bg));
    backdrop-filter: var(--v4-glass-filter-popover, var(--v4-glass-filter));
    -webkit-backdrop-filter: var(
      --v4-glass-filter-popover,
      var(--v4-glass-filter)
    );
    box-shadow:
      var(--v4-shadow-popover, var(--pop-shadow)),
      inset 0 1px 0 var(--v4-glass-highlight);
    color: var(--v4-text-1, var(--pop-text));
    outline: none;
  }

  .cheat-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    height: 48px;
    flex: 0 0 auto;
    padding: 0 12px;
    border-bottom: 1px solid var(--pop-divider);
    background: var(--pop-hover);
  }

  .cheat-head h2 {
    margin: 0;
    color: var(--pop-text);
    font-size: var(--text-base);
    font-weight: 600;
    line-height: 18px;
  }

  .cheat-close {
    display: flex;
    align-items: center;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .cheat-sheet kbd {
    flex: 0 0 auto;
    min-width: 22px;
    padding: 0 5px;
    border: 1px solid var(--pop-border);
    border-radius: 5px;
    background: var(--pop-hover);
    color: var(--pop-muted);
    font-family: var(--font-mono);
    font-size: var(--text-base);
    line-height: 18px;
    text-align: center;
  }

  .cheat-list {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 6px;
    scrollbar-color: var(--pop-muted) transparent;
    scrollbar-gutter: stable;
    scrollbar-width: thin;
  }

  .cheat-section + .cheat-section {
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid var(--pop-divider);
  }

  .cheat-section-title {
    padding: 5px 8px 4px;
    color: var(--pop-muted);
    font-size: var(--text-micro);
    font-weight: 600;
    line-height: 14px;
    text-transform: uppercase;
  }

  .cheat-row,
  .cheat-empty {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 34px;
    padding: 4px 8px;
    color: var(--pop-text);
    font-size: var(--text-base);
    transition: background-color 120ms ease;
  }

  .cheat-row:hover {
    background: var(--pop-hover);
  }

  .cheat-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cheat-empty {
    justify-content: center;
    color: var(--pop-muted);
  }
</style>

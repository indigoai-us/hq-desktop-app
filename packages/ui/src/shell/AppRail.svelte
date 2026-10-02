<script lang="ts">
  /**
   * AppRail (console-rail US-003): the 56 px navigation rail on the left of
   * the shell. Order and destinations come from `app-rail.ts`; the shell owns
   * navigation and passes `onselect`. Selection is a background highlight
   * only (no accent bar). Company tiles (US-004) are 30 px circles with the
   * logomark or initials, a live dot, and drag reorder.
   */
  import Tooltip from "../common/Tooltip.svelte";
  import CompanyIcon from "../company/CompanyIcon.svelte";
  import { railTooltip, type RailItem, type RailItemId } from "./app-rail.js";

  interface Props {
    items: RailItem[];
    activeId: RailItemId | null;
    unreadCount?: number;
    youInitials?: string;
    onselect: (item: RailItem) => void;
    /** Drag reorder of pinned company tiles. Ids stay out of the DOM. */
    onreorderpins?: (fromUid: string, toUid: string) => void;
    /** More companies opens a popover instead of a page. */
    onmore?: () => void;
    moreExpanded?: boolean;
  }

  let {
    items,
    activeId,
    unreadCount = 0,
    youInitials = "",
    onselect,
    onreorderpins,
    onmore,
    moreExpanded = false,
  }: Props = $props();

  let dragUid = $state("");

  const top = $derived(items.filter((item) => item.kind !== "you"));
  const you = $derived(items.find((item) => item.kind === "you") ?? null);

  function initials(label: string): string {
    const parts = label.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return "?";
    if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
    return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  }

  // Company tiles carry no company uid in the DOM: the rail lists every
  // pinned company at once, and the tenant-boundary checks forbid another
  // company's uid on screen while one company is active.
  function onDragStart(item: RailItem, event: DragEvent): void {
    if (item.kind !== "company") return;
    dragUid = item.companyUid;
    event.dataTransfer?.setData("text/plain", "pin");
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  function onDragOver(item: RailItem, event: DragEvent): void {
    if (item.kind !== "company" || !dragUid) return;
    event.preventDefault();
  }

  function onDrop(item: RailItem, event: DragEvent): void {
    if (item.kind !== "company" || !dragUid) return;
    event.preventDefault();
    const from = dragUid;
    dragUid = "";
    if (from !== item.companyUid) onreorderpins?.(from, item.companyUid);
  }

  function shortcutHint(item: RailItem): string | null {
    const index = items.indexOf(item);
    return index >= 0 && index < 9 ? `⌘${index + 1}` : null;
  }
</script>

{#snippet railButton(item: RailItem)}
  <Tooltip label={railTooltip(item, { unread: unreadCount })} side="right" delay={150}>
    {#snippet trigger(describedBy: string)}
      <button
        type="button"
        class="rail-btn"
        data-testid={item.kind === "company" ? "rail-company" : `rail-${item.id}`}
        data-rail-id={item.kind === "company" ? "company" : item.id}
        aria-label={item.label}
        aria-describedby={describedBy || undefined}
        aria-current={activeId === item.id ? "page" : undefined}
        aria-expanded={item.kind === "more-companies" ? moreExpanded : undefined}
        aria-keyshortcuts={shortcutHint(item)?.replace("⌘", "Meta+") ?? undefined}
        draggable={item.kind === "company" ? "true" : "false"}
        ondragstart={(event) => onDragStart(item, event)}
        ondragover={(event) => onDragOver(item, event)}
        ondrop={(event) => onDrop(item, event)}
        ondragend={() => (dragUid = "")}
        onclick={() => {
          if (item.kind === "more-companies" && onmore) {
            onmore();
            return;
          }
          onselect(item);
        }}
      >
        {#if item.kind === "home"}
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11.5 12 4l9 7.5" /><path d="M5 10v10h5v-6h4v6h5V10" /></svg>
          {#if unreadCount > 0}<span class="badge" data-testid="rail-home-badge" aria-hidden="true"></span>{/if}
        {:else if item.kind === "meetings"}
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="13" height="10" rx="2" /><path d="m16 11 5-3v8l-5-3" /></svg>
        {:else if item.kind === "company"}
          <span class="co-tile" aria-hidden="true">
            {#if item.iconUrl}
              <CompanyIcon iconUrl={item.iconUrl} size={18} label={item.label} />
            {:else}
              {initials(item.label)}
            {/if}
          </span>
          {#if item.unreadCount > 0}
            <span class="badge" data-testid="rail-company-badge" aria-hidden="true"></span>
          {/if}
          {#if item.liveCount > 0}
            <span class="live" data-testid="rail-live-dot" aria-hidden="true"></span>
          {/if}
        {:else if item.kind === "more-companies"}
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1.5" /><rect x="14" y="4" width="6" height="6" rx="1.5" /><rect x="4" y="14" width="6" height="6" rx="1.5" /><path d="M17 14v6M14 17h6" /></svg>
        {:else if item.kind === "library"}
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
        {:else if item.id === "deployments"}
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17l6-6 4 4 6-6" /><path d="M14 9h6v6" /></svg>
        {:else if item.id === "telemetry"}
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h4l3-7 4 14 3-7h4" /></svg>
        {:else if item.id === "secrets"}
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="12" r="4" /><path d="M12 12h9M18 12v3M15 12v2" /></svg>
        {:else if item.id === "connections"}
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7H7a4 4 0 0 0 0 8h2M15 7h2a4 4 0 0 1 0 8h-2M8 11h8" /></svg>
        {:else if item.id === "outpost"}
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="6" rx="1.5" /><rect x="3" y="13" width="18" height="6" rx="1.5" /><path d="M7 8h.01M7 16h.01" /></svg>
        {:else if item.kind === "you"}
          <span class="avatar" aria-hidden="true">{youInitials || initials(item.label)}</span>
        {/if}
      </button>
    {/snippet}
  </Tooltip>
{/snippet}

<nav class="app-rail" aria-label="Primary" data-testid="app-rail">
  {#each top as item (item.id)}
    {@render railButton(item)}
  {/each}
  <div class="spacer" data-testid="rail-spacer"></div>
  {#if you}{@render railButton(you)}{/if}
</nav>

<style>
  .app-rail {
    flex: 0 0 56px;
    width: 56px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 10px 0;
    min-height: 0;
    /* Visible, not scrolled: a scroll container would clip the right-side
       tooltips. Twelve 40 px targets fit the 600 px minimum window height. */
    overflow: visible;
    position: relative;
    z-index: 3;
    background: var(--v4-sidebar);
    border-right: 1px solid var(--v4-hairline);
  }

  .spacer {
    flex: 1 1 auto;
  }

  .rail-btn {
    position: relative;
    width: 40px;
    height: 40px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 10px;
    background: transparent;
    color: var(--v4-text-2);
    cursor: default;
  }

  .rail-btn:hover {
    background: var(--v4-control-bg);
    color: var(--v4-text-1);
  }

  .rail-btn[aria-current="page"] {
    background: var(--v4-active-row);
    color: var(--v4-text-1);
  }

  .rail-btn:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: -2px;
  }

  .rail-btn svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .badge {
    position: absolute;
    top: 7px;
    right: 7px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--v4-error);
    border: 2px solid var(--v4-sidebar);
  }

  .co-tile,
  .avatar {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font: 600 12px/1 var(--font-ui);
    letter-spacing: 0.02em;
    background: var(--v4-control-bg);
    color: var(--v4-text-1);
  }

  .avatar {
    width: 26px;
    height: 26px;
    font-size: 10px;
  }

  .rail-btn[aria-current="page"] .co-tile {
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
  }

  .co-tile :global(.company-icon) {
    color: currentColor;
  }

  .live {
    position: absolute;
    bottom: 6px;
    right: 6px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--v4-ok);
    border: 2px solid var(--v4-sidebar);
    animation: dot-pulse 1.8s ease-in-out infinite;
  }

  @keyframes dot-pulse {
    0% { opacity: 1; }
    50% { opacity: 0.4; }
    100% { opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .live {
      animation: none;
    }
  }
</style>

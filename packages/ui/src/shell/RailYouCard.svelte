<script lang="ts">
  /**
   * Hover card on the rail's You button: your name, what you are working on,
   * and the badges you have earned, with "See all" to your profile panel.
   * Takes the place of the button's plain tooltip when you have badges.
   *
   * Opens after a short dwell on hover and at once on keyboard focus. It
   * stays open while the pointer crosses into it (a short close delay and a
   * bridge over the gap) and while focus is inside it, so its buttons can be
   * reached. Hidden while the account menu is open; a press on the button
   * (which opens that menu) closes it.
   */
  import type { Snippet } from "svelte";
  import ProfileBadges from "../badges/ProfileBadges.svelte";
  import type { EarnedBadge, ResolvedBadge } from "../badges/badge-catalog.js";

  interface Props {
    name: string;
    /** What you are working on now. Empty hides the line. */
    work?: string;
    badges: readonly EarnedBadge[];
    /** The account menu is open: stay hidden. */
    suppressed?: boolean;
    /** Hover dwell before opening, in ms. Focus opens at once. */
    delay?: number;
    onseeall?: () => void;
    onselect?: (badge: ResolvedBadge) => void;
    trigger: Snippet;
  }

  let { name, work = "", badges, suppressed = false, delay = 300, onseeall, onselect, trigger }: Props = $props();

  /** Up to two rows of four. */
  const MAX = 8;
  const CLOSE_DELAY = 160;

  let open = $state(false);
  let wrap = $state<HTMLSpanElement | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function later(next: boolean, ms: number): void {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      open = next && !suppressed;
    }, ms);
  }

  function hide(): void {
    clearTimer();
    open = false;
  }

  $effect(() => {
    if (suppressed) hide();
  });
  $effect(() => () => clearTimer());

  function onEnter(): void {
    if (suppressed) return;
    if (open) clearTimer();
    else later(true, delay);
  }

  function onFocusIn(): void {
    if (suppressed) return;
    clearTimer();
    open = true;
  }

  function onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (next instanceof Node && wrap?.contains(next)) return;
    hide();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Escape" || !open) return;
    hide();
    wrap?.querySelector<HTMLElement>("[data-testid='rail-you']")?.focus({ preventScroll: true });
  }

  function seeAll(): void {
    hide();
    onseeall?.();
  }

  function select(badge: ResolvedBadge): void {
    hide();
    onselect?.(badge);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span
  class="you-wrap"
  bind:this={wrap}
  onpointerenter={onEnter}
  onpointerleave={() => (open ? later(false, CLOSE_DELAY) : hide())}
  onfocusin={onFocusIn}
  onfocusout={onFocusOut}
  onkeydown={onKeyDown}
>
  <span class="trigger" onpointerdown={hide}>{@render trigger()}</span>
  {#if open && !suppressed}
    <div class="card" role="group" aria-label="Your badges" data-testid="rail-you-card">
      <div class="who">
        <div class="nm">{name}</div>
        {#if work}<div class="work" data-testid="rail-you-card-work">{work}</div>{/if}
      </div>
      <ProfileBadges {badges} max={MAX} onselect={select} onseeall={seeAll} />
    </div>
  {/if}
</span>

<style>
  .you-wrap { position: relative; display: inline-flex; align-items: center; }
  .trigger { display: inline-flex; }
  /* The account menu's surface: solid, so nothing reads through it. Opens
     to the right of the button, its bottom level with the button's, clear
     of the rail's edge by 8px like the rail tooltips. */
  .card {
    position: absolute; left: calc(100% + 18px); bottom: 0; z-index: 10001;
    box-sizing: border-box; width: 300px; padding: 12px 12px 8px;
    background: var(--overlay-bg);
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-popover, 8px);
    box-shadow: var(--v4-shadow-popover);
    color: var(--v4-text-1);
    font: 400 13px/1.4 var(--font-ui, var(--font-sans));
    text-align: left;
    animation: card-in 120ms ease-out;
  }
  /* A bridge over the gap, so moving into the card does not close it. */
  .card::before { content: ""; position: absolute; top: 0; bottom: 0; right: 100%; width: 20px; }
  .who { padding: 0 2px 10px; border-bottom: 1px solid var(--v4-hairline); }
  .nm { font-weight: 500; color: var(--v4-text-1); }
  .work { margin-top: 2px; color: var(--v4-text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* The section sits right under the name here, not after other profile
     sections. */
  .card :global([data-testid="profile-badges"] > .k) { margin-top: 10px; padding: 0 2px; }
  /* The card sits on the window's bottom edge: a badge's own hover card
     opens above it, not off the bottom of the window. */
  .card :global([data-testid="profile-badge-hover-card"]) { top: auto; bottom: calc(100% - 2px); }
  @keyframes card-in {
    from { opacity: 0; transform: translateX(-2px); }
  }
  @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
</style>

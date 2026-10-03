<!--
  Calendar chip and paste-link button for the right of the Meetings toolbar
  (console-rail US-042, storyboard revision 10). The chip reads the warm
  meetings store; the popover bodies load on first click behind a skeleton.
-->
<script lang="ts">
  import type { Component } from "svelte";
  import { meetingsStore } from "./meetings-store.svelte";
  import { calendarChipLabel } from "./meeting-link";
  import { loadCalendarPanel, loadPasteLinkBox } from "./meetings-toolbar-lazy";
  import type { OpenExternal } from "./meeting-calendar-actions";

  interface Props {
    openExternal?: OpenExternal;
  }

  let { openExternal }: Props = $props();

  let open = $state<"calendar" | "paste" | null>(null);
  let Body = $state<Component<Record<string, unknown>> | null>(null);
  let failed = $state(false);
  let ticket = 0;

  // BLANK-2: a failed calendar read is not "No calendar".
  const chip = $derived(
    meetingsStore.calendarReadFailed && meetingsStore.accounts.length === 0
      ? { connected: false, provider: "Calendar", count: "" }
      : calendarChipLabel(meetingsStore.accounts),
  );

  function toggle(which: "calendar" | "paste"): void {
    if (open === which) {
      close();
      return;
    }
    open = which;
    Body = null;
    failed = false;
    const mine = ++ticket;
    const load = which === "calendar" ? loadCalendarPanel() : loadPasteLinkBox();
    void load
      .then((mod) => {
        if (mine === ticket) Body = mod.default as unknown as Component<Record<string, unknown>>;
      })
      .catch((err) => {
        console.warn("[meetings] toolbar popover failed to load", err);
        if (mine === ticket) failed = true;
      });
  }

  function close(): void {
    open = null;
    Body = null;
    ticket += 1;
  }

  function onkeydown(e: KeyboardEvent): void {
    if (open && e.key === "Escape") close();
  }
</script>

<svelte:window {onkeydown} />

<div class="ctl">
  <button
    type="button"
    class="calchip"
    data-testid="meetings-calendar-chip"
    data-connected={chip.connected ? "true" : "false"}
    aria-expanded={open === "calendar"}
    aria-haspopup="dialog"
    onclick={() => toggle("calendar")}
  >
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="3" width="12" height="11" rx="2" stroke="currentColor" stroke-width="1.3"/><path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
    <span>{chip.provider}</span>{#if chip.count}<span class="ct">· {chip.count}</span>{/if}
  </button>
  <button
    type="button"
    class="icon-btn"
    data-testid="meetings-paste-link"
    aria-label="Paste meeting link"
    title="Paste meeting link"
    aria-expanded={open === "paste"}
    aria-haspopup="dialog"
    onclick={() => toggle("paste")}
  >
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6.5 9.5l3-3M7 4.5l1.2-1.2a2.6 2.6 0 013.6 3.6L10.6 8M9 11.5l-1.2 1.2a2.6 2.6 0 01-3.6-3.6L5.4 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
  </button>

  {#if open}
    <div class="scrim" role="presentation" onclick={close}></div>
    <div class="pop" class:wide={open === "paste"} role="dialog" aria-label={open === "calendar" ? "Calendars" : "Meeting link"} data-testid={open === "calendar" ? "meetings-calendar-panel" : "meetings-paste-box"}>
      {#if Body}
        <Body {openExternal} onclose={close} />
      {:else}
        <div class="sk" data-testid="meetings-toolbar-skeleton" aria-busy="true">
          <div class="bar"></div>
          <div class="line"></div>
          <div class="line short"></div>
          {#if failed}<p>Couldn't open this panel. Close it and try again.</p>{/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .ctl { position: relative; display: flex; align-items: center; gap: 6px; }
  /* Messages header controls: 28px, no border, hover fill only. */
  .calchip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 8px; border-radius: 8px; border: 0; background: transparent; color: var(--t2); font: inherit; font-size: 13px; cursor: pointer; }
  .calchip:hover, .icon-btn:hover { background: var(--hover); color: var(--t1); }
  .calchip[aria-expanded="true"], .icon-btn[aria-expanded="true"] { background: var(--sel, var(--hover)); }
  .ct { color: var(--t3); }
  .icon-btn { display: inline-grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 8px; background: transparent; color: var(--t2); cursor: pointer; }
  .scrim { position: fixed; inset: 0; z-index: 4; }
  .pop { position: absolute; top: 32px; right: 0; z-index: 5; width: 340px; padding: 12px; background: var(--overlay-bg, var(--v4-popover, var(--side-bg))); border: 1px solid var(--panel-border, var(--line)); border-radius: 8px; box-shadow: var(--panel-shadow, 0 8px 24px rgba(0, 0, 0, 0.25)); font-size: 13px; }
  .pop.wide { width: 380px; }
  .sk { padding: 2px 0; }
  .bar, .line { height: 10px; margin: 8px 0; border-radius: 6px; background: var(--hover); }
  .bar { width: 35%; }
  .line.short { width: 55%; }
  .sk p { color: var(--t2); font-size: 13px; margin: 8px 0 0; }
</style>

<!--
  Paste-a-link popover body (US-042, scene meetings-paste-link). Detects
  Zoom, Meet, or Teams, matches an upcoming meeting by its room, and offers
  Join now, Attach to…, and Cancel. Loaded through meetings-toolbar-lazy.
-->
<script lang="ts">
  import { meetingsStore } from "./meetings-store.svelte";
  import { meetingsRailState } from "./meetings-rail-state.svelte";
  import { clockLabel } from "./meetings-rail-model";
  import { eventStart, platformLabel } from "./meetings-model";
  import {
    PROVIDER_LABEL,
    detectMeetingProvider,
    matchUpcomingMeeting,
    upcomingMeetings,
    zoomMeetingLabel,
  } from "./meeting-link";
  import { joinPastedLink, type OpenExternal } from "./meeting-calendar-actions";

  interface Props {
    openExternal?: OpenExternal;
    onclose?: () => void;
  }

  let { openExternal, onclose }: Props = $props();

  let url = $state("");
  let attaching = $state(false);
  let joining = $state(false);
  const now = new Date();

  const trimmed = $derived(url.trim());
  const provider = $derived(detectMeetingProvider(trimmed));
  const events = $derived(meetingsStore.events);
  const match = $derived(provider ? matchUpcomingMeeting(trimmed, events, now) : null);
  const upcoming = $derived(upcomingMeetings(events, now));
  const ordered = $derived(match ? [match, ...upcoming.filter((e) => e.id !== match.id)] : upcoming);

  function timeOf(id: string): string {
    const e = events.find((row) => row.id === id);
    const start = e ? eventStart(e) : null;
    return start ? clockLabel(start) : "";
  }

  async function join(): Promise<void> {
    if (!provider || joining) return;
    joining = true;
    try {
      await joinPastedLink(trimmed, openExternal);
      onclose?.();
    } finally {
      joining = false;
    }
  }

  function attach(id: string): void {
    meetingsRailState.attachLink(id, trimmed);
    onclose?.();
  }

</script>

<div class="lbl">Meeting link</div>
<!-- svelte-ignore a11y_autofocus -->
<input class="field" data-testid="paste-link-input" placeholder="Paste a Zoom, Meet, or Teams link" aria-label="Meeting link" autofocus bind:value={url} />
{#if trimmed}
  <div class="det" data-testid="paste-link-detect">
    {#if provider}
      <span class="chip" data-testid="paste-link-provider">{PROVIDER_LABEL[provider]}</span>
      <span class="mm">
        {provider === "zoom" ? (zoomMeetingLabel(trimmed) ?? "Zoom meeting") : `${PROVIDER_LABEL[provider]} meeting`}{#if match} · matches {match.summary?.trim() || "a meeting"} at {timeOf(match.id)}{/if}
      </span>
    {:else}
      <span class="mm" data-testid="paste-link-unknown">Not a Zoom, Meet, or Teams link.</span>
    {/if}
  </div>
{/if}
<div class="actions">
  <button type="button" class="btn primary" data-testid="paste-link-join" disabled={!provider || joining} aria-busy={joining} onclick={() => void join()}>{joining ? "Opening…" : "Join now"}</button>
  <button type="button" class="btn" data-testid="paste-link-attach" disabled={!provider} aria-expanded={attaching} onclick={() => (attaching = !attaching)}>Attach to…</button>
  <button type="button" class="btn" onclick={() => onclose?.()}>Cancel</button>
</div>
{#if attaching && provider}
  <div class="rule"></div>
  <div class="lbl">Attach to a meeting</div>
  <div class="list" data-testid="paste-link-attach-list">
    {#each ordered as e (e.id)}
      <button type="button" class="opt" data-testid="paste-link-attach-option" onclick={() => attach(e.id)}>
        <span class="tm">{timeOf(e.id)}</span>
        <span class="tt">{e.summary?.trim() || "Untitled meeting"}</span>
        {#if match && e.id === match.id}<span class="chip">suggested</span>{:else if platformLabel(e)}<span class="mm">has {platformLabel(e)}</span>{/if}
      </button>
    {:else}
      <p class="mm">No upcoming meetings.</p>
    {/each}
  </div>
{/if}

<style>
  .lbl { font-size: 13px; font-weight: 500; line-height: 17px; color: var(--t2); margin: 0 0 8px; }
  .field { width: 100%; height: 28px; padding: 0 8px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: var(--t1); font: inherit; font-size: 13px; box-sizing: border-box; }
  .det { display: flex; align-items: center; gap: 8px; margin-top: 8px; min-width: 0; }
  .chip { font-size: 13px; color: var(--t2); white-space: nowrap; }
  .mm { font-size: 13px; color: var(--t3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .actions { display: flex; gap: 6px; margin-top: 12px; }
  .btn { height: 28px; padding: 0 10px; border: 1px solid var(--panel-border, var(--line)); border-radius: 6px; background: transparent; color: var(--t1); font: inherit; font-size: 13px; cursor: pointer; white-space: nowrap; }
  .btn:hover:not(:disabled) { background: var(--hover); }
  .btn.primary { border-color: transparent; background: var(--v4-primary-bg, var(--t1)); color: var(--v4-primary-fg, var(--side-bg)); }
  /* Disabled reads as quiet text, not a grey block beside an enabled Cancel. */
  .btn:disabled, .btn.primary:disabled { border-color: var(--line); background: transparent; color: var(--t3); cursor: default; }
  .rule { height: 1px; background: var(--line); margin: 12px 0; }
  .list { display: flex; flex-direction: column; }
  .opt { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; gap: 8px; align-items: center; min-height: 28px; padding: 4px 6px; border: 0; border-radius: 6px; background: transparent; color: var(--t1); font: inherit; font-size: 13px; line-height: 17px; text-align: left; cursor: pointer; }
  .opt:hover { background: var(--hover); }
  .tm { font-size: 13px; color: var(--t3); font-variant-numeric: tabular-nums; }
  .tt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>

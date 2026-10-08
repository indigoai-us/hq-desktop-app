<script lang="ts">
  /** Today's calls as a list, when the strip alone is not enough. */
  import type { BriefCalendarEvent } from "./brief-types.js";
  import { clockLabel, KIND_COLOR } from "./brief-time.js";

  let { events, rows }: { events: BriefCalendarEvent[]; rows: number } = $props();
</script>

<div class="w" data-testid="brief-agenda">
  <div class="eyebrow">Today</div>
  <h3>{events.length} call{events.length === 1 ? "" : "s"} · first at {events[0] ? clockLabel(events[0].start) : "—"}</h3>
  <div class="ag">
    {#each events.slice(0, rows > 2 ? 6 : 4) as e (e.id)}
      <div><span>{clockLabel(e.start)}</span><i style="background:{KIND_COLOR[e.kind]}"></i><b>{e.title}</b>{#if e.projected}<em>PROJECTED</em>{/if}</div>
    {/each}
  </div>
</div>

<style>
  .ag {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 14px;
  }
  .ag div {
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 8px 10px;
    border-radius: 12px;
    box-shadow: var(--b-well);
    font-size: 12px;
  }
  .ag span {
    font-family: var(--b-mono);
    font-size: 10px;
    color: rgba(255, 255, 255, 0.32);
    width: 52px;
    flex: none;
  }
  .ag i {
    width: 8px;
    height: 8px;
    border-radius: 3px;
    flex: none;
  }
  .ag b {
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ag em {
    font-style: normal;
    margin-left: auto;
    font-family: var(--b-mono);
    font-size: 9.5px;
    color: rgba(255, 255, 255, 0.32);
  }
</style>

<script lang="ts">
  /** Today's calendar on every brief, with a now-line. */
  import type { BriefCalendarEvent } from "./brief-types.js";
  import { clockLabel, hourOf } from "./brief-time.js";

  let { events, now, dateLabel, sample = false }: { events: BriefCalendarEvent[]; now: string; dateLabel: string; sample?: boolean } = $props();
  const H0 = 8;
  const H1 = 20.5;
  const X = (h: number) => Math.max(0, Math.min(100, ((h - H0) / (H1 - H0)) * 100));
  const placed = $derived.by(() => {
    const lanes: number[] = [];
    return events.map((e) => {
      const x = X(hourOf(e.start));
      let lane = 0;
      while (lanes[lane] != null && lanes[lane]! > x - 9) lane += 1;
      lanes[lane] = x;
      return { e, x, lane: Math.min(lane, 1) };
    });
  });
  const projected = $derived(events.some((e) => e.projected));
</script>

<div class="cal" data-testid="brief-today">
  <div class="lbl">TODAY{#if sample}<span class="sample-tag" title="No live calendar in this preview">Sample</span>{/if}<b>{dateLabel}</b></div>
  <div class="trk">
    {#each [8, 10, 12, 14, 16, 18, 20] as h (h)}
      <div class="hr" style="left:{X(h)}%">{h > 12 ? h - 12 : h}{h >= 12 ? "p" : "a"}</div>
      <div class="hl" style="left:{X(h)}%"></div>
    {/each}
    {#each placed as p (p.e.id)}
      <div
        class="ev {p.e.kind}"
        class:proj={p.e.projected}
        title="{clockLabel(p.e.start)} · {p.e.title}{p.e.projected ? ' · projected from your recurring meetings' : ''}"
        style="left:{p.x}%;top:{16 + p.lane * 17}px;max-width:{Math.max(9, 100 - p.x)}%"
      >{p.e.title}</div>
    {/each}
    <div class="now" style="left:{X(hourOf(now))}%"></div>
  </div>
  <div class="sum">{events.length ? `${events.length} CALL${events.length === 1 ? "" : "S"}` : "NO CALLS"}{#if projected}<br />PROJECTED{/if}</div>
</div>

<style>
  .cal {
    height: 52px;
    border-radius: 16px;
    box-shadow: var(--b-well);
    background: #1d1d20;
    display: flex;
    align-items: center;
    padding: 0 16px;
    gap: 16px;
  }
  .lbl {
    font-family: var(--b-mono);
    font-size: 10px;
    letter-spacing: 0.12em;
    color: rgba(255, 255, 255, 0.32);
    white-space: nowrap;
    width: 140px;
    flex: none;
  }
  .lbl b {
    display: block;
    color: rgba(255, 255, 255, 0.56);
    font-weight: 500;
    margin-top: 3px;
    letter-spacing: 0.04em;
  }
  .trk {
    position: relative;
    flex: 1;
    height: 100%;
    min-width: 0;
  }
  .hr {
    position: absolute;
    top: 4px;
    font-family: var(--b-mono);
    font-size: 9px;
    color: rgba(255, 255, 255, 0.22);
    translate: -50% 0;
  }
  .hl {
    position: absolute;
    top: 16px;
    bottom: 6px;
    width: 1px;
    background: rgba(255, 255, 255, 0.05);
  }
  .ev {
    position: absolute;
    height: 15px;
    border-radius: 6px;
    padding: 0 7px;
    font-size: 10.5px;
    line-height: 15px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: #fff;
    cursor: default;
    transition: filter 0.2s, box-shadow 0.2s;
  }
  .ev.team {
    background: linear-gradient(180deg, #4a5260, #363c47);
  }
  .ev.ext {
    background: linear-gradient(180deg, #14b8a6, #0f766e);
  }
  .ev.learn {
    background: linear-gradient(180deg, #ffb580, #e07a5f);
    color: #2a1408;
  }
  .ev.proj {
    background: transparent;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35);
    color: rgba(255, 255, 255, 0.56);
  }
  .ev:hover {
    filter: brightness(1.2);
    box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.25);
  }
  .now {
    position: absolute;
    top: 14px;
    bottom: 2px;
    width: 2px;
    border-radius: 2px;
    background: #ff809f;
    box-shadow: 0 0 10px rgba(255, 128, 159, 0.8);
  }
  .now::before {
    content: "";
    position: absolute;
    top: -4px;
    left: -3px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #ff809f;
  }
  .sum {
    font-family: var(--b-mono);
    font-size: 10px;
    color: rgba(255, 255, 255, 0.32);
    white-space: nowrap;
    text-align: right;
    width: 90px;
    flex: none;
  }
</style>

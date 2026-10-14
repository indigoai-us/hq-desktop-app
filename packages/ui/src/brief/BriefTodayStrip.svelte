<script lang="ts">
  /**
   * Today's calendar on every brief. Blocks span their real start and end;
   * overlaps stack into up to three lanes (the rest in a "+N" chip); the axis
   * fits the day's first and last event. Tentative is dashed, past is dimmed,
   * busy holds are hatched and unlabeled. Hover shows the event's peek.
   */
  import { peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import { layoutStrip, rangeText } from "./brief-strip.js";
  import type { BriefCalendarEvent } from "./brief-types.js";

  let {
    events,
    now,
    dateLabel,
    sample = false,
    onopenmeetings,
  }: { events: BriefCalendarEvent[]; now: string; dateLabel: string; sample?: boolean; onopenmeetings?: () => void } = $props();
  const brief = useBrief();
  const layout = $derived(layoutStrip(events, new Date(now)));
  const named = $derived(layout.items.filter((p) => !p.e.busy).length + layout.hidden.filter((e) => !e.busy).length);
  const projected = $derived(events.some((e) => e.projected));
  const LANE = 17;
  const height = $derived(22 + layout.lanes * LANE + 6);
  const X = (h: number) => ((h - layout.h0) / (layout.h1 - layout.h0)) * 100;
  const hourLabel = (h: number) => {
    const hh = ((h + 11) % 12) + 1;
    return `${hh}${h >= 12 && h < 24 ? "p" : "a"}`;
  };

  function content(e: BriefCalendarEvent): PeekContent {
    const sections: PeekContent["sections"] = [];
    if (e.attendees?.length) sections.push({ label: "With", lines: e.attendees.slice(0, 8).map((a) => ({ label: a, state: "" })) });
    if (e.joinUrl) sections.push({ label: "Join", text: e.joinUrl });
    return {
      sample: sample || e.projected,
      title: e.busy ? "Busy" : e.title,
      status: `${rangeText(e)}${e.tentative ? " · Maybe" : ""}`,
      sections,
      actions: onopenmeetings ? [{ label: "Open in Meetings", run: onopenmeetings, testid: "brief-strip-open-meetings" }] : [],
    };
  }
  function hiddenContent(): PeekContent {
    return {
      title: `${layout.hidden.length} more`,
      sections: [{ label: "Also today", lines: layout.hidden.map((e) => ({ label: e.busy ? "Busy" : e.title, state: rangeText(e) })) }],
      actions: onopenmeetings ? [{ label: "Open in Meetings", run: onopenmeetings }] : [],
    };
  }
</script>

<div class="cal" data-testid="brief-today" style="height:{height}px">
  <div class="lbl">Today{#if sample}<span class="sample-tag">Sample</span>{/if}<b>{dateLabel}</b></div>
  <div class="trk" data-h0={layout.h0} data-h1={layout.h1}>
    {#each layout.ticks as h (h)}
      <div class="hr" style="left:{X(h)}%">{hourLabel(h)}</div>
      <div class="hl" style="left:{X(h)}%"></div>
    {/each}
    {#each layout.items as p (p.e.id)}
      <div
        class="ev {p.e.kind}"
        class:busy={p.e.busy}
        class:tent={p.e.tentative}
        class:past={p.past}
        class:proj={p.e.projected}
        role="button"
        tabindex="0"
        aria-label="{p.e.busy ? 'Busy' : p.e.title}, {rangeText(p.e)}"
        data-testid="brief-strip-event"
        data-lane={p.lane}
        style="left:{p.x}%;width:{p.w}%;top:{20 + p.lane * LANE}px"
        use:peek={{ state: brief, content: () => content(p.e) }}
      >{#if !p.tiny && !p.e.busy}<span>{p.e.title}</span>{/if}</div>
    {/each}
    {#if layout.hidden.length}
      <div
        class="more"
        role="button"
        tabindex="0"
        data-testid="brief-strip-more"
        style="top:{20 + (layout.lanes - 1) * LANE}px"
        use:peek={{ state: brief, content: hiddenContent }}
      >+{layout.hidden.length}</div>
    {/if}
    {#if layout.nowX != null}<div class="now" style="left:{layout.nowX}%"></div>{/if}
  </div>
  <div class="sum">{named ? `${named} call${named === 1 ? "" : "s"}` : "No calls"}{#if projected}<br />Projected{/if}</div>
</div>

<style>
  /* A glass panel like the next-call card: the day as a row of pills. */
  .cal {
    min-height: 52px;
    border-radius: var(--b-r);
    border: 1px solid var(--b-panel-line);
    background: var(--b-panel);
    display: flex;
    align-items: center;
    padding: 0 16px;
    gap: 16px;
  }
  .lbl {
    font-family: var(--b-ui);
    font-size: 13px;
    font-weight: 500;
    letter-spacing: 0;
    color: var(--b-t2);
    white-space: nowrap;
    width: 140px;
    flex: none;
  }
  .lbl b {
    display: block;
    color: var(--b-t3);
    font-size: 11px;
    font-weight: 400;
    margin-top: 3px;
    letter-spacing: 0;
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
    font-size: 11px;
    color: rgb(var(--b-ink) / 0.42);
    translate: -50% 0;
  }
  .hl {
    position: absolute;
    top: 18px;
    bottom: 6px;
    width: 1px;
    background: rgb(var(--b-ink) / 0.05);
  }
  .ev {
    position: absolute;
    box-sizing: border-box;
    height: 15px;
    border-radius: 999px;
    padding: 0 7px;
    font-size: 11px;
    line-height: 15px;
    color: #fff;
    cursor: default;
    overflow: hidden;
    box-shadow: inset -1px 0 0 rgba(0, 0, 0, 0.35);
    transition: filter 0.2s, box-shadow 0.2s, opacity 0.2s;
  }
  .ev span {
    display: block;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ev.team {
    background: var(--b-ev-team);
    color: var(--b-ev-team-ink);
  }
  .ev.ext {
    background: #0f766e;
  }
  .ev.learn {
    background: #b8613f;
    color: #2a1408;
  }
  .ev.busy {
    background: repeating-linear-gradient(135deg, rgb(var(--b-ink) / 0.08) 0 3px, transparent 3px 7px);
    box-shadow: inset 0 0 0 1px rgb(var(--b-ink) / 0.08);
  }
  .ev.tent {
    background: transparent;
    box-shadow: inset 0 0 0 1px rgb(var(--b-ink) / 0.5);
    border: 1px dashed rgb(var(--b-ink) / 0.55);
    line-height: 13px;
    color: rgb(var(--b-ink) / 0.8);
  }
  .ev.proj {
    background: transparent;
    box-shadow: inset 0 0 0 1px rgb(var(--b-ink) / 0.35);
    color: rgb(var(--b-ink) / 0.56);
  }
  .ev.past {
    opacity: 0.42;
  }
  .ev:hover,
  .ev:focus-visible {
    filter: brightness(1.2);
    opacity: 1;
    box-shadow: 0 0 0 2px rgb(var(--b-ink) / 0.25);
    z-index: 2;
    outline: none;
  }
  .more {
    position: absolute;
    right: 0;
    height: 15px;
    padding: 0 6px;
    border-radius: 6px;
    font-family: var(--b-mono);
    font-size: 11px;
    line-height: 15px;
    color: rgb(var(--b-ink) / 0.75);
    background: #2a2a2f;
    box-shadow: var(--b-well);
    z-index: 3;
  }
  .now {
    position: absolute;
    top: 16px;
    bottom: 2px;
    width: 2px;
    border-radius: 2px;
    background: var(--b-sun-2);
    box-shadow: none;
    z-index: 4;
    pointer-events: none;
  }
  .now::before {
    content: "";
    position: absolute;
    top: -4px;
    left: -3px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--b-sun-2);
  }
  .sum {
    font-family: var(--b-mono);
    font-size: 11px;
    color: var(--b-t3);
    white-space: nowrap;
    text-align: right;
    width: 90px;
    flex: none;
  }
</style>

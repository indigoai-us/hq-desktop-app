<script lang="ts">
  /**
   * Your week: the shape of the last days in your own companies. One stacked
   * glass bar per day (sessions, meetings, merged), a white line over the tops
   * that draws oldest to today, and up to four beat discs (crisis red,
   * resolution green, push violet, turn white) that pop in day order. Today's
   * column is dashed and breathes: the day is still running. Hover a day or a
   * disc for the detail; at two rows the beats also list under the chart.
   * Hidden under three days of data, like the picker. No other-company count.
   */
  import { peek, useBrief } from "./brief-context.svelte.js";
  import {
    arcSentence,
    bars,
    BEAT_STYLE,
    beatPeek,
    dayLabel,
    dayPeek,
    dayTip,
    linePath,
    linePoints,
    MIN_DAYS,
    pickBeats,
    rangeLabel,
    restPeek,
  } from "./brief-week-arc.js";
  import type { BriefDay } from "./brief-types.js";

  interface Props {
    /** Up to 7 local days, oldest first (BriefInput.days). */
    days: BriefDay[];
    /** The brief's local date, YYYY-MM-DD: that column is dashed. Never the machine clock. */
    today: string;
    cols: number;
    rows: number;
  }
  let { days, today, cols, rows }: Props = $props();
  const brief = useBrief();

  const shown = $derived(days.length >= MIN_DAYS);
  const sentence = $derived(arcSentence(days, today));
  const range = $derived(rangeLabel(days));
  const cells = $derived(bars(days));
  const pts = $derived(linePoints(days));
  const endsToday = $derived(days.length > 1 && days[days.length - 1]!.date === today);
  // The line is solid up to the last full day; the step into today is dashed (the day is a guess still).
  const solid = $derived(linePath(endsToday ? pts.slice(0, -1) : pts));
  const projected = $derived(endsToday ? linePath(pts.slice(-2)) : "");
  const picked = $derived(pickBeats(days));
  const discs = $derived(picked.shown.map((b) => ({ ...b, x: pts[b.index]!.x, y: pts[b.index]!.y })));
  const tall = $derived(rows > 1);
  const chartHeight = $derived(tall ? 96 : cols >= 3 ? 64 : 60);
</script>

{#if shown}
  <div class="w" data-testid="brief-week-arc" data-days={days.length} data-today={today}>
    <div class="hd">
      <div class="eyebrow">
        <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 15c3 0 3-6 6-6s3 6 6 6 3-6 6-6" /></svg> Your week
      </div>
      {#if range}<span class="rng" data-testid="brief-week-range">{range}</span>{/if}
    </div>
    <h3 data-testid="brief-week-arc-title">{sentence}</h3>

    <div class="chart" style="--h:{chartHeight}px">
      <div class="cols">
        {#each cells as c, i (c.date)}
          {@const d = days[i]!}
          <div
            class="day"
            class:today={c.date === today}
            role="group"
            aria-label={dayTip(d)}
            data-testid="brief-week-day"
            data-date={c.date}
            use:peek={{ state: brief, content: () => dayPeek(d, today) }}
          >
            {#if c.total > 0}
              <div class="bar" style="--share:{c.share};animation-delay:{i * 70}ms">
                {#if c.sessions}<i class="seg sessions" style="--n:{c.sessions}"></i>{/if}
                {#if c.meetings}<i class="seg meetings" style="--n:{c.meetings}"></i>{/if}
                {#if c.merged}<i class="seg merged" style="--n:{c.merged}"></i>{/if}
              </div>
            {:else}
              <i class="stub"></i>
            {/if}
          </div>
        {/each}
      </div>
      <svg class="line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {#if solid.includes(" ")}<path class="ln" d={solid} pathLength="100" />{/if}
        {#if projected}<path class="proj" d={projected} pathLength="20" data-testid="brief-week-projection" />{/if}
      </svg>
      {#each discs as b, i (b.date)}
        <button
          type="button"
          class="disc"
          style="left:{b.x}%;top:{b.y}%;--c:{BEAT_STYLE[b.kind].color};animation-delay:{1.3 + i * 0.18}s"
          aria-label="{BEAT_STYLE[b.kind].name} · {dayLabel(b.date)} · {b.label}"
          data-testid="brief-week-beat"
          data-kind={b.kind}
          use:peek={{ state: brief, content: () => beatPeek(b) }}
        ></button>
      {/each}
    </div>
    <div class="lbls" aria-hidden="true">
      {#each cells as c (c.date)}<span class:today={c.date === today}>{dayLabel(c.date)}</span>{/each}
    </div>

    {#if tall && picked.shown.length}
      <div class="beats">
        {#each picked.shown as b (b.date)}
          <div class="bt" role="group" aria-label="{BEAT_STYLE[b.kind].name} · {b.label}" data-testid="brief-week-beat-row" use:peek={{ state: brief, content: () => beatPeek(b) }}>
            <i style="--c:{BEAT_STYLE[b.kind].color}"></i><b>{b.label}</b><span>{dayLabel(b.date)}</span>
          </div>
        {/each}
        {#if picked.rest.length}
          <div class="bt more" role="group" aria-label="More turning points" data-testid="brief-week-more" use:peek={{ state: brief, content: () => restPeek(picked.rest) }}>
            <i></i><b>+{picked.rest.length} more</b>
          </div>
        {/if}
      </div>
    {/if}

    <div class="key" data-testid="brief-week-key">
      <span><i class="sw sessions"></i>Sessions</span>
      <span class="dot">·</span>
      <span><i class="sw meetings"></i>Meetings</span>
      <span class="dot">·</span>
      <span><i class="sw merged"></i>Merged</span>
      {#if !tall && picked.rest.length}
        <span class="more" role="group" aria-label="More turning points" data-testid="brief-week-more" use:peek={{ state: brief, content: () => restPeek(picked.rest) }}>+{picked.rest.length} more</span>
      {/if}
    </div>
  </div>
{/if}

<style>
  .hd {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 10px;
  }
  .rng {
    font-family: var(--b-mono);
    font-size: 10px;
    letter-spacing: 0.04em;
    color: var(--b-t3);
    white-space: nowrap;
  }
  h3 {
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
  .chart {
    position: relative;
    height: var(--h);
    margin-top: 14px;
  }
  .cols {
    position: absolute;
    inset: 0;
    display: flex;
    gap: 8px;
    align-items: flex-end;
  }
  .day {
    position: relative;
    flex: 1;
    min-width: 0;
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    align-items: center;
    border-radius: 10px;
    cursor: default;
    transition: background 0.2s;
  }
  .day:hover {
    background: rgb(var(--b-ink) / 0.04);
  }
  .bar {
    width: 100%;
    max-width: 38px;
    height: calc(var(--share) * 84%);
    display: flex;
    flex-direction: column-reverse;
    gap: 2px;
    transform-origin: bottom;
    animation: grow 0.9s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  @keyframes grow {
    from {
      transform: scaleY(0);
    }
  }
  /* Glass segments: lit from the top, hairline rim, a tint by meaning. No backdrop-filter. */
  .seg {
    display: block;
    flex: var(--n) 0 0;
    min-height: 3px;
    border-radius: 4px;
    border: 1px solid rgb(var(--b-ink) / 0.1);
    background: var(--c);
  }
  .sessions {
    --c: rgba(201, 214, 228, 0.5);
  }
  .meetings {
    --c: rgba(20, 184, 166, 0.55);
  }
  .merged {
    --c: rgba(52, 199, 89, 0.5);
  }
  .stub {
    display: block;
    width: 100%;
    max-width: 38px;
    height: 2px;
    border-radius: 2px;
    background: rgb(var(--b-ink) / 0.12);
  }
  /* Today: still running, so dashed and breathing. */
  .today .seg {
    border-style: dashed;
    border-color: rgb(var(--b-ink) / 0.55);
  }
  .today .bar {
    animation:
      grow 0.9s cubic-bezier(0.2, 0.8, 0.2, 1) both,
      breathe 3s 1.2s ease-in-out infinite;
  }
  @keyframes breathe {
    50% {
      opacity: 0.55;
    }
  }
  .line {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
  }
  .line path {
    fill: none;
    stroke-linecap: round;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
  }
  .ln {
    stroke: #fff;
    stroke-width: 1.5;
    stroke-dasharray: 100;
    animation: draw 1.2s 0.3s ease-out both;
  }
  @keyframes draw {
    from {
      stroke-dashoffset: 100;
    }
  }
  .proj {
    stroke: rgb(var(--b-ink) / 0.55);
    stroke-width: 1.4;
    stroke-dasharray: 2 2;
    animation: breathe 3s 1.5s ease-in-out infinite;
  }
  .disc {
    all: unset;
    box-sizing: border-box;
    position: absolute;
    width: 12px;
    height: 12px;
    margin: -6px 0 0 -6px;
    border-radius: 50%;
    background: var(--c);
    border: 2px solid var(--b-card);
    box-shadow: none;
    cursor: default;
    transition: transform 0.2s;
    animation: pop 0.3s cubic-bezier(0.3, 1.6, 0.5, 1) both;
  }
  .disc:hover,
  .disc:focus-visible {
    transform: scale(1.35);
  }
  .disc:focus-visible {
    outline: 2px solid rgb(var(--b-ink) / 0.7);
    outline-offset: 2px;
  }
  @keyframes pop {
    from {
      transform: scale(0);
    }
  }
  .lbls {
    display: flex;
    gap: 8px;
    margin-top: 6px;
  }
  .lbls span {
    flex: 1;
    min-width: 0;
    text-align: center;
    font-family: var(--b-mono);
    font-size: 9.5px;
    color: var(--b-t3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .lbls .today {
    color: var(--b-t1);
  }
  .beats {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: 10px;
  }
  .bt {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 5px 8px;
    margin: 0 -8px;
    border-radius: 10px;
    font-size: 12px;
    line-height: 1.3;
    cursor: default;
    transition: background 0.2s;
  }
  .bt:hover {
    background: rgb(var(--b-ink) / 0.045);
  }
  .bt i {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--c, rgb(var(--b-ink) / 0.2));
    box-shadow: none;
  }
  .bt b {
    flex: 1;
    min-width: 0;
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bt span {
    font-family: var(--b-mono);
    font-size: 9.5px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--b-t3);
    white-space: nowrap;
  }
  .bt.more b {
    font-family: var(--b-mono);
    font-size: 10.5px;
    color: var(--b-t3);
  }
  .key {
    margin-top: auto;
    padding-top: 10px;
    display: flex;
    align-items: center;
    gap: 7px;
    font-family: var(--b-mono);
    font-size: 9.5px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--b-t3);
    white-space: nowrap;
  }
  .key .dot {
    color: var(--b-line);
  }
  .sw {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 2px;
    margin-right: 5px;
    vertical-align: -1px;
    background: var(--c);
  }
  .key .more {
    margin-left: auto;
    padding: 2px 7px;
    border-radius: 6px;
    text-transform: none;
    letter-spacing: 0.02em;
    font-size: 10px;
    color: var(--b-t2);
    box-shadow: inset 0 0 0 1px rgb(var(--b-ink) / 0.12);
    cursor: default;
  }
</style>

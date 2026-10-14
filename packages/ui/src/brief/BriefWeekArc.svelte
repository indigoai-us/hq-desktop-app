<script lang="ts">
  /**
   * Your week: the shape of the last days in your own companies. One stacked
   * bar per day in page-ink tints (sessions faintest at the base, meetings,
   * merged darkest on top) on a shared baseline, a thin smooth line over the
   * tops that reveals oldest to today, and up to four small beat markers in
   * ink (the record day alone in the brand terracotta) that pop in day order.
   * The step into today is dashed: the day is still running. Hover a day or a
   * marker for the detail; at two rows the beats also list under the chart.
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
    <div class="eyebrow">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 15c3 0 3-6 6-6s3 6 6 6 3-6 6-6" /></svg> Your week
    </div>
    <div class="ttl">
      <h3 data-testid="brief-week-arc-title">{sentence}</h3>
      {#if range}<span class="rng" data-testid="brief-week-range">{range}</span>{/if}
    </div>

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
        {#if solid.includes(" ")}<path class="ln" d={solid} />{/if}
        {#if projected}<path class="proj" d={projected} data-testid="brief-week-projection" />{/if}
      </svg>
      {#each discs as b, i (b.date)}
        <button
          type="button"
          class="disc"
          style="left:{b.x}%;top:{b.y}%;animation-delay:{1.3 + i * 0.18}s"
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
            <i class="mk" data-kind={b.kind}></i><b>{b.label}</b><span>{dayLabel(b.date)}</span>
          </div>
        {/each}
        {#if picked.rest.length}
          <div class="bt more" role="group" aria-label="More turning points" data-testid="brief-week-more" use:peek={{ state: brief, content: () => restPeek(picked.rest) }}>
            <i class="mk"></i><b>+{picked.rest.length} more</b>
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
  /* Monochrome card: page ink only. The brand terracotta (--b-hot) marks the record day and nothing else. */
  .w {
    --t-sessions: rgb(var(--b-ink) / 0.12);
    --t-meetings: rgb(var(--b-ink) / 0.3);
    --t-merged: rgb(var(--b-ink) / 0.55);
    --mk: rgb(var(--b-ink) / 0.8);
  }
  .ttl {
    display: flex;
    align-items: baseline;
    gap: 12px;
    margin-top: 8px;
  }
  .w h3 {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-size: 15px;
    font-weight: 500;
    line-height: 1.3;
    letter-spacing: -0.012em;
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
  .rng {
    flex: none;
    font-family: var(--b-ui);
    font-size: 11px;
    letter-spacing: 0;
    color: var(--b-t3);
    white-space: nowrap;
  }
  .chart {
    position: relative;
    height: var(--h);
    margin-top: 16px;
  }
  /* The shared baseline every bar stands on. */
  .chart::before {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 1px;
    background: rgb(var(--b-ink) / 0.1);
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
    border-radius: 6px 6px 0 0;
    cursor: default;
    transition: background 0.2s;
  }
  .day:hover {
    background: rgb(var(--b-ink) / 0.035);
  }
  /* One block per day: square on the baseline, 4px at the top, 1px seams between the parts. */
  .bar {
    width: 100%;
    max-width: 32px;
    height: calc(var(--share) * 84%);
    display: flex;
    flex-direction: column-reverse;
    gap: 1px;
    border-radius: 4px 4px 0 0;
    overflow: hidden;
    transform-origin: bottom;
    animation: grow 0.9s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  @keyframes grow {
    from {
      transform: scaleY(0);
    }
  }
  .seg {
    display: block;
    flex: var(--n) 0 0;
    min-height: 2px;
    background: var(--c);
  }
  .sessions {
    --c: var(--t-sessions);
  }
  .meetings {
    --c: var(--t-meetings);
  }
  .merged {
    --c: var(--t-merged);
  }
  .stub {
    display: block;
    width: 100%;
    max-width: 32px;
    height: 2px;
    background: rgb(var(--b-ink) / 0.12);
  }
  /* Today: still running. The step of the line into it is dashed and its label is set in full ink. */
  .line {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    pointer-events: none;
    animation: reveal 1.2s 0.3s ease-out both;
  }
  /* Reveal oldest to today with a clip, so the stroke itself stays one unbroken path. */
  @keyframes reveal {
    from {
      clip-path: inset(-8px 100% -8px -8px);
    }
    to {
      clip-path: inset(-8px -8px -8px -8px);
    }
  }
  .line path {
    fill: none;
    stroke: rgb(var(--b-ink) / 0.35);
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    vector-effect: non-scaling-stroke;
  }
  .proj {
    stroke-dasharray: 2 3;
  }
  /* Beat markers: a 6px dot in a 16px hit area, all one ink except the record day. */
  .disc {
    all: unset;
    box-sizing: border-box;
    position: absolute;
    width: 16px;
    height: 16px;
    margin: -8px 0 0 -8px;
    border-radius: 50%;
    cursor: default;
    transition: transform 0.2s;
    animation: pop 0.3s cubic-bezier(0.3, 1.6, 0.5, 1) both;
  }
  .disc::after {
    content: "";
    position: absolute;
    inset: 5px;
    border-radius: 50%;
    background: var(--mk);
  }
  .disc:hover,
  .disc:focus-visible {
    transform: scale(1.35);
  }
  .disc:focus-visible {
    outline: 1.5px solid rgb(var(--b-ink) / 0.5);
    outline-offset: -2px;
  }
  [data-kind="push"] {
    --mk: var(--b-hot);
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
    font-family: var(--b-ui);
    font-size: 11px;
    color: var(--b-t3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .lbls .today {
    color: var(--b-t1);
    font-weight: 500;
  }
  .beats {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin-top: 12px;
  }
  .bt {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 8px;
    margin: 0 -8px;
    border-radius: 6px;
    font-size: 13px;
    line-height: 1.3;
    cursor: default;
    transition: background 0.2s;
  }
  .bt:hover {
    background: rgb(var(--b-ink) / 0.045);
  }
  .mk {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--mk);
  }
  .bt.more .mk {
    background: rgb(var(--b-ink) / 0.2);
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
    font-family: var(--b-ui);
    font-size: 11px;
    color: var(--b-t3);
    white-space: nowrap;
  }
  .bt.more b {
    font-size: 11px;
    color: var(--b-t3);
  }
  .key {
    margin-top: auto;
    padding-top: 12px;
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--b-ui);
    font-size: 11px;
    line-height: 1;
    color: var(--b-t3);
    white-space: nowrap;
  }
  .key .dot {
    color: rgb(var(--b-ink) / 0.2);
  }
  .sw {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 2px;
    margin-right: 5px;
    vertical-align: -0.5px;
    background: var(--c);
  }
  .key .more {
    margin-left: auto;
    padding: 2px 7px;
    border-radius: 6px;
    border: 1px solid rgb(var(--b-ink) / 0.12);
    font-size: 11px;
    color: var(--b-t2);
    cursor: default;
  }
</style>

<script lang="ts">
  /**
   * Your week: the week's merges as one big number, the writer's sentence
   * beside it, and one slim capsule per day. Each day is a faint hatched track
   * with a solid capsule rising to its merges; the record day alone is in the
   * brand terracotta with its count in a pill above it, and today is still
   * running, so its capsule is hatched. A dotted line marks the average full
   * day; days still to come this week are empty ghost tracks. Under each
   * capsule sits a dot: the beats get a solid one you can hover (the record
   * beat in terracotta), the rest a faint pip. Sessions and meetings stay
   * quiet: one line of totals and the hover peek per day. At two rows the
   * beats also list under the chart; beats past the four dots go to a "+N
   * more" chip beside the totals. Hidden under three days of data, like
   * the picker. No other-company count.
   */
  import { peek, useBrief } from "./brief-context.svelte.js";
  import {
    arcSentence,
    averageShare,
    BEAT_STYLE,
    beatPeek,
    dayLabel,
    dayPeek,
    dayTip,
    futureDays,
    mergedAverage,
    MIN_DAYS,
    pickBeats,
    rangeLabel,
    restPeek,
    weekColumns,
    weekdayShort,
    weekMix,
    weekTotals,
  } from "./brief-week-arc.js";
  import type { BriefDay } from "./brief-types.js";

  interface Props {
    /** Up to 7 local days, oldest first (BriefInput.days). */
    days: BriefDay[];
    /** The brief's local date, YYYY-MM-DD: that column is still running. Never the machine clock. */
    today: string;
    cols: number;
    rows: number;
  }
  let { days, today, cols, rows }: Props = $props();
  const brief = useBrief();

  const shown = $derived(days.length >= MIN_DAYS);
  const sentence = $derived(arcSentence(days, today));
  const range = $derived(rangeLabel(days));
  const total = $derived(weekTotals(days).merged);
  const mix = $derived(weekMix(days));
  const columns = $derived(weekColumns(days, today));
  const ghosts = $derived(futureDays(days, today));
  const avg = $derived(mergedAverage(days, today));
  const avgShare = $derived(averageShare(days, today));
  const picked = $derived(pickBeats(days));
  const discAt = $derived(new Map(picked.shown.map((b) => [b.index, b])));
  const tall = $derived(rows > 1);
  // Two lines of beats under the chart: the tracks give up some height so the card keeps its size.
  const dense = $derived(tall && Math.ceil(picked.shown.length / (cols >= 3 ? 3 : 2)) > 1);
  // One row, three columns wide: the number and sentence sit left of the chart instead of over it.
  const side = $derived(!tall && cols >= 3);
</script>

{#if shown}
  <div class="w" class:tall class:side class:flat={!tall && !side} class:dense data-testid="brief-week-arc" data-days={days.length} data-today={today}>
    <div class="eyebrow">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 15c3 0 3-6 6-6s3 6 6 6 3-6 6-6" /></svg> Your week
    </div>
    {#if range}<span class="rng" data-testid="brief-week-range">{range}</span>{/if}

    <div class="body">
      <div class="head">
        <div class="hero" data-testid="brief-week-total" aria-label="{total} merged this week"><b>{total}</b><span>merged</span></div>
        <div class="cap">
          <h3 data-testid="brief-week-arc-title">{sentence}</h3>
          <div class="meta">
            <span class="mix" data-testid="brief-week-mix">{mix}</span>
            {#if picked.rest.length}
              <span class="more" role="group" aria-label="More turning points" data-testid="brief-week-more" use:peek={{ state: brief, content: () => restPeek(picked.rest) }}>+{picked.rest.length} more</span>
            {/if}
          </div>
        </div>
      </div>

      <div class="chart">
        <div class="cols">
          {#each columns as c, i (c.date)}
            {@const d = days[i]!}
            {@const b = discAt.get(i)}
            <div
              class="day"
              class:today={c.today}
              class:record={c.record}
              role="group"
              aria-label={dayTip(d)}
              data-testid="brief-week-day"
              data-date={c.date}
              use:peek={{ state: brief, content: () => dayPeek(d, today) }}
            >
              <div class="trk">
                {#if c.merged > 0}
                  <i class="bar" class:live={c.today} style="--share:{c.share};animation-delay:{i * 70}ms" data-testid={c.today ? "brief-week-projection" : undefined}></i>
                {:else}
                  <i class="stub" data-testid={c.today ? "brief-week-projection" : undefined}></i>
                {/if}
                {#if c.record}
                  <span class="val hot-label" style="--share:{c.share}" data-testid="brief-week-record">{c.merged} merged</span>
                {/if}
              </div>
              <span class="pin">
                {#if b}
                  <button
                    type="button"
                    class="disc"
                    style="animation-delay:{0.9 + i * 0.08}s"
                    aria-label="{BEAT_STYLE[b.kind].name} · {dayLabel(b.date)} · {b.label}"
                    data-testid="brief-week-beat"
                    data-kind={b.kind}
                    use:peek={{ state: brief, content: () => beatPeek(b) }}
                  ></button>
                {:else}
                  <i class="pip"></i>
                {/if}
              </span>
              <span class="lbl">{weekdayShort(c.date)}</span>
            </div>
          {/each}
          {#each ghosts as g (g)}
            <div class="day ghost" class:now={g === today} aria-hidden="true" data-testid="brief-week-ghost" data-date={g}>
              <div class="trk"></div>
              <span class="pin"><i class="pip"></i></span>
              <span class="lbl">{weekdayShort(g)}</span>
            </div>
          {/each}
        </div>
        {#if avgShare != null}
          <i class="avg" style="--avg:{avgShare}" title="Average {avg} merged a day" data-testid="brief-week-avg"></i>
        {/if}
      </div>
    </div>

    {#if tall && picked.shown.length}
      <div class="beats">
        {#each picked.shown as b (b.date)}
          <div class="bt" role="group" aria-label="{BEAT_STYLE[b.kind].name} · {b.label}" data-testid="brief-week-beat-row" use:peek={{ state: brief, content: () => beatPeek(b) }}>
            <i class="mk" data-kind={b.kind}></i><span>{weekdayShort(b.date)}</span><b>{b.label}</b>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Monochrome card: page ink only. The brand terracotta (--b-hot) marks the record day and nothing else. */
  .w {
    --fill: rgb(var(--b-ink) / 0.8);
    --mk: rgb(var(--b-ink) / 0.8);
    --hatch: repeating-linear-gradient(-45deg, rgb(var(--b-ink) / 0.075) 0 1px, transparent 1px 5px);
    /* Chart geometry: room above the tracks for the record pill, the track, the dot row, the label row. */
    --room: 26px;
    --trk: 84px;
    --cw: 16px;
  }
  .w.flat {
    --room: 24px;
    --trk: 46px;
    --cw: 14px;
  }
  .w.dense {
    --trk: 60px;
  }
  .w.side {
    --trk: 74px;
  }
  /* The range sits quietly in the label row, top right. */
  .rng {
    position: absolute;
    top: 18px;
    right: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 400;
    line-height: 1;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--b-t3);
    white-space: nowrap;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-height: 0;
  }
  .w.flat .body {
    gap: 8px;
  }
  .side .body {
    flex: 1;
    flex-direction: row;
    align-items: stretch;
    gap: 28px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 16px;
    min-width: 0;
  }
  .side .head {
    flex: 0 0 34%;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 10px;
  }
  /* The hero: the week's merges, large and light, with its unit small after it. */
  .hero {
    flex: none;
    display: flex;
    align-items: baseline;
    gap: 6px;
    line-height: 1;
  }
  .hero b {
    font-size: 44px;
    font-weight: 300;
    letter-spacing: -0.04em;
    font-variant-numeric: tabular-nums;
    color: var(--b-t1);
  }
  .flat .hero b {
    font-size: 36px;
  }
  .hero span {
    font-size: 13px;
    color: var(--b-t3);
  }
  .cap {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .w h3 {
    margin: 0;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.35;
    letter-spacing: -0.005em;
    color: var(--b-t1);
    overflow: hidden;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .mix,
  .more,
  .lbl,
  .bt span {
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 400;
    line-height: 1;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .mix {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--b-t3);
  }
  .meta .more {
    flex: none;
    padding: 3px 7px;
    border-radius: 999px;
    background: rgb(var(--b-ink) / 0.07);
    color: var(--b-t2);
    cursor: default;
    transition: background 0.2s;
  }
  .meta .more:hover {
    background: rgb(var(--b-ink) / 0.12);
  }

  /* The chart: one column per day, the dotted average across them. */
  .chart {
    position: relative;
    flex: 1;
    min-width: 0;
  }
  .side .chart {
    align-self: center;
  }
  .cols {
    display: flex;
  }
  .day {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding-top: var(--room);
    border-radius: 10px;
    cursor: default;
    transition: background 0.2s;
  }
  .day:not(.ghost):hover {
    background: rgb(var(--b-ink) / 0.04);
  }
  /* The track: the day's full height, a faint diagonal hatch, a capsule at its foot. */
  .trk {
    position: relative;
    width: var(--cw);
    height: var(--trk);
    border-radius: 999px;
    background: var(--hatch), rgb(var(--b-ink) / 0.03);
  }
  .ghost .trk {
    background: var(--hatch);
    opacity: 0.7;
  }
  .ghost.now .trk {
    opacity: 1;
  }
  .bar,
  .stub {
    position: absolute;
    z-index: 2;
    left: 0;
    right: 0;
    bottom: 0;
    border-radius: 999px;
  }
  .bar {
    height: max(var(--cw), calc(var(--share) * 100%));
    background: var(--fill);
    transform-origin: bottom;
    animation: grow 0.9s cubic-bezier(0.2, 0.8, 0.2, 1) both;
    transition: opacity 0.2s;
  }
  /* Today is still running: its capsule is hatched in ink, not solid. */
  .bar.live {
    background:
      repeating-linear-gradient(-45deg, rgb(var(--b-ink) / 0.55) 0 2px, rgb(var(--b-ink) / 0.14) 2px 4.5px);
  }
  .record .bar {
    background: var(--b-hot);
  }
  .record .bar.live {
    background: repeating-linear-gradient(-45deg, var(--b-hot) 0 2px, rgb(201 118 90 / 0.35) 2px 4.5px);
  }
  /* A day that merged nothing: a small round nub at the foot of its track. */
  .stub {
    height: var(--cw);
    background: rgb(var(--b-ink) / 0.14);
  }
  @keyframes grow {
    from {
      transform: scaleY(0);
    }
  }
  /* Hover a day and the others step back, so the one you are reading stands out. */
  .cols:has(.day:not(.ghost):hover) .day:not(:hover) .bar {
    opacity: 0.4;
  }
  /* The record's count, floating just above its capsule: the page's one orange label style (.hot-label). */
  .trk .val {
    position: absolute;
    z-index: 3;
    left: 50%;
    bottom: calc(max(var(--cw), var(--share) * 100%) + 6px);
    font-variant-numeric: tabular-nums;
    transform: translateX(-50%);
    animation: rise 0.4s 0.8s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translate(-50%, 4px);
    }
  }
  /* The average full day: a faint dotted rule behind the capsules. */
  .avg {
    position: absolute;
    z-index: 1;
    left: 0;
    right: 0;
    top: calc(var(--room) + var(--trk) * (1 - var(--avg)) - 1px);
    height: 2px;
    background: radial-gradient(circle, rgb(var(--b-ink) / 0.4) 0.8px, transparent 1.2px) 0 50% / 5px 2px repeat-x;
    /* Fades out at both ends, like the day timeline's rail. */
    -webkit-mask: linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent);
    mask: linear-gradient(90deg, transparent, #000 14%, #000 86%, transparent);
    pointer-events: none;
    animation: fade 0.6s 0.7s ease-out both;
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  /* The dot row: a solid dot for each beat (hover it), a faint pip for every other day. */
  .pin {
    position: relative;
    width: 16px;
    height: 16px;
    margin-top: 4px;
    display: grid;
    place-items: center;
  }
  .pip {
    display: block;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: rgb(var(--b-ink) / 0.16);
  }
  .disc {
    all: unset;
    box-sizing: border-box;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    cursor: default;
    transition: transform 0.2s;
    animation: pop 0.3s cubic-bezier(0.3, 1.6, 0.5, 1) both;
  }
  .disc::after {
    content: "";
    width: 6px;
    height: 6px;
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
  .lbl {
    margin: 2px 0 6px;
    color: var(--b-t3);
  }
  .today .lbl {
    color: var(--b-t1);
  }
  .ghost .lbl {
    color: rgb(var(--b-ink) / 0.28);
  }
  /* Today before any work: an empty track, its label in full ink. */
  .ghost.now .lbl {
    color: var(--b-t1);
  }
  .flat .lbl {
    margin-bottom: 0;
  }

  /* Two rows tall: the beats in the writer's words, two to a line. */
  .beats {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
    gap: 2px 12px;
    margin-top: 10px;
  }
  .bt {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    padding: 5px 8px;
    margin: 0 -8px;
    border-radius: 6px;
    font-size: 12px;
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
  .bt b {
    flex: 1;
    min-width: 0;
    font-weight: 400;
    color: var(--b-t2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bt span {
    flex: none;
    color: var(--b-t3);
  }
</style>

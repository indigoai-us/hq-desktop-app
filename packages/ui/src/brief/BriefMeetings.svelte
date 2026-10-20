<script lang="ts">
  /**
   * The meetings themselves: when, who, how long, and what came out. A big
   * number with a two-line caption, then one open row per meeting: its title,
   * the people it was with as overlapping initials, a small count pill of
   * what it decided, and under it a slim rail on the card's shared time axis
   * with the meeting as a capsule at its start (as long as it ran; a dot when
   * the length is unknown) and its time in mono caps under it; faint pips on
   * the rail mark the hours (the days, on a catch-up). A meeting that left you a to-do is the one
   * terracotta capsule. Rows: 5 in a two-row or three-column slot, 3 in a W or
   * S, then a "+N more" whose peek lists the rest. Only meetings you attended
   * inside the brief's window (24 hours, or since the last brief on a
   * catch-up day): a second guard behind the catalogue gate, so the card
   * renders exactly what measure() counted. Each row's peek adds the
   * meeting's signals and length.
   *
   * When the Settled card is on the board (`settled`), the decisions are its
   * job: the number counts meetings and each row says how many it decided.
   * Alone, the card carries them: the number counts decisions and each row
   * shows its first one under the title.
   */
  import { peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import {
    capsuleLabel,
    capsuleOf,
    initials,
    lengthText,
    meetingAxis,
    meetingLabel,
    meetingPeople,
    meetingsFooter,
    meetingsLimit,
    meetingsMinutes,
    meetingsShown,
    signalsText,
  } from "./brief-meetings.js";
  import { meetingPeek } from "./brief-peeks.js";
  import { clockLabel } from "./brief-time.js";
  import { countUp } from "./count-up.js";
  import type { BriefDay, BriefMeeting } from "./brief-types.js";

  interface Props {
    meetings: BriefMeeting[];
    rows: number;
    /** Columns of the slot: a W3 (3 wide, one row) shows 5 rows like an M; W and S show 3. */
    cols?: number;
    /** ISO time the brief is for; with it, meetings older than the window are dropped. Null: the catalogue gate alone. */
    now?: string | null;
    /** Start of a widened window (a catch-up day's last brief), as the catalogue uses it. */
    windowFrom?: string | null;
    /** The sweep's days, for the day-over-day line. */
    days?: BriefDay[];
    /** YYYY-MM-DD of the brief, to find yesterday and the day before in `days`. */
    today?: string | null;
    /** The Settled card is on the board: it lists the decisions, so this card does not repeat them. */
    settled?: boolean;
  }
  let { meetings, rows, cols = 2, now = null, windowFrom = null, days = [], today = null, settled = false }: Props = $props();
  const brief = useBrief();
  const all = $derived(meetingsShown(meetings, now, windowFrom));
  const decisions = $derived(all.reduce((n, m) => n + m.decisions, 0));
  const shown = $derived(all.slice(0, meetingsLimit(rows, cols)));
  const rest = $derived(all.slice(shown.length));
  const away = $derived.by(() => {
    if (!now || !windowFrom) return false;
    const span = Date.parse(now) - Date.parse(windowFrom);
    return Number.isFinite(span) && span > 36 * 3_600_000;
  });
  const foot = $derived(meetingsFooter(days, today, away));
  const narrow = $derived(cols <= 1);
  const side = $derived(cols >= 3 && rows <= 1);
  /** Two rows tall and two wide: each meeting gets its title line and a rail under it with the time. One-row slots keep each meeting to one line. */
  const tall = $derived(rows > 1 && !narrow);
  /** Room for the initials: two rows tall, or three wide. The "for you" pill needs two rows; elsewhere the terracotta capsule says it. */
  const roomy = $derived(tall || side);
  const axis = $derived(meetingAxis(shown, narrow ? 3 : side ? 6 : 5));
  /** Decisions lead only when this card is the one carrying them. */
  const leadDecisions = $derived(!settled && decisions > 0);
  const minutes = $derived(meetingsMinutes(all));
  const when = $derived(away ? "while you were away" : "since yesterday");

  /** The shared meeting peek, plus the signals it left and how long it ran. */
  function content(m: BriefMeeting): PeekContent {
    const base = meetingPeek(m);
    const sections = [...base.sections];
    const signals = signalsText(m);
    const length = lengthText(m.durationMin);
    if (signals) sections.push({ label: "Signals", text: signals });
    if (length) sections.push({ label: "Length", text: length });
    const at = clockLabel(m.startTime);
    return {
      ...base,
      sections,
      eyebrow: at ? `Meeting · ${at}` : "Meeting",
      origin: m.companyUid ? { companyUid: m.companyUid, label: "meetings" } : undefined,
    };
  }

  const morePeek = (): PeekContent => ({
    title: `${rest.length} more`,
    status: "Also since yesterday",
    sections: [
      {
        label: "Meetings",
        lines: rest.map((m) => ({ label: meetingLabel(m), state: m.decisions ? `${m.decisions} decided` : clockLabel(m.startTime) })),
      },
    ],
  });

  const weekdayOf = (iso: string) => capsuleLabel({ startTime: iso }, true).split(" ")[0] ?? "";
  const mineCount = (m: BriefMeeting) => (m.todo ?? []).filter((t) => t.mine).length;
</script>

<div class="w" class:narrow class:side class:tall class:line={!tall && !narrow} class:days={axis?.days} data-testid="brief-meetings">
  <div class="eyebrow">
    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14" rx="3" /><path d="M4 10h16M9 3.5v4M15 3.5v4" /></svg> Yesterday
  </div>
  <div class="body">
    <div class="hd">
      <span class="num" use:countUp={leadDecisions ? decisions : all.length}>0</span>
      <div class="cap">
        <span class="what" data-testid="brief-meetings-sub"
          >{leadDecisions
            ? `decision${decisions === 1 ? "" : "s"} from ${all.length} meeting${all.length === 1 ? "" : "s"}`
            : `${all.length === 1 ? "meeting" : "meetings"} ${when}`}</span
        >
        {#if minutes || (rows > 1 && foot)}
          <span class="vs">
            {#if minutes}<span>{lengthText(minutes)} in meetings</span>{/if}
            {#if rows > 1 && foot}<span data-testid="brief-meetings-foot">{foot}</span>{/if}
          </span>
        {/if}
      </div>
    </div>

    <div class="lanes">
      {#each shown as m (m.id)}
        {@const first = settled ? undefined : m.decided?.[0]}
        {@const people = meetingPeople(m)}
        {@const mine = mineCount(m)}
        {@const c = axis ? capsuleOf(m, axis) : null}
        {@const flip = !!c && c.left + (c.width ?? 0) > (narrow ? 0.4 : 0.62)}
        <div
          class="mtg"
          class:yours={mine > 0}
          role="group"
          aria-label={m.title}
          data-testid="brief-meeting-row"
          use:peek={{ state: brief, content: () => content(m) }}
        >
          {#if !tall}<span class="t0">{narrow && axis?.days ? weekdayOf(m.startTime) : capsuleLabel({ startTime: m.startTime }, axis?.days ?? false)}</span>{/if}
          <div class="mt">
            <span class="tt">{m.title}</span>
            {#if first}<span class="first" data-testid="brief-meeting-first">{first}</span>{/if}
          </div>
          <div class="end">
            {#if people.length && roomy}
              <span class="ppl" role="img" aria-label="With {people.join(', ')}">
                {#each people.slice(0, 3) as p (p)}<i>{initials(p).slice(0, 1)}</i>{/each}
                {#if people.length > 3}<i class="n">+{people.length - 3}</i>{/if}
              </span>
            {/if}
            {#if mine && tall}<span class="tag hot" data-testid="brief-meeting-yours">{mine} for you</span>{/if}
            <!-- The decision count, only when the first decision under the title doesn't already say it. -->
            {#if m.decisions > (first ? 1 : 0)}<span class="tag" data-testid="brief-meeting-decided">{m.decisions} decided</span>{/if}
          </div>
          {#if c && axis}
            <div class="lane" aria-hidden="true">
              {#each axis.ticks as t, i (i)}{#if t.at > 0.001 && t.at < 0.999}<i class="pip" style:--a={t.at}></i>{/if}{/each}
              <span
                class="mark"
                class:flip
                style:--l={c.left}
                style:--wd={c.width ?? 0}
                style:--r={1 - c.left - (c.width ?? 0)}
              >
                <span class="cap-s" class:dot={c.width == null}></span>
                {#if tall}<span class="at" data-testid="brief-meeting-at">{capsuleLabel(m, axis.days)}</span>{/if}
              </span>
            </div>
          {/if}
        </div>
      {/each}
      {#if rest.length}
        <div class="more" role="button" tabindex="0" data-testid="brief-meetings-more" use:peek={{ state: brief, content: morePeek }}>+{rest.length} more</div>
      {/if}
    </div>

  </div>
</div>

<style>
  /* Monochrome card: page ink only. The brand terracotta marks a meeting that left you a to-do, and nothing else. */
  .w {
    --ink-cap: rgb(var(--b-ink) / 0.78);
    --rail: rgb(var(--b-ink) / 0.09);
  }
  .body {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  /* The hero: the number large and light, its caption in two short lines beside it. */
  .hd {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
    margin: 0 0 18px;
  }
  .num {
    flex: none;
    font-size: 44px;
    font-weight: 300;
    letter-spacing: -0.04em;
    line-height: 1;
    font-variant-numeric: tabular-nums;
    color: var(--b-t1);
  }
  .cap {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .what {
    font-size: 13px;
    font-weight: 500;
    line-height: 1.3;
    color: var(--b-t1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .vs {
    display: flex;
    flex-wrap: wrap;
    gap: 0 6px;
    font-size: 12px;
    line-height: 1.35;
    color: var(--b-t3);
  }
  .vs > span + span::before {
    content: "·";
    margin-right: 6px;
  }

  /* One open row per meeting: the title line, then its rail. */
  /* The rows share out the card's height, so a short day spreads like a chart instead of leaving a hole. */
  .lanes {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: space-evenly;
    gap: 4px;
    min-height: 0;
  }
  /* A meeting: its title and what came out on one line, its rail under it (two rows tall), or all on one line (one row). */
  .mtg {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      "mt end"
      "lane lane";
    align-items: center;
    column-gap: 10px;
    row-gap: 7px;
    min-width: 0;
    padding: 7px 8px 8px;
    margin: 0 -8px;
    border-radius: 8px;
    cursor: default;
    transition: background 0.2s;
  }
  /* A catch-up's times carry the weekday. */
  .line.days {
    --t0: 70px;
  }
  .narrow.days {
    --t0: 34px;
  }
  .line .mtg {
    grid-template-columns: var(--t0, 52px) minmax(96px, 1fr) minmax(48px, 28%) auto;
    grid-template-areas: "t0 mt lane end";
    padding: 6px 8px;
  }
  .narrow .mtg {
    grid-template-columns: var(--t0, 48px) minmax(0, 1fr) auto;
    grid-template-areas:
      "t0 mt mt"
      "lane lane end";
    row-gap: 6px;
    padding: 6px 8px 7px;
  }
  .mtg:hover,
  .mtg:focus-visible {
    background: rgb(var(--b-ink) / 0.045);
    outline: none;
  }
  .t0 {
    grid-area: t0;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 400;
    line-height: 1;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
    color: var(--b-t3);
  }
  .mt {
    grid-area: mt;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .end {
    grid-area: end;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    min-width: 0;
  }
  .end:empty {
    display: none;
  }
  .tt {
    min-width: 0;
    font-size: 13px;
    font-weight: 500;
    line-height: 18px;
    color: var(--b-t1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .first {
    font-size: 12px;
    line-height: 1.3;
    color: var(--b-t3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Who: overlapping round initials. Each circle is cut where the next one sits, so they overlap without a rim. */
  .ppl {
    flex: none;
    display: flex;
    align-items: center;
  }
  .ppl i {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-family: var(--b-code);
    font-style: normal;
    font-size: 10px;
    font-weight: 500;
    line-height: 1;
    letter-spacing: 0.08em;
    text-indent: 0.08em;
    text-transform: uppercase;
    color: var(--b-t2);
    background: rgb(var(--b-ink) / 0.09);
  }
  .ppl i + i {
    margin-left: -5px;
  }
  .ppl i:not(:last-child) {
    -webkit-mask: radial-gradient(circle at calc(100% + 5px) 50%, transparent 11.5px, #000 12px);
    mask: radial-gradient(circle at calc(100% + 5px) 50%, transparent 11.5px, #000 12px);
  }
  .ppl i.n {
    letter-spacing: 0;
    color: var(--b-t3);
  }

  /* What came out: a small mono pill. */
  .tag {
    flex: none;
    padding: 4px 7px;
    border-radius: 999px;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 400;
    line-height: 1;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
    color: var(--b-t2);
    background: rgb(var(--b-ink) / 0.07);
  }
  .tag.hot {
    color: var(--b-hot);
    background: rgb(201 118 90 / 0.13);
  }

  /* The rail: the card's time axis, the meeting a slim capsule on it with its time under it. */
  .lane {
    grid-area: lane;
    position: relative;
    height: 24px;
    container-type: inline-size;
  }
  .line .lane,
  .narrow .lane {
    height: 8px;
  }
  .lane::before {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    top: 3px;
    height: 2px;
    border-radius: 1px;
    background: var(--rail);
  }
  /* The axis's hours (or days, on a catch-up) as faint pips on the rail: the scale without a label row. */
  .pip {
    position: absolute;
    top: 2.5px;
    left: calc(var(--a) * 100%);
    width: 3px;
    height: 3px;
    margin-left: -1.5px;
    border-radius: 50%;
    background: rgb(var(--b-ink) / 0.22);
  }
  .mark {
    position: absolute;
    top: 0;
    left: calc(var(--l) * 100%);
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  /* Late in the day the time hangs from the capsule's end, so it stays on the card. */
  .mark.flip {
    left: auto;
    right: calc(var(--r) * 100%);
    align-items: flex-end;
  }
  .cap-s {
    flex: none;
    width: max(16px, calc(var(--wd) * 100cqw));
    height: 8px;
    border-radius: 999px;
    background: var(--ink-cap);
    transform-origin: left;
    animation: grow 0.8s cubic-bezier(0.2, 0.8, 0.2, 1) both;
    transition: opacity 0.2s;
  }
  .flip .cap-s {
    transform-origin: right;
  }
  .cap-s.dot {
    width: 8px;
  }
  .yours .cap-s {
    background: var(--b-hot);
  }
  @keyframes grow {
    from {
      transform: scaleX(0);
    }
  }
  .at,
  .more {
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 400;
    line-height: 1;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .at {
    color: var(--b-t3);
  }
  /* Hover a meeting and the others step back, so the one you are reading stands out on the axis. */
  .lanes:has(.mtg:hover) .mtg:not(:hover) .cap-s {
    opacity: 0.35;
  }
  .mtg:hover .at {
    color: var(--b-t2);
  }

  /* "+N more": mono caps, its pill shows on hover. */
  .more {
    align-self: flex-start;
    margin: 4px 0 0 -7px;
    padding: 5px 7px;
    border-radius: 999px;
    color: var(--b-t3);
    cursor: default;
    transition:
      background 0.2s,
      color 0.2s;
  }
  .more:hover,
  .more:focus-visible {
    background: rgb(var(--b-ink) / 0.07);
    color: var(--b-t1);
    outline: none;
  }

  /* A three-column, one-row slot: the hero on the left, the meetings on the right. */
  .side .body {
    display: grid;
    grid-template-columns: minmax(0, 30%) minmax(0, 1fr);
    column-gap: 28px;
  }
  .side .hd {
    grid-row: 1 / span 2;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 10px;
    margin: 0;
  }
  .side .what {
    white-space: normal;
  }
  .side .lanes {
    grid-column: 2;
  }

  /* One column: no initials or "for you" pill (the terracotta capsule says it); the count sits at the end of the rail, so the title keeps the width. */
  .narrow .hd {
    gap: 10px;
  }
  .narrow .num {
    font-size: 36px;
  }
  .narrow .what {
    white-space: normal;
  }
</style>

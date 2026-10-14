<script lang="ts">
  /**
   * Yesterday's meetings and how many signals each left behind. Rows: 5 in a
   * two-row or three-column slot, 3 in a W or S, then a "+N more" row whose
   * peek lists the rest. The card shows only meetings you attended inside the
   * brief's window (24 hours, or since the last brief on a catch-up day): a
   * second guard behind the catalogue gate, so the card renders exactly what
   * measure() counted. Each row's peek adds the meeting's signals and length;
   * a two-row card ends with "N meetings · M the day before".
   */
  import { peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import { lengthText, meetingLabel, meetingsFooter, meetingsLimit, meetingsShown, signalsText } from "./brief-meetings.js";
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
    /** The sweep's days, for the footer's day-over-day count. */
    days?: BriefDay[];
    /** YYYY-MM-DD of the brief, to find yesterday and the day before in `days`. */
    today?: string | null;
  }
  let { meetings, rows, cols = 2, now = null, windowFrom = null, days = [], today = null }: Props = $props();
  const brief = useBrief();
  const all = $derived(meetingsShown(meetings, now, windowFrom));
  const decisions = $derived(all.reduce((n, m) => n + m.decisions, 0));
  const shown = $derived(all.slice(0, meetingsLimit(rows, cols)));
  const rest = $derived(all.slice(shown.length));
  const foot = $derived(meetingsFooter(days, today));

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
</script>

<div class="w" data-testid="brief-meetings">
  <div class="eyebrow">
    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14" rx="3" /><path d="M4 10h16M9 3.5v4M15 3.5v4" /></svg> Yesterday
  </div>
  <div class="hd">
    <span class="big" use:countUp={decisions || all.length}>0</span>
    <span class="sub" data-testid="brief-meetings-sub"
      >{decisions
        ? `decision${decisions === 1 ? "" : "s"} from ${all.length} meeting${all.length === 1 ? "" : "s"}`
        : all.length === 1
          ? "meeting"
          : "meetings"}</span
    >
  </div>
  <div class="list" class:footed={rows > 1 && !!foot}>
    {#each shown as m (m.id)}
      {@const first = m.decided?.[0]}
      <div
        class="row"
        role="group"
        aria-label={m.title}
        data-testid="brief-meeting-row"
        use:peek={{ state: brief, content: () => content(m) }}
      >
        <div class="mt">
          <div class="tt">{m.title} {#if m.with}<em>{m.with}</em>{/if}</div>
          {#if first}<div class="first" data-testid="brief-meeting-first">{first}</div>{/if}
        </div>
        <!-- The decision count, only when the first decision under the title doesn't already say it. -->
        {#if m.decisions > (first ? 1 : 0)}<span class="dec" data-testid="brief-meeting-decided">{m.decisions} decided</span>{/if}
      </div>
    {/each}
    {#if rest.length}
      <div class="row more" role="button" tabindex="0" data-testid="brief-meetings-more" use:peek={{ state: brief, content: morePeek }}>+{rest.length} more</div>
    {/if}
  </div>
  {#if rows > 1 && foot}
    <div class="foot" data-testid="brief-meetings-foot"><span>{foot}</span></div>
  {/if}
</div>

<style>
  /* The count, calmly: the number, then its caption on one line beside it. */
  .hd {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    margin: 2px 0 10px;
  }
  .hd .big {
    flex: none;
    font-size: 32px;
    font-weight: 400;
    letter-spacing: -0.03em;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  .hd .sub {
    min-width: 0;
    font-size: 12px;
    line-height: 1.3;
    color: rgb(var(--b-ink) / 0.7);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 0;
  }
  /* Air between the last row and the footer's hairline. */
  .list.footed {
    margin-bottom: 12px;
  }
  /* Glass rows: the meeting, its first decision under it, the count at the end when there is more. */
  .list > .row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    margin: 0;
    padding: 8px 10px;
    border-radius: 10px;
    font-size: var(--b-row-fs, 13px);
    line-height: 1.3;
    background: var(--b-row-bg, rgb(var(--b-ink) / 0.12));
    border: 0;
    transition: background 0.2s;
  }
  .list > .row:hover,
  .list > .row:focus-visible {
    background: var(--b-row-hover, rgb(var(--b-ink) / 0.2));
    outline: none;
  }
  .mt {
    min-width: 0;
    flex: 1;
  }
  .tt {
    font-weight: 500;
    line-height: 1.25;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tt em {
    font-style: normal;
    font-weight: 400;
    color: rgb(var(--b-ink) / 0.7);
  }
  .first {
    margin-top: 1px;
    font-size: 11px;
    line-height: 1.3;
    color: var(--b-t3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dec {
    flex: none;
    margin-left: auto;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: rgb(var(--b-ink) / 0.7);
    white-space: nowrap;
  }
  /* "+N more": a plain glass row, no rim. */
  .list > .more {
    justify-content: center;
    padding: 6px 10px;
    font-size: 12px;
    color: rgb(var(--b-ink) / 0.7);
    cursor: default;
  }
</style>

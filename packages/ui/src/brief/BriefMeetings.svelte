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
  {#each shown as m (m.id)}
    <div
      class="row"
      role="group"
      aria-label={m.title}
      data-testid="brief-meeting-row"
      use:peek={{ state: brief, content: () => content(m) }}
    >
      <span class="bul" style="background:var(--b-ice)"></span>
      <div class="mt">
        <div class="tt">{m.title} {#if m.with}<em>{m.with}</em>{/if}</div>
        {#if m.decided?.[0]}<div class="first" data-testid="brief-meeting-first">{m.decided[0]}</div>{/if}
      </div>
      {#if m.decisions}<span class="dd" aria-hidden="true">{#each Array.from({ length: Math.min(3, m.decisions) }, (_, i) => i) as i (i)}<i></i>{/each}</span>{/if}
    </div>
  {/each}
  {#if rest.length}
    <div class="row more" role="button" tabindex="0" data-testid="brief-meetings-more" use:peek={{ state: brief, content: morePeek }}>+{rest.length} more</div>
  {/if}
  {#if rows > 1 && foot}
    <div class="foot" data-testid="brief-meetings-foot"><span>{foot}</span></div>
  {/if}
</div>

<style>
  .hd {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-top: 6px;
  }
  .row {
    padding: 2px 6px;
    margin-left: -6px;
    margin-right: -6px;
    border-radius: 10px;
    transition: background 0.25s;
  }
  .row:hover {
    background: rgba(255, 255, 255, 0.045);
  }
  .mt {
    min-width: 0;
    flex: 1;
  }
  .tt {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .first {
    margin-top: 1px;
    font-size: 11.5px;
    color: var(--b-t3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dd {
    margin-left: auto;
    display: flex;
    gap: 3px;
    align-self: center;
    flex: none;
  }
  .dd i {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--b-ice);
    opacity: 0.8;
  }
  /* "+N more": a flat glass row, lit from the top. No inner shadow. */
  .more {
    justify-content: center;
    margin-top: 10px;
    margin-left: 0;
    margin-right: 0;
    padding: 4px 10px;
    font-size: 12px;
    color: var(--b-t2);
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.08);
    cursor: default;
  }
  .more:hover,
  .more:focus-visible {
    background: rgba(255, 255, 255, 0.09);
    outline: none;
  }
</style>

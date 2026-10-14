<script lang="ts">
  /**
   * What got settled: the decisions made in meetings you attended inside the
   * brief's window, grouped under the meeting they came from. The count leads
   * as a big light number with the title beside it; each meeting is named
   * once, in mono caps with its time (the weekday too on a catch-up that
   * spans days; its company's logo when the
   * decisions come from more than one company), and its decisions sit under
   * it as open rows with a quiet ink tick. Each row is one plain line (90
   * characters, cut on a word); its peek carries the full text, the meeting
   * and time, and a "Follow up" prompt that drafts and never sends. Five rows
   * at most (three in a one-row slot), then "+N more" whose peek lists the
   * rest. Hidden below three lines, the picker's gate.
   */
  import BriefLogo from "./BriefLogo.svelte";
  import { peek, useBrief } from "./brief-context.svelte.js";
  import { AWAY_MS, DAY_MS, DECIDED_MIN, decidedRows, groupByMeeting, headingWhen, meetingLabel, morePeek, rowPeek, settledTitle, spansDays, whenLabel } from "./brief-decided.js";
  import { clockLabel } from "./brief-time.js";
  import type { BriefMeeting } from "./brief-types.js";

  interface Props {
    meetings: BriefMeeting[];
    /** ISO time the brief is for; the window is the 24 hours before it unless `windowFrom` says otherwise. */
    now: string;
    rows: number;
    /** Start of the picker's window (ms, `ctx.windowFrom`), so the card and the picker count the same meetings. */
    windowFrom?: number | null;
    /** The owner's name: a decision that names them is theirs, not "without you". */
    userName?: string | null;
  }

  let { meetings, now, rows, windowFrom = null, userName = null }: Props = $props();
  const brief = useBrief();
  const from = $derived(windowFrom ?? Date.parse(now) - DAY_MS);
  const all = $derived(decidedRows(meetings, from, userName));
  // At most five rows in a list (three in a one-row slot); "+N more" opens the rest in the peek.
  const shown = $derived(all.slice(0, rows > 1 ? 5 : 3));
  const rest = $derived(all.slice(shown.length));
  const groups = $derived(groupByMeeting(shown));
  const away = $derived(Date.parse(now) - from > AWAY_MS);
  const title = $derived(settledTitle(all.length, { mine: all.some((r) => r.mine), away }));
  /** On a catch-up the headings carry the weekday, when the meetings fall on different days. */
  const withDay = $derived(away && spansDays(all));
  /** The logo tells meetings apart only when the decisions come from more than one company. */
  const logos = $derived(new Set(all.map((r) => r.meeting.companyUid ?? "")).size > 1);
</script>

{#if all.length >= DECIDED_MIN}
  <div class="w" data-testid="brief-decided">
    <div class="eyebrow">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7" /></svg> What got settled
    </div>
    <h3 class="hd" data-testid="brief-decided-title"><span class="num">{all.length}</span>{" "}<span class="cap">{title.replace(/^\d+\s+/, "")}</span></h3>
    <div class="log">
      {#each groups as g (g.meeting.id)}
        <div class="grp" role="group" aria-label={meetingLabel(g.meeting.title)} data-testid="brief-decided-group">
          <div class="src" data-testid="brief-decided-src">
            {#if logos && g.meeting.companyUid}<BriefLogo company={brief.company(g.meeting.companyUid)} fallback={g.meeting.companyUid} size={14} />{/if}
            <span data-testid="brief-decided-src-text">{meetingLabel(g.meeting.title)} · {headingWhen(g.meeting.startTime, withDay)}</span>
          </div>
          {#each g.rows as r (r.id)}
            <div
              class="r"
              role="group"
              aria-label={r.text}
              data-testid="brief-decided-row"
              use:peek={{ state: brief, content: () => rowPeek(r, whenLabel(r.meeting.startTime)) }}
            >
              <svg class="tick" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7" /></svg>
              <div class="ln" data-testid="brief-decided-line">{r.line}</div>
            </div>
          {/each}
        </div>
      {/each}
      {#if rest.length}
        <div class="more" role="button" tabindex="0" data-testid="brief-decided-more" use:peek={{ state: brief, content: () => morePeek(rest, clockLabel) }}>
          +{rest.length} more
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  /* Monochrome card: page ink only, no accent. The decisions are settled news, not calls to make. */
  .w h3.hd {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
    margin: 0 0 18px;
    font-size: 13px;
    font-weight: 500;
    letter-spacing: 0;
    line-height: 1.3;
    color: var(--b-t1);
  }
  .num {
    flex: none;
    font-size: 44px;
    font-weight: 300;
    letter-spacing: -0.04em;
    line-height: 1;
    font-variant-numeric: tabular-nums;
  }
  /* The rest of the title, in up to two short lines beside the number. */
  .cap {
    min-width: 0;
    max-width: 22ch;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
  /* One column of groups; a wide card sets them side by side. */
  .log {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(260px, 100%), 1fr));
    align-content: start;
    align-items: start;
    gap: 12px 28px;
    min-height: 0;
  }
  .grp {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  /* The meeting, named once: mono caps, its time after it. */
  .src {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    margin-bottom: 3px;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 400;
    line-height: 14px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--b-t3);
  }
  .src span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .r {
    display: flex;
    gap: 9px;
    align-items: flex-start;
    padding: 4px 8px;
    margin: 0 -8px;
    border-radius: 6px;
    font-size: 13px;
    line-height: 1.35;
    color: var(--b-t1);
    cursor: default;
    transition: background 0.2s;
  }
  .r:hover,
  .r:focus-visible {
    background: rgb(var(--b-ink) / 0.045);
    outline: none;
  }
  /* A quiet ink tick: settled, nothing to do. */
  .tick {
    flex: none;
    width: 12px;
    height: 12px;
    margin-top: 3px;
    stroke: rgb(var(--b-ink) / 0.45);
    fill: none;
    stroke-width: 2.2;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: stroke 0.2s;
  }
  .r:hover .tick {
    stroke: var(--b-t1);
  }
  /* Two lines of the decision before the ellipsis; the full text is in the peek. */
  .ln {
    flex: 1;
    min-width: 0;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  /* "+N more": mono caps, its pill shows on hover. */
  .more {
    grid-column: 1 / -1;
    justify-self: start;
    margin: -4px 0 0 -7px;
    padding: 5px 7px;
    border-radius: 999px;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 400;
    line-height: 1;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
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
</style>

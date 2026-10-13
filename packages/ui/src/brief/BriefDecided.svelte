<script lang="ts">
  /**
   * What got settled: the decisions made in meetings you attended inside the
   * brief's window, as the mockup's violet-tick log. Each row is one plain
   * line (90 characters, cut on a word) over a mono source "Call with Jordan ·
   * 2 PM" with the company's logo; its peek carries the full text, the
   * meeting and time, and a "Follow up" prompt that drafts and never sends.
   * Five rows at most (three in a one-row slot), then "+N more" whose peek
   * lists the rest. Hidden below three lines, the picker's gate.
   */
  import BriefLogo from "./BriefLogo.svelte";
  import { peek, useBrief } from "./brief-context.svelte.js";
  import { AWAY_MS, DAY_MS, DECIDED_MIN, decidedRows, meetingLabel, morePeek, rowPeek, settledTitle, whenLabel } from "./brief-decided.js";
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
  const meetingCount = $derived(new Set(all.map((r) => r.meeting.id)).size);
  const away = $derived(Date.parse(now) - from > AWAY_MS);
  const title = $derived(settledTitle(all.length, { mine: all.some((r) => r.mine), away }));
</script>

{#if all.length >= DECIDED_MIN}
  <div class="w" data-testid="brief-decided">
    <div class="eyebrow" style="color:var(--b-decision)">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7" /></svg> What got settled
    </div>
    <h3 data-testid="brief-decided-title">{title}</h3>
    <div class="log">
      {#each shown as r (r.id)}
        <div
          class="r"
          role="group"
          aria-label={r.text}
          data-testid="brief-decided-row"
          use:peek={{ state: brief, content: () => rowPeek(r, whenLabel(r.meeting.startTime)) }}
        >
          <svg class="tick" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7" /></svg>
          <div class="tx">
            <div class="ln" data-testid="brief-decided-line">{r.line}</div>
            <div class="src" data-testid="brief-decided-src">
              {#if r.meeting.companyUid}<BriefLogo company={brief.company(r.meeting.companyUid)} fallback={r.meeting.companyUid} size={14} />{/if}
              <span data-testid="brief-decided-src-text">{meetingLabel(r.meeting.title)} · {clockLabel(r.meeting.startTime)}</span>
            </div>
          </div>
        </div>
      {/each}
      {#if rest.length}
        <div class="r more" role="button" tabindex="0" data-testid="brief-decided-more" use:peek={{ state: brief, content: () => morePeek(rest, clockLabel) }}>
          +{rest.length} more
        </div>
      {/if}
    </div>
    {#if rows > 1}
      <div class="foot"><span>{all.length} settled</span><span>{meetingCount} meeting{meetingCount === 1 ? "" : "s"}</span></div>
    {/if}
  </div>
{/if}

<style>
  .log {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 12px;
    min-height: 0;
  }
  .r {
    display: flex;
    gap: 9px;
    align-items: flex-start;
    padding: 5px 8px;
    margin: 0 -8px;
    border-radius: 6px;
    font-size: 13px;
    line-height: 1.3;
    transition: background 0.25s;
  }
  .r:hover,
  .r:focus-visible {
    background: rgb(var(--b-ink) / 0.045);
    outline: none;
  }
  /* The mockup's 14 px violet tick: settled, not pending. */
  .tick {
    flex: none;
    width: 14px;
    height: 14px;
    margin-top: 1px;
    stroke: var(--b-decision);
    fill: none;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .tx {
    flex: 1;
    min-width: 0;
  }
  /* Two lines of the decision before the ellipsis; the full text is in the peek. */
  .ln {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .src {
    margin-top: 2px;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-family: var(--b-mono);
    font-size: 11px;
    letter-spacing: 0;
    color: var(--b-t3);
  }
  .src span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .more {
    justify-content: center;
    padding: 4px 8px;
    color: var(--b-t2);
    cursor: default;
  }
</style>

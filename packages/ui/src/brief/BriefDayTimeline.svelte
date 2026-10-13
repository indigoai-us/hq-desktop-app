<script lang="ts" module>
  import type { BriefCalendarEvent } from "./brief-types.js";

  export type StepState = "done" | "now" | "next" | "later";
  export interface Step {
    e: BriefCalendarEvent;
    state: StepState;
  }

  /**
   * Today's calls as steps, after the reference's vertical progress list:
   * up to two finished calls for context, the call in progress (or the next
   * one) as the active step, then what follows, five rows at most. Busy holds
   * are left out. `hidden` counts the calls that did not fit.
   */
  export function daySteps(events: readonly BriefCalendarEvent[], nowIso: string, max = 5): { steps: Step[]; hidden: BriefCalendarEvent[] } {
    const now = Date.parse(nowIso);
    const calls = events.filter((e) => !e.busy && Number.isFinite(Date.parse(e.start))).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const endOf = (e: BriefCalendarEvent) => (e.end ? Date.parse(e.end) : Date.parse(e.start) + 30 * 60_000);
    const past = calls.filter((e) => endOf(e) <= now);
    const open = calls.filter((e) => endOf(e) > now);
    const ahead = open.length ? Math.min(open.length, max - Math.min(2, past.length)) : 0;
    const keepPast = Math.min(past.length, max - ahead);
    const shownPast = past.slice(past.length - keepPast);
    const shownOpen = open.slice(0, ahead);
    const steps: Step[] = [
      ...shownPast.map((e) => ({ e, state: "done" as const })),
      ...shownOpen.map((e, i) => ({ e, state: (i === 0 ? (Date.parse(e.start) <= now ? "now" : "next") : "later") as StepState })),
    ];
    const shown = new Set(steps.map((s) => s.e));
    return { steps, hidden: calls.filter((e) => !shown.has(e)) };
  }

  export const STATE_LABEL: Record<StepState, string> = { done: "Done", now: "Now", next: "Next", later: "Later" };
</script>

<script lang="ts">
  /**
   * Today, in the top centre: a dotted rail with one row per call and its state
   * on the right (Done, Now or Next, Later). The active call is dark and carries
   * a marker; finished calls fade. Hover a row for the call's peek; "+N more"
   * lists the rest.
   */
  import { peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import { rangeText } from "./brief-strip.js";

  let {
    events,
    now,
    sample = false,
    onopenmeetings,
  }: { events: BriefCalendarEvent[]; now: string; sample?: boolean; onopenmeetings?: () => void } = $props();
  const brief = useBrief();
  const plan = $derived(daySteps(events, now));
  const named = $derived(events.filter((e) => !e.busy).length);
  const at = (e: BriefCalendarEvent) => {
    const d = new Date(e.start);
    const m = d.getMinutes();
    return `${d.getHours() % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${d.getHours() >= 12 ? "PM" : "AM"}`;
  };

  function content(e: BriefCalendarEvent): PeekContent {
    const sections: PeekContent["sections"] = [];
    if (e.attendees?.length) sections.push({ label: "With", lines: e.attendees.slice(0, 5).map((a) => ({ label: a, state: "" })) });
    if (e.joinUrl) sections.push({ label: "Join", text: e.joinUrl });
    return {
      sample: sample || e.projected,
      title: e.title,
      status: `${rangeText(e)}${e.tentative ? " · Maybe" : ""}`,
      sections,
      actions: onopenmeetings ? [{ label: "Open in Meetings", run: onopenmeetings, testid: "brief-strip-open-meetings" }] : [],
    };
  }
  function moreContent(): PeekContent {
    return {
      title: `${plan.hidden.length} more`,
      sections: [{ label: "Also today", lines: plan.hidden.map((e) => ({ label: e.title, state: rangeText(e) })) }],
      actions: onopenmeetings ? [{ label: "Open in Meetings", run: onopenmeetings }] : [],
    };
  }
</script>

<section class="day" data-testid="brief-today" aria-label="Today's calls">
  <div class="hd">
    <span>Today</span>
    <span class="ct">{named ? `${named} call${named === 1 ? "" : "s"}` : "No calls"}</span>
  </div>
  {#if plan.steps.length}
    <ol>
      {#each plan.steps as s (s.e.id)}
        <li
          class={s.state}
          class:tent={s.e.tentative}
          aria-label="{s.e.title}, {rangeText(s.e)}, {STATE_LABEL[s.state]}"
          data-testid="brief-day-step"
          data-state={s.state}
          use:peek={{ state: brief, content: () => content(s.e) }}
        >
          <span class="pt" aria-hidden="true"></span>
          <span class="tt">{s.e.title}</span>
          <span class="tm">{at(s.e)}{s.e.tentative ? " · Maybe" : ""}</span>
          <span class="st">{STATE_LABEL[s.state]}</span>
          {#if s.state === "now" || s.state === "next"}<span class="mk" aria-hidden="true"></span>{/if}
        </li>
      {/each}
    </ol>
    {#if plan.hidden.length}
      <div class="more" role="button" tabindex="0" data-testid="brief-strip-more" use:peek={{ state: brief, content: moreContent }}>+{plan.hidden.length} more</div>
    {/if}
  {:else}
    <p class="empty">Nothing on the calendar. A clear run at the work.</p>
  {/if}
</section>

<style>
  .day {
    min-width: 0;
    display: flex;
    flex-direction: column;
    padding: 2px 0 0;
  }
  /* Right edge matches the state pills below (rows keep 8px of padding). */
  .hd {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-right: 8px;
    font-size: 13px;
    font-weight: 500;
    color: var(--b-t2);
  }
  .ct {
    margin-left: auto;
    font-size: 11px;
    font-weight: 400;
    color: var(--b-t3);
  }
  ol {
    position: relative;
    list-style: none;
    margin: 10px 0 0;
    padding: 0 0 0 18px;
  }
  /* The rail: a fine dotted line, as in the reference. Only the active call gets a marker. */
  /* Sparse dots that fade out at both ends. */
  ol::before {
    content: "";
    position: absolute;
    left: 4px;
    top: -10px;
    bottom: -10px;
    width: 2px;
    background: radial-gradient(circle, rgb(var(--b-ink) / 0.5) 0.8px, transparent 1px) center top / 2px 8px repeat-y;
    -webkit-mask: linear-gradient(180deg, transparent, #000 22%, #000 78%, transparent);
    mask: linear-gradient(180deg, transparent, #000 22%, #000 78%, transparent);
  }
  li {
    position: relative;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto 52px;
    align-items: center;
    gap: 10px;
    height: 32px;
    padding: 0 8px;
    margin: 0;
    border-radius: 6px;
    font-size: 13px;
    color: var(--b-t3);
    cursor: default;
    transition: background 0.15s, color 0.15s;
  }
  li:hover {
    background: rgb(var(--b-ink) / 0.04);
    color: var(--b-t1);
  }
  .pt {
    display: none;
  }
  /* The active call's marker: a flat, soft disc on the rail with a small dark dot. */
  li.now .pt,
  li.next .pt {
    display: block;
    position: absolute;
    left: -24px;
    top: 50%;
    width: 22px;
    height: 22px;
    margin-top: -11px;
    border-radius: 50%;
    background:
      radial-gradient(circle, rgb(var(--b-ink) / 0.85) 0 1.75px, transparent 2.25px),
      var(--b-knob);
    box-shadow: 0 0 0 1px rgb(var(--b-ink) / 0.05);
  }
  .tt {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tm {
    font-size: 11px;
    color: var(--b-t3);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  /* State: a soft frosted pill; the active call's is dark with a thin terracotta ring. */
  .st {
    justify-self: end;
    font-size: 11px;
    line-height: 1;
    padding: 5px 10px;
    border-radius: 999px;
    background: rgb(var(--b-ink) / 0.04);
    border: 1px solid rgb(var(--b-ink) / 0.06);
    color: var(--b-t3);
    white-space: nowrap;
  }
  /* Done: outline only. Later: fill only. */
  li.done .st {
    background: transparent;
    border-color: rgb(var(--b-ink) / 0.08);
    color: rgb(var(--b-ink) / 0.32);
  }
  li.later .st {
    border-color: transparent;
  }
  li.done .tt,
  li.later .tt {
    opacity: 0.8;
  }
  li.now,
  li.next {
    color: var(--b-t1);
    font-weight: 500;
  }
  li.now .st,
  li.next .st {
    background: rgb(var(--b-ink) / 0.92);
    border-color: transparent;
    color: var(--b-bg);
    font-weight: 400;
    box-shadow: 0 0 0 1.5px var(--b-hot);
  }
  /* The marker beside the active call, as in the reference. */
  /* Even air on both sides: 22px from the pill, 22px to the Next call panel. */
  .mk {
    position: absolute;
    right: -20px;
    top: 50%;
    margin-top: -4px;
    border: 4px solid transparent;
    border-left: 6px solid rgb(var(--b-ink) / 0.85);
    border-right: 0;
  }
  /* Lines up with the call titles above (rail gutter 18px + row padding 8px). */
  .more {
    margin: 4px 0 0 26px;
    font-size: 11px;
    color: var(--b-t3);
    cursor: default;
  }
  .more:hover {
    color: var(--b-t1);
  }
  .empty {
    margin: 12px 0 0;
    font-size: 13px;
    color: var(--b-t3);
  }
</style>

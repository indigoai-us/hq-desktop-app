<script lang="ts">
  /**
   * Today's calls as a list, when the strip alone is not enough. Rows: 5 in a
   * two-row or three-column slot, 3 in a W or S, then a "+N more" row whose
   * peek lists the rest. Every row is a flat glass tile (no inner shadow, no
   * backdrop-filter): the time, the title, and a mono tag
   * for projected, tentative or running calls; past calls dim. Busy holds
   * fold into one "Busy until 2 PM" row. Hover a row for the strip's event
   * peek: countdown from the brief's now, attendees, join link, and Prep in
   * <engine>. The headline reads "5 calls · first at 9 AM" before the day
   * starts and "Nothing until 10:30" once it has.
   */
  import { peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import { agendaLimit, agendaRows, agendaTitle, countdownText, kindEyebrow, prepId, prepPrompt, type AgendaRow } from "./brief-agenda.js";
  import { rangeText } from "./brief-strip.js";
  import { clockLabel } from "./brief-time.js";
  import type { BriefCalendarEvent } from "./brief-types.js";

  interface Props {
    events: BriefCalendarEvent[];
    rows: number;
    /** Columns of the slot: a W3 (3 wide, one row) shows 5 rows like an M; W and S show 3. */
    cols?: number;
    /** ISO time the brief is for: the countdown, the running tag, and which calls dim as past. */
    now?: string | null;
    /** The calendar is illustrative (no live calendar): peeks carry the SAMPLE mark. */
    sample?: boolean;
    /** Opens the Meetings view; the peek offers it when the host has one. */
    onopenmeetings?: () => void;
  }
  let { events, rows, cols = 2, now = null, sample = false, onopenmeetings }: Props = $props();
  const brief = useBrief();
  const all = $derived(agendaRows(events, now));
  const shown = $derived(all.slice(0, agendaLimit(rows, cols)));
  const rest = $derived(all.slice(shown.length));
  const title = $derived(agendaTitle(events, now));
  const nowMs = $derived(now ? Date.parse(now) : NaN);

  const past = (r: AgendaRow) => Number.isFinite(nowMs) && r.end <= nowMs;
  const running = (r: AgendaRow) => Number.isFinite(nowMs) && r.start <= nowMs && nowMs < r.end;
  const iso = (ms: number) => new Date(ms).toISOString();
  const label = (r: AgendaRow) => (r.kind === "busy" ? `Busy until ${clockLabel(iso(r.end))}` : r.e.title);
  const actions = (): PeekContent["actions"] => (onopenmeetings ? [{ label: "Open in Meetings", run: onopenmeetings, testid: "brief-agenda-open-meetings" }] : []);

  function eventPeek(e: BriefCalendarEvent): PeekContent {
    const sections: PeekContent["sections"] = [];
    if (e.attendees?.length) sections.push({ label: "With", lines: e.attendees.slice(0, 5).map((a) => ({ label: a, state: "" })) });
    if (e.joinUrl) sections.push({ label: "Join", text: e.joinUrl });
    if (e.projected) sections.push({ label: "Projected", tone: "warn", text: "Projected from your recurring meetings. Today's calendar has not loaded yet." });
    const when = [rangeText(e), countdownText(e, now), e.tentative ? "Maybe" : null].filter((s): s is string => !!s);
    return {
      sample: sample || !!e.projected,
      compact: true,
      eyebrow: `Today · ${kindEyebrow(e.kind)}`,
      title: e.title,
      status: when.join(" · "),
      sections,
      prompt: { id: prepId(e), text: prepPrompt(e), verb: "Prep" },
      actions: actions(),
    };
  }

  function busyPeek(r: Extract<AgendaRow, { kind: "busy" }>): PeekContent {
    return {
      sample,
      title: "Busy",
      status: `Until ${clockLabel(iso(r.end))}${r.holds.length > 1 ? ` · ${r.holds.length} holds` : ""}`,
      sections: [{ label: "Holds", lines: r.holds.map((h) => ({ label: "Busy", state: rangeText(h) })) }],
      actions: actions(),
    };
  }

  const rowPeek = (r: AgendaRow): PeekContent => (r.kind === "busy" ? busyPeek(r) : eventPeek(r.e));

  const morePeek = (): PeekContent => ({
    sample,
    title: `${rest.length} more`,
    status: "Also today",
    sections: [{ label: "Later", lines: rest.map((r) => ({ label: label(r), state: r.kind === "busy" ? "" : rangeText(r.e) })) }],
    actions: actions(),
  });
</script>

<div class="w" data-testid="brief-agenda">
  <div class="eyebrow">
    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5.5" width="16" height="14" rx="3" /><path d="M4 10h16M9 3.5v4M15 3.5v4" /></svg> Today
  </div>
  <h3 data-testid="brief-agenda-title">{title}</h3>
  <div class="ag">
    {#each shown as r (r.id)}
      <div
        class="run"
        class:past={past(r)}
        class:live={running(r)}
        class:busy={r.kind === "busy"}
        class:tent={r.kind === "call" && r.e.tentative}
        role="group"
        aria-label="{label(r)}, {rangeText(r.kind === 'busy' ? { start: iso(r.start), end: iso(r.end) } : r.e)}"
        data-testid="brief-agenda-row"
        data-kind={r.kind}
        use:peek={{ state: brief, content: () => rowPeek(r) }}
      >
        <span class="t">{clockLabel(iso(r.start))}</span>
        <b>{label(r)}</b>
        {#if running(r)}<em class="now" data-testid="brief-agenda-now">NOW</em>
        {:else if r.kind === "call" && r.e.projected}<em>PROJECTED</em>
        {:else if r.kind === "call" && r.e.tentative}<em>MAYBE</em>{/if}
      </div>
    {/each}
    {#if rest.length}
      <div class="more" role="button" tabindex="0" data-testid="brief-agenda-more" use:peek={{ state: brief, content: morePeek }}>+{rest.length} more</div>
    {/if}
  </div>
</div>

<style>
  .ag {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 12px;
  }
  /* Glass row on the field: time, then the call. Past calls fade; the one running now gets a brighter rim. */
  .run {
    position: relative;
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 8px 10px;
    border-radius: 10px;
    font-size: var(--b-row-fs, 13px);
    min-width: 0;
    color: var(--b-t1, #fff);
    background: var(--b-row-bg, rgb(var(--b-on, 255 255 255) / 0.14));
    border: 1px solid var(--b-row-line, rgb(var(--b-on, 255 255 255) / 0.18));
    box-shadow: none;
    cursor: default;
    transition: background 0.2s, opacity 0.2s;
  }
  .run:hover,
  .run:focus-visible {
    background: var(--b-row-hover, rgb(var(--b-on, 255 255 255) / 0.22));
    outline: none;
  }
  .run.past {
    opacity: 0.6;
  }
  .run.past:hover {
    opacity: 1;
  }
  .run.live {
    border-color: rgb(var(--b-on, 255 255 255) / 0.55);
    background: rgb(var(--b-on, 255 255 255) / 0.24);
  }
  .run.tent {
    border-style: dashed;
  }
  .run.busy b {
    color: var(--b-t2);
  }
  .t {
    flex: none;
    width: 52px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: rgb(var(--b-on, 255 255 255) / 0.72);
  }
  b {
    font-weight: 400;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  em {
    font-style: normal;
    margin-left: auto;
    flex: none;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    color: rgb(var(--b-on, 255 255 255) / 0.75);
  }
  em.now {
    color: var(--b-t1, #fff);
  }
  .more {
    text-align: center;
    padding: 6px 10px;
    border-radius: 10px;
    font-size: var(--b-row-fs, 13px);
    color: rgb(var(--b-on, 255 255 255) / 0.85);
    background: var(--b-row-bg, rgb(var(--b-on, 255 255 255) / 0.1));
    border: 0;
    cursor: default;
  }
  .more:hover,
  .more:focus-visible {
    background: rgb(var(--b-on, 255 255 255) / 0.18);
    outline: none;
  }
</style>

<script lang="ts">
  /**
   * Today's calls as a list, when the strip alone is not enough. Rows: 5 in a
   * two-row or three-column slot, 3 in a W or S, then a "+N more" row whose
   * peek lists the rest. Every row is a flat glass tile (no inner shadow, no
   * backdrop-filter): time in mono, the kind dot, the title, and a mono tag
   * for projected, tentative or running calls; past calls dim. Busy holds
   * fold into one "Busy until 2 PM" row. Hover a row for the strip's event
   * peek: countdown from the brief's now, attendees, join link, and Prep in
   * <engine>. The headline reads "5 calls · first at 9 AM" before the day
   * starts and "Nothing until 10:30" once it has.
   */
  import { peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import { agendaLimit, agendaRows, agendaTitle, countdownText, kindEyebrow, prepId, prepPrompt, type AgendaRow } from "./brief-agenda.js";
  import { rangeText } from "./brief-strip.js";
  import { clockLabel, KIND_COLOR } from "./brief-time.js";
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
        {#if r.kind === "busy"}
          <i class="k hold"></i>
        {:else}
          <i class="k" style="background:{KIND_COLOR[r.e.kind]}"></i>
        {/if}
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
  /* Glass row: lit from the top, hairline rim, soft drop. No inner shadow and no
     backdrop-filter (WKWebView draws it as a square that ignores the radius). */
  .run {
    position: relative;
    display: flex;
    gap: 10px;
    align-items: center;
    padding: 7px 10px;
    border-radius: 12px;
    font-size: 12px;
    min-width: 0;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.08), rgba(255, 255, 255, 0.025) 45%, rgba(255, 255, 255, 0.015)),
      radial-gradient(120% 60% at 20% 0%, rgba(255, 255, 255, 0.05), transparent 60%);
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-top-color: rgba(255, 255, 255, 0.16);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 20px -8px rgba(0, 0, 0, 0.5);
    cursor: default;
    transition: border-color 0.2s, background 0.2s, opacity 0.2s;
  }
  .run:hover,
  .run:focus-visible {
    border-color: rgba(255, 255, 255, 0.22);
    outline: none;
  }
  .run.past {
    opacity: 0.5;
  }
  .run.past:hover {
    opacity: 1;
  }
  /* The call running now: a soft outer rim, never inset. */
  .run.live {
    border-color: rgba(255, 128, 159, 0.45);
    box-shadow: 0 0 0 1px rgba(255, 128, 159, 0.14), 0 8px 20px -8px rgba(0, 0, 0, 0.5);
  }
  .run.tent {
    border-style: dashed;
  }
  .run.busy b {
    color: var(--b-t2);
  }
  .t {
    font-family: var(--b-mono);
    font-size: 10px;
    color: var(--b-t3);
    width: 52px;
    flex: none;
  }
  .k {
    width: 8px;
    height: 8px;
    border-radius: 3px;
    flex: none;
  }
  .k.hold {
    background: repeating-linear-gradient(135deg, rgba(255, 255, 255, 0.35) 0 2px, transparent 2px 4px);
    border: 1px solid rgba(255, 255, 255, 0.18);
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
    font-family: var(--b-mono);
    font-size: 9.5px;
    letter-spacing: 0.08em;
    color: var(--b-t3);
  }
  em.now {
    color: #ff809f;
  }
  .more {
    text-align: center;
    padding: 5px 10px;
    border-radius: 10px;
    font-size: 12px;
    color: var(--b-t2);
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-top-color: rgba(255, 255, 255, 0.16);
    cursor: default;
  }
  .more:hover,
  .more:focus-visible {
    background: rgba(255, 255, 255, 0.09);
    outline: none;
  }
</style>

<script lang="ts" module>
  import type { BriefDecision } from "./brief-types.js";

  /** Minutes one call takes, by the writer's effort tag (the same scale the sunrise meter uses). */
  export const EFFORT_MIN: Record<NonNullable<BriefDecision["effort"]>, number> = { quick: 2, medium: 6, large: 15 };

  /** Mono age for a row: "<1h", "44h", then "3d" from two days; null when unknown. */
  export function ageLabel(hours: number | null | undefined): string | null {
    if (hours == null || !Number.isFinite(hours) || hours < 0) return null;
    if (hours < 1) return "<1h";
    if (hours < 48) return `${Math.round(hours)}h`;
    return `${Math.round(hours / 24)}d`;
  }

  /** Age tone: red past two days, amber past one, else neutral. */
  export function ageTone(hours: number | null | undefined): "red" | "warn" | null {
    if (hours == null || !Number.isFinite(hours)) return null;
    return hours > 48 ? "red" : hours > 24 ? "warn" : null;
  }

  /** "2nd brief" for a call carried from one earlier brief, "3rd brief" from two; null when it is new today. */
  export function carriedLabel(carriedBriefs: number | null | undefined): string | null {
    if (carriedBriefs == null || !Number.isFinite(carriedBriefs) || carriedBriefs < 1) return null;
    const n = Math.floor(carriedBriefs) + 1;
    const tens = n % 100;
    const suffix = tens >= 11 && tens <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
    return `${n}${suffix} brief`;
  }

  function joinNames(list: readonly string[]): string {
    if (list.length <= 1) return list[0] ?? "";
    if (list.length <= 3) return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
    return `${list.slice(0, 3).join(", ")} and ${list.length - 3} more`;
  }

  /**
   * Who waits on a reply: the people named in `blocks`, else "N waiting" from
   * `peopleWaiting`; null when nobody is known. Never says "people" without names.
   */
  export function waitersLine(d: BriefDecision): string | null {
    const people = [...new Set((d.blocks ?? []).filter((b) => b.kind === "person").map((b) => b.who.trim()).filter(Boolean))];
    if (people.length) return `${joinNames(people)} wait${people.length === 1 ? "s" : ""} on your reply`;
    if (d.peopleWaiting && d.peopleWaiting > 0) return `${d.peopleWaiting} waiting`;
    return null;
  }

  /**
   * Minutes left to clear the open calls: the writer's total when it wrote one
   * (less the effort of calls cleared here), else the sum of each open call's
   * effort. Null when nothing carries an effort tag.
   */
  export function minutesToClear(decisions: readonly BriefDecision[], cleared: Record<string, boolean>, writerTotal: number | null | undefined): number | null {
    const effort = (d: BriefDecision) => (d.effort ? EFFORT_MIN[d.effort] : 0);
    if (writerTotal != null && Number.isFinite(writerTotal)) {
      const done = decisions.filter((d) => cleared[d.id]).reduce((n, d) => n + effort(d), 0);
      return Math.max(0, Math.round(writerTotal - done));
    }
    if (!decisions.some((d) => d.effort)) return null;
    return decisions.filter((d) => !cleared[d.id]).reduce((n, d) => n + effort(d), 0);
  }
</script>

<script lang="ts">
  /**
   * Needs you: the decisions waiting on the person, in the order the picker
   * ranked them (a priority's call first, then by what it unblocks, then age).
   * Each row reveals its own launch controls on hover (no card lift); a decide
   * row's pill splits into its two answers. The row end carries a mono age
   * (amber past a day, red past two) and a "2nd brief" chip when the call was
   * carried from an earlier brief. Reply rows name who waits. A row's peek
   * shows why, what it unlocks, who it blocks, and the full prompt. Full detail
   * sits on the card only when the item is marked important.
   */
  import BriefLaunch from "./BriefLaunch.svelte";
  import BriefOrigin from "./BriefOrigin.svelte";
  import { peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import { decisionPeek } from "./brief-peeks.js";

  interface Props {
    decisions: BriefDecision[];
    prompts: Record<string, string>;
    rows: number;
    /** Sum of effort minutes over the open calls, when the writer wrote it (brief.json). Else summed from each call's effort. */
    timeToClearMin?: number | null;
  }
  let { decisions, prompts, rows, timeToClearMin = null }: Props = $props();
  const brief = useBrief();
  const tall = $derived(rows > 1);
  // At most five rows in a list; a "+N more" row opens the rest in the peek.
  const shown = $derived(tall ? decisions.slice(0, 5) : decisions.slice(0, 2));
  const rest = $derived(decisions.slice(shown.length));
  const morePeek = (): PeekContent => ({
    title: `${rest.length} more decision${rest.length === 1 ? "" : "s"}`,
    status: "Also waiting on you",
    sections: [{ label: "Decisions", lines: rest.map((d) => ({ label: d.title, state: brief.cleared[d.id] ? "DONE" : (ageLabel(d.ageHours) ?? ""), tone: brief.cleared[d.id] ? "ok" : (ageTone(d.ageHours) ?? "neutral") })) }],
  });
  const done = $derived(decisions.filter((d) => brief.cleared[d.id]).length);
  const minutes = $derived(minutesToClear(decisions, brief.cleared, timeToClearMin));

  const ICON: Record<string, string> = {
    cut: "M3 12V4h8l9 9-8 8zM7.5 8h.01",
    go: "M6 3h8l4 4v14H6zM14 3v4h4M9 13h6M9 17h4",
    decide: "M12 4v16M5 20h14M4 8h16M7 8l-3 6a3 3 0 0 0 6 0zM17 8l-3 6a3 3 0 0 0 6 0z",
    reply: "M4 5h16v11H9l-5 4z",
    prep: "M4 5.5h16v14H4zM4 10h16M9 3.5v4M15 3.5v4",
  };

  /** The sub line: who waits on a reply, then the why (important) or the summary. */
  function subLine(d: BriefDecision): string {
    const base = d.important && d.detail ? d.detail.why : d.summary;
    const waiters = d.action === "reply" ? waitersLine(d) : null;
    return waiters ? [waiters, base].filter(Boolean).join(" · ") : base;
  }

  /** The row's peek: the shared decision peek plus age, effort and who it blocks. */
  function content(d: BriefDecision): PeekContent {
    const p = decisionPeek(d, prompts[d.id]);
    const facts = [ageLabel(d.ageHours) ? `${ageLabel(d.ageHours)} old` : null, d.effort ? `~${EFFORT_MIN[d.effort]} min` : null, carriedLabel(d.carriedBriefs)].filter(Boolean);
    if (facts.length) p.status = [p.status, facts.join(" · ")].filter(Boolean).join(" · ");
    if (d.blocks?.length) {
      p.sections.push({
        label: "Waiting on this",
        lines: d.blocks.slice(0, 5).map((b) => ({ label: b.who, state: b.what, tone: b.kind === "person" ? ("warn" as const) : ("neutral" as const) })),
      });
    }
    return p;
  }

  function track(event: PointerEvent): void {
    const el = event.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--ix", `${((event.clientX - r.left) / r.width) * 100}%`);
    el.style.setProperty("--iy", `${((event.clientY - r.top) / r.height) * 100}%`);
  }
</script>

<div class="w c-violet" data-testid="brief-needs">
  <div class="eyebrow">
    <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3 5 14h6l-1 7 8-11h-6z" /></svg>
    Needs you · {decisions.length} decision{decisions.length === 1 ? "" : "s"}
  </div>
  <h3 class="lead" class:tall>Clear these and the day is yours.</h3>
  <div class="items">
    {#each shown as d (d.id)}
      {@const age = ageLabel(d.ageHours)}
      {@const carried = carriedLabel(d.carriedBriefs)}
      <div
        class="it"
        class:done={brief.cleared[d.id]}
        data-testid="brief-need"
        role="group"
        aria-label={d.title}
        onpointermove={track}
        use:peek={{ state: brief, content: () => content(d) }}
      >
        {#if tall}
          <div class="ic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d={ICON[d.action] ?? ICON.go} /></svg></div>
        {/if}
        <div class="tx">
          <div class="tt">
            <span class="t" data-testid="brief-need-title">{d.title}</span>
            {#if tall || carried || age}
              <span class="meta">
                {#if tall}<BriefOrigin origin={d.origin} product />{/if}
                {#if carried}<span class="chip-m carried" data-testid="brief-need-carried" title="Carried from {d.carriedBriefs} earlier brief{d.carriedBriefs === 1 ? '' : 's'}">{carried}</span>{/if}
                {#if age}<span class="chip-m age" class:warn={ageTone(d.ageHours) === "warn"} class:red={ageTone(d.ageHours) === "red"} data-testid="brief-need-age" title="Open for {age}">{age}</span>{/if}
              </span>
            {/if}
          </div>
          {#if tall}<div class="ts" data-testid="brief-need-sub">{subLine(d)}</div>{/if}
          {#if brief.notes[d.id]}<div class="ts note" role="status">{brief.notes[d.id]}</div>{/if}
        </div>
        <div class="acts">
          {#if brief.cleared[d.id]}
            <span class="donechip">Done</span>
          {:else if prompts[d.id]}
            <BriefLaunch id={d.id} prompt={prompts[d.id]!} compact={!tall} choices={d.action === "decide" ? d.choices ?? null : null} />
          {/if}
        </div>
      </div>
    {/each}
    {#if rest.length}
      <div class="it more-row" role="button" tabindex="0" data-testid="brief-need-more" use:peek={{ state: brief, content: morePeek }}>
        +{rest.length} more
      </div>
    {/if}
  </div>
  {#if tall}
    <div class="foot">
      <span>{done} of {decisions.length} cleared</span>
      <span data-testid="brief-need-time">{done === decisions.length ? "All clear" : minutes ? `~${minutes} min` : "Hover a row to start it"}</span>
    </div>
  {/if}
</div>

<style>
  .lead {
    font-size: 17px !important;
  }
  .lead.tall {
    font-size: 22px !important;
    letter-spacing: -0.02em !important;
  }
  .items {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 14px;
    min-height: 0;
  }
  /* Glass row: lit from the top, hairline rim, soft drop. No backdrop-filter, no well. */
  .it {
    position: relative;
    overflow: hidden;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 10px 9px 12px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid var(--b-line);
    transition: background 0.25s, opacity 0.5s;
  }
  .it:hover {
    background: rgba(255, 255, 255, 0.07);
  }
  /* Iridescent sheen = the decision under your cursor. */
  .it::before {
    content: "";
    display: none; /* calm pass: iridescent sheen off */
    position: absolute;
    inset: 0;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.35s;
    mix-blend-mode: overlay;
    background: radial-gradient(180px 90px at var(--ix, 50%) var(--iy, 50%), rgba(255, 255, 255, 0.55), transparent 70%),
      linear-gradient(100deg, transparent 10%, rgba(255, 140, 220, 0.35) 35%, rgba(140, 220, 255, 0.35) 55%, rgba(190, 255, 170, 0.3) 70%, transparent 90%);
  }
  .it:hover::before {
    opacity: 1;
  }
  .it.done {
    opacity: 0.45;
  }
  .it.done::before {
    display: none;
  }
  .it.done .t {
    text-decoration: line-through;
    text-decoration-color: rgba(255, 255, 255, 0.4);
  }
  .ic {
    width: 30px;
    height: 30px;
    flex: none;
    border-radius: 10px;
    display: grid;
    place-items: center;
    background: rgba(255, 255, 255, 0.13);
    border: 1px solid rgba(255, 255, 255, 0.14);
    box-shadow: none;
  }
  .ic svg {
    width: 15px;
    height: 15px;
    stroke: #fff;
    fill: none;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .tx {
    flex: 1;
    min-width: 0;
    /* Two lines of title before the ellipsis; the product chip never truncates. */
    container-type: inline-size;
  }
  .tt {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.25;
  }
  .tt .t {
    flex: 1;
    min-width: 0;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  /* Row end: product chip, then the carried and age marks. */
  .meta {
    flex: none;
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .tt :global(.org) {
    flex: none;
    font-size: 9.5px;
  }
  /* Too narrow for the product name: keep the logo, hide the text. */
  @container (max-width: 250px) {
    .tt :global(.org b) {
      display: none;
    }
  }
  .chip-m {
    flex: none;
    font-family: var(--b-mono);
    font-size: 9.5px;
    font-weight: 400;
    letter-spacing: 0.04em;
    line-height: 1;
    padding: 3px 6px;
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.72);
    background: rgba(0, 0, 0, 0.22);
    white-space: nowrap;
  }
  .age.warn {
    color: var(--b-warn);
  }
  .age.red {
    color: #ffc1bb;
    background: rgba(255, 69, 58, 0.42);
  }
  .more-row {
    justify-content: center;
    padding: 6px 12px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.78);
    cursor: default;
  }
  .ts {
    font-size: 11.5px;
    color: rgba(255, 255, 255, 0.62);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ts.note {
    color: #fff;
  }
  /* Actions appear only on the row that has your attention. */
  .acts {
    flex: none;
    opacity: 0;
    translate: 8px 0;
    transition: opacity 0.3s, translate 0.35s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .it:hover .acts,
  .it:focus-within .acts,
  .it.done .acts {
    opacity: 1;
    translate: 0 0;
  }
  .it:not(:hover):not(:focus-within):not(.done) .acts {
    position: absolute;
    right: 10px;
    pointer-events: none;
  }
  .donechip {
    font-size: 12px;
    font-weight: 500;
    padding: 6px 12px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.18);
  }
</style>

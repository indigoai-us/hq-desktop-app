<script lang="ts" module>
  import { asciiDecode } from "./brief-hover.js";
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
   * Today's priorities (was Needs you; the priorities strip folded in here,
   * design local). The page's main card: the writer's priorities first, at
   * most five, each with its because, then any other call waiting on the
   * person in the order the picker ranked them. A priority that opens a call
   * is that call's row (launch controls, age, carried chip, who waits); one
   * that opens an incident carries the incident's launch; one with no item is
   * a plain row. Priority rows lead with their rank, other calls with their
   * action icon. Actions appear on the row under the cursor; a row's peek
   * shows why, what it unlocks, who it blocks, the writer's score in words,
   * and the full prompt.
   */
  import BriefLaunch from "./BriefLaunch.svelte";
  import BriefOrigin from "./BriefOrigin.svelte";
  import { peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import { decisionPeek, priorityScoreWords, riskPeek, riskProduct } from "./brief-peeks.js";
  import type { BriefPriority, BriefRisk } from "./brief-types.js";

  interface Props {
    decisions: BriefDecision[];
    prompts: Record<string, string>;
    rows: number;
    /** Sum of effort minutes over the open calls, when the writer wrote it (brief.json). Else summed from each call's effort. */
    timeToClearMin?: number | null;
    /** Today's priorities, at most five are shown; each leads the list with its because. */
    priorities?: BriefPriority[];
    /** Risks a priority may point at. */
    risks?: BriefRisk[];
    /** ISO time the brief is for; red ages in incident peeks count back from it. */
    now?: string;
  }
  let { decisions, prompts, rows, timeToClearMin = null, priorities = [], risks = [], now = "" }: Props = $props();
  const brief = useBrief();
  const tall = $derived(rows > 1);

  type Entry =
    | { key: string; d: BriefDecision; p: BriefPriority | null; rank: number | null; risk: null }
    | { key: string; d: null; p: BriefPriority; rank: number; risk: BriefRisk | null };
  /** Priorities first (their call, their incident, or the plain line), then the other calls. */
  const entries = $derived.by((): Entry[] => {
    const out: Entry[] = [];
    const used = new Set<string>();
    priorities.slice(0, 5).forEach((p, i) => {
      const d = p.itemId ? decisions.find((x) => x.id === p.itemId) : undefined;
      if (d && !used.has(d.id)) {
        used.add(d.id);
        out.push({ key: `d:${d.id}`, d, p, rank: i + 1, risk: null });
        return;
      }
      const risk = p.itemId ? (risks.find((r) => r.id === p.itemId) ?? null) : null;
      out.push({ key: `p:${i}:${p.text}`, d: null, p, rank: i + 1, risk });
    });
    for (const d of decisions) if (!used.has(d.id)) out.push({ key: `d:${d.id}`, d, p: null, rank: null, risk: null });
    return out;
  });
  // At most five rows in a list; a "+N more" row opens the rest in the peek.
  const shown = $derived(tall ? entries.slice(0, 5) : entries.slice(0, 2));
  const rest = $derived(entries.slice(shown.length));
  const entryTitle = (e: Entry) => e.p?.text ?? e.d!.title;
  const entryDone = (e: Entry) => (e.d ? !!brief.cleared[e.d.id] : e.risk ? !!brief.cleared[e.risk.id] : false);
  const morePeek = (): PeekContent => ({
    title: `${rest.length} more`,
    status: "Also waiting on you",
    sections: [
      {
        label: "Also today",
        lines: rest.map((e) => {
          const age = e.d ? ageLabel(e.d.ageHours) : null;
          return { label: entryTitle(e), state: entryDone(e) ? "DONE" : (age ?? ""), tone: entryDone(e) ? "ok" : ((e.d ? ageTone(e.d.ageHours) : null) ?? "neutral") };
        }),
      },
    ],
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

  /** The sub line: who waits on a reply, then the priority's because, else the why (important) or the summary. */
  function subLine(d: BriefDecision, p: BriefPriority | null): string {
    const base = p?.because || (d.important && d.detail ? d.detail.why : d.summary);
    const waiters = d.action === "reply" ? waitersLine(d) : null;
    return waiters ? [waiters, base].filter(Boolean).join(" · ") : base;
  }

  /** The row's peek: the shared decision peek plus age, effort, the priority's score in words, and who it blocks. */
  function content(d: BriefDecision, p: BriefPriority | null): PeekContent {
    const c = decisionPeek(d, prompts[d.id]);
    const facts = [ageLabel(d.ageHours) ? `${ageLabel(d.ageHours)} old` : null, d.effort ? `~${EFFORT_MIN[d.effort]} min` : null, carriedLabel(d.carriedBriefs)].filter(Boolean);
    if (facts.length) c.status = [c.status, facts.join(" · ")].filter(Boolean).join(" · ");
    const words = p ? priorityScoreWords(p, d, now) : null;
    if (words) c.status = [c.status, words].filter(Boolean).join(" · ");
    if (d.blocks?.length) {
      c.sections.push({
        label: "Waiting on this",
        lines: d.blocks.slice(0, 5).map((b) => ({ label: b.who, state: b.what, tone: b.kind === "person" ? ("warn" as const) : ("neutral" as const) })),
      });
    }
    return c;
  }

  /** A priority with no call behind it: its incident's peek, else the line and its because. */
  function priorityContent(p: BriefPriority, risk: BriefRisk | null): PeekContent {
    const c: PeekContent = risk ? riskPeek(risk, prompts[risk.id] ?? risk.prompt, now) : { title: p.text, status: p.because ?? undefined, sections: [] };
    const words = priorityScoreWords(p, risk, now);
    if (words) c.status = [c.status, words].filter(Boolean).join(" · ");
    return c;
  }

  function track(event: PointerEvent): void {
    const el = event.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--ix", `${((event.clientX - r.left) / r.width) * 100}%`);
    el.style.setProperty("--iy", `${((event.clientY - r.top) / r.height) * 100}%`);
  }
</script>

<div class="w c-violet" data-testid="brief-needs">
  <div class="eyebrow" data-testid={priorities.length ? "brief-priorities" : undefined}>
    {priorities.length ? "Today's priorities" : "Needs you"}{#if decisions.length}<span class="cnt">{decisions.length} decision{decisions.length === 1 ? "" : "s"}</span>{/if}
  </div>
  <h3 class="lead" class:tall>Clear these and the day is yours.</h3>
  <div class="items">
    {#each shown as e (e.key)}
      {#if e.d}
        {@const d = e.d}
        {@const age = ageLabel(d.ageHours)}
        {@const carried = carriedLabel(d.carriedBriefs)}
        <div
          class="it"
          data-decode-host
          class:done={brief.cleared[d.id]}
          data-testid="brief-need"
          data-brief-row
          data-priority={e.rank}
          role="group"
          aria-label={d.title}
          onpointermove={track}
          use:peek={{ state: brief, content: () => content(d, e.p) }}
        >
          {#if tall}
            {#if e.rank}<div class="ic rank">{e.rank}</div>
            {:else}<div class="ic"><svg viewBox="0 0 24 24" aria-hidden="true"><path d={ICON[d.action] ?? ICON.go} /></svg></div>{/if}
          {/if}
          <div class="tx">
            <div class="tt">
              <span class="t" data-testid="brief-need-title" use:asciiDecode>{e.p?.text ?? d.title}</span>
              {#if tall || carried || age}
                <span class="meta">
                  {#if tall}<BriefOrigin origin={d.origin} product />{/if}
                  {#if carried}<span class="chip-m carried" data-testid="brief-need-carried">{carried}</span>{/if}
                  {#if age}<span class="chip-m age" class:warn={ageTone(d.ageHours) === "warn"} class:red={ageTone(d.ageHours) === "red"} data-testid="brief-need-age">{age}</span>{/if}
                </span>
              {/if}
            </div>
            {#if tall}<div class="ts" data-testid="brief-need-sub">{subLine(d, e.p)}</div>{/if}
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
      {:else}
        {@const p = e.p}
        {@const risk = e.risk}
        {@const prompt = risk ? (prompts[risk.id] ?? risk.prompt) : undefined}
        <div
          class="it"
          data-decode-host
          class:done={entryDone(e)}
          data-testid="brief-need-priority"
          data-brief-row
          data-priority={e.rank}
          role="group"
          aria-label={p.text}
          onpointermove={track}
          use:peek={{ state: brief, content: () => priorityContent(p, risk) }}
        >
          {#if tall}<div class="ic rank">{e.rank}</div>{/if}
          <div class="tx">
            <div class="tt">
              <span class="t" use:asciiDecode>{p.text}</span>
              {#if tall && risk?.origin.companyUid}
                <!-- Same logo and product name as the decision rows (the CI repo names the product when the origin does not). -->
                <span class="meta"><BriefOrigin origin={{ ...risk.origin, repo: risk.origin.repo ?? risk.ci?.repo ?? null }} product /></span>
              {/if}
            </div>
            {#if tall && p.because}<div class="ts">{p.because}</div>{/if}
          </div>
          {#if risk}
            <div class="acts">
              {#if brief.cleared[risk.id]}
                <span class="donechip">Done</span>
              {:else if prompt}
                <BriefLaunch id={risk.id} {prompt} compact={!tall} />
              {/if}
            </div>
          {/if}
        </div>
      {/if}
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
      <!-- Progress, quietly: a hairline that fills as calls are cleared. -->
      <span class="bar" role="progressbar" aria-label="Decisions cleared" aria-valuemin="0" aria-valuemax={decisions.length} aria-valuenow={done} data-testid="brief-need-progress"
        ><i style="width:{decisions.length ? (done / decisions.length) * 100 : 100}%"></i></span
      >
      {#if done === decisions.length || minutes}<span data-testid="brief-need-time">{done === decisions.length ? "All clear" : `~${minutes} min`}</span>{/if}
    </div>
  {/if}
</div>

<style>
  /* The progress bar is the divider here, so the footer drops its hairline. */
  .foot {
    align-items: center;
    border-top: 0;
  }
  .bar {
    flex: 1;
    height: 3px;
    border-radius: 99px;
    background: rgb(var(--b-ink) / 0.16);
    overflow: hidden;
  }
  .bar i {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: rgb(var(--b-ink) / 0.7);
    transition: width 0.9s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .lead {
    font-size: var(--b-fs-title) !important;
  }
  .lead.tall {
    font-size: var(--b-fs-title-lg) !important;
    letter-spacing: -0.02em !important;
  }
  /* Rows share the card's height: with few decisions each row grows (up to a cap) instead of
     leaving a block of empty card under the list. */
  .items {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-top: 14px;
    min-height: 0;
  }
  /* Glass row: lit from the top, hairline rim, soft drop. No backdrop-filter, no well. */
  .it {
    flex: 1 1 auto;
    max-height: 132px;
    position: relative;
    overflow: hidden;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 10px 9px 12px;
    border-radius: var(--b-r, 12px);
    background: linear-gradient(180deg, rgb(var(--b-ink) / 0.11), rgb(var(--b-ink) / 0.06));
    border: 1px solid rgb(var(--b-ink) / 0.1);
    border-top-color: rgb(var(--b-ink) / 0.18);
    box-shadow: 0 6px 14px rgba(90, 30, 140, 0.18);
    transition: background 0.25s, opacity 0.5s;
  }
  .it:hover {
    background: linear-gradient(180deg, rgb(var(--b-ink) / 0.17), rgb(var(--b-ink) / 0.09));
  }
  /* Iridescent sheen = the decision under your cursor. */
  .it::before {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.35s;
    mix-blend-mode: overlay;
    background: radial-gradient(180px 90px at var(--ix, 50%) var(--iy, 50%), rgb(var(--b-ink) / 0.55), transparent 70%),
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
    text-decoration-color: rgb(var(--b-ink) / 0.4);
  }
  .ic {
    width: 30px;
    height: 30px;
    flex: none;
    border-radius: 6px;
    display: grid;
    place-items: center;
    background: rgb(var(--b-ink) / 0.13);
    border: 1px solid rgb(var(--b-ink) / 0.14);
    box-shadow: none;
  }
  /* A priority leads with its rank, light and large, like a step in a list. */
  .ic.rank {
    font-size: 13px;
    font-weight: 400;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
    color: #fff;
  }
  .cnt {
    margin-left: auto;
    padding: 3px 9px;
    border-radius: 999px;
    border: 1px solid rgb(var(--b-ink) / 0.3);
    letter-spacing: 0;
  }
  .lg {
    display: inline-grid;
    place-items: center;
    width: 14px;
    height: 14px;
    border-radius: 4px;
    overflow: hidden;
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
    font-size: 11px;
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
    font-size: 11px;
    font-weight: 400;
    letter-spacing: 0;
    line-height: 1;
    padding: 3px 6px;
    border-radius: 6px;
    color: rgb(var(--b-ink) / 0.72);
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
    font-size: 13px;
    color: rgb(var(--b-ink) / 0.78);
    cursor: default;
  }
  .ts {
    font-size: 11px;
    color: rgb(var(--b-ink) / 0.8);
    margin-top: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ts.note {
    color: #fff;
  }
  /* Actions appear only on the row that has your attention. */
  /* Actions float over the row's end on hover, so the title keeps its full width. */
  .acts {
    flex: none;
    position: absolute;
    z-index: 2;
    top: 50%;
    right: 0;
    padding: 0 12px 0 0;
    height: 100%;
    display: flex;
    align-items: center;
    opacity: 0;
    translate: 8px -50%;
    pointer-events: none;
    transition: opacity 0.3s, translate 0.35s cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  .it:hover .acts,
  .it:focus-within .acts {
    opacity: 1;
    translate: 0 -50%;
    pointer-events: auto;
  }
  /* No panel behind the buttons: the row's own text fades out under them instead, so they sit on the row's glass. */
  .it .tx,
  .it .meta {
    transition: opacity 0.2s;
  }
  .it:not(.done):is(:hover, :focus-within):has(.acts :global(.launch)) .meta {
    opacity: 0;
  }
  .it:not(.done):is(:hover, :focus-within):has(.acts :global(.launch)) .tx {
    -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - var(--acts-w) - 40px), transparent calc(100% - var(--acts-w) - 8px));
    mask-image: linear-gradient(90deg, #000 calc(100% - var(--acts-w) - 40px), transparent calc(100% - var(--acts-w) - 8px));
  }
  .it {
    --acts-w: 150px;
  }
  .it:not(.done):is(:hover, :focus-within) {
    --acts-w: 300px;
  }
  /* One height for every control on the row (28px), light glass chips, no ring or drop. */
  .acts :global(.launch) {
    gap: 6px;
    /* The row title's shadow must not reach the buttons' labels. */
    text-shadow: none;
  }
  .acts :global(.launch .go:hover) {
    background: rgba(255, 255, 255, 0.86);
  }
  .acts :global(.launch .go) {
    height: 28px;
    padding: 0 12px;
    box-sizing: border-box;
    box-shadow: none;
  }
  .acts :global(.launch .eng) {
    height: 28px;
    box-sizing: border-box;
    align-items: center;
    padding: 2px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.16);
  }
  .acts :global(.launch .eng button) {
    height: 24px;
    padding: 0 7px;
    box-sizing: border-box;
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.7);
  }
  .acts :global(.launch .eng button[aria-pressed="true"]) {
    background: rgba(255, 255, 255, 0.95);
    color: #2a1a5c;
  }
  .acts :global(.launch .copy) {
    background: rgba(255, 255, 255, 0.16);
    color: rgba(255, 255, 255, 0.85);
  }
  .acts :global(.launch .copy:hover) {
    background: rgba(255, 255, 255, 0.26);
    color: #fff;
  }
  /* The engine switch and copy are hidden until the row is hovered. */
  .acts :global(.eng),
  .acts :global(.copy) {
    display: none;
  }
  /* The whole set shows as soon as the row is hovered, so nothing shifts under the pointer once you reach for a button. */
  .it:is(:hover, :focus-within) .acts :global(.eng) {
    display: inline-flex;
  }
  .it:is(:hover, :focus-within) .acts :global(.copy) {
    display: inline-grid;
  }
  /* Row text stays readable on the dusk gradient's bright corner. */
  .it .t {
    text-shadow: 0 1px 2px rgba(60, 10, 40, 0.35);
  }
  .it.done .acts {
    position: static;
    height: auto;
    padding: 0;
    background: none;
    opacity: 1;
    translate: 0 0;
    pointer-events: auto;
  }
  .donechip {
    font-size: 13px;
    font-weight: 500;
    padding: 6px 12px;
    border-radius: 999px;
    background: rgb(var(--b-ink) / 0.18);
  }
</style>

<script lang="ts">
  /**
   * Needs you: the decisions waiting on the person. Each row reveals its own
   * launch controls on hover (no card lift). A row's peek shows why, what it
   * unlocks, and the full prompt. Full detail sits on the card only when the
   * item is marked important.
   */
  import BriefLaunch from "./BriefLaunch.svelte";
  import BriefOrigin from "./BriefOrigin.svelte";
  import { peek, useBrief, type PeekContent } from "./brief-context.svelte.js";
  import { decisionPeek } from "./brief-peeks.js";
  import type { BriefDecision } from "./brief-types.js";

  let { decisions, prompts, rows }: { decisions: BriefDecision[]; prompts: Record<string, string>; rows: number } = $props();
  const brief = useBrief();
  const tall = $derived(rows > 1);
  // At most five rows in a list; a "+N more" row opens the rest in the peek.
  const shown = $derived(tall ? decisions.slice(0, 5) : decisions.slice(0, 2));
  const rest = $derived(decisions.slice(shown.length));
  const morePeek = (): PeekContent => ({
    title: `${rest.length} more decision${rest.length === 1 ? "" : "s"}`,
    status: "Also waiting on you",
    sections: [{ label: "Decisions", lines: rest.map((d) => ({ label: d.title, state: brief.cleared[d.id] ? "DONE" : "" })) }],
  });
  const done = $derived(decisions.filter((d) => brief.cleared[d.id]).length);

  const ICON: Record<string, string> = {
    cut: "M3 12V4h8l9 9-8 8zM7.5 8h.01",
    go: "M6 3h8l4 4v14H6zM14 3v4h4M9 13h6M9 17h4",
    decide: "M12 4v16M5 20h14M4 8h16M7 8l-3 6a3 3 0 0 0 6 0zM17 8l-3 6a3 3 0 0 0 6 0z",
    reply: "M4 5h16v11H9l-5 4z",
    prep: "M4 5.5h16v14H4zM4 10h16M9 3.5v4M15 3.5v4",
  };

  const content = (d: BriefDecision): PeekContent => decisionPeek(d, prompts[d.id]);

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
          <div class="tt"><span class="t" data-testid="brief-need-title">{d.title}</span>{#if tall}<BriefOrigin origin={d.origin} product />{/if}</div>
          {#if tall}<div class="ts">{d.important && d.detail ? d.detail.why : d.summary}</div>{/if}
          {#if brief.notes[d.id]}<div class="ts note" role="status">{brief.notes[d.id]}</div>{/if}
        </div>
        <div class="acts">
          {#if brief.cleared[d.id]}
            <span class="donechip">Done</span>
          {:else if prompts[d.id]}
            <BriefLaunch id={d.id} prompt={prompts[d.id]!} compact={!tall} />
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
    <div class="foot"><span>{done} of {decisions.length} cleared</span><span>Hover a row to start it</span></div>
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
  .it {
    position: relative;
    overflow: hidden;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 9px 10px 9px 12px;
    border-radius: 16px;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.11), rgba(255, 255, 255, 0.06));
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.14), 0 6px 14px rgba(20, 8, 60, 0.25);
    transition: background 0.25s, opacity 0.5s;
  }
  .it:hover {
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.17), rgba(255, 255, 255, 0.09));
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
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.2), 0 3px 8px rgba(20, 8, 60, 0.3);
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
  }
  /* Two lines of title before the ellipsis; the product chip never truncates. */
  .tx {
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
  .tt :global(.org) {
    flex: none;
    margin-left: auto;
    font-size: 9.5px;
  }
  /* Too narrow for the product name: keep the logo, hide the text. */
  @container (max-width: 250px) {
    .tt :global(.org b) {
      display: none;
    }
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

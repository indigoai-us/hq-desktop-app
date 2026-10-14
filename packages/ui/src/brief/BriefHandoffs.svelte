<script lang="ts">
  /**
   * Ownership moved: handoffs that changed hands in the window and whether
   * they landed (access, acknowledgment, first activity). Each row is a glass
   * row: what moved (with its company logo), then giver -> receiver as two
   * monochrome initials and one status pill: "Needs you" when it is yours to
   * acknowledge, "Waiting" / "Acked" with the receipts in ("1 of 3", on
   * cards wide enough), or "Landed". The pill turns warm when a receipt is late (overdue or in
   * production); unknown receipts never count as in. The three receipts stay
   * in the row for screen readers. Hover swaps the people and status for
   * Acknowledge (start in the engine) on your rows and Nudge (copy a DM
   * draft, nothing is sent) on the others; the peek shows the giver's note,
   * the receipts, the production flag and the prompt. Lists cap at five,
   * then "+N more". Narrow cards stack the row on two lines.
   */
  import BriefLaunch from "./BriefLaunch.svelte";
  import BriefOrigin from "./BriefOrigin.svelte";
  import { copyBriefPrompt, peek, useBrief } from "./brief-context.svelte.js";
  import {
    HANDOFF_ROWS,
    HANDOFF_ROWS_SHORT,
    HANDOFF_ROWS_NARROW,
    RECEIPTS,
    acked,
    handoffHeadline,
    handoffPeek,
    initial,
    landed,
    landedCount,
    moreHandoffsPeek,
    needsMyAck,
    promptFor,
    rankHandoffs,
    receiptHot,
    receiptState,
  } from "./brief-handoffs.js";
  import type { BriefHandoff } from "./brief-types.js";

  interface Props {
    handoffs: BriefHandoff[];
    prompts: Record<string, string>;
    /** ISO time the brief is for; ages and the 24h amber rule read it. */
    now: string;
    rows: number;
    /** Columns of the slot: a one-column, one-row card fits a single two-line row. */
    cols?: number;
  }

  let { handoffs, prompts, now, rows, cols = 2 }: Props = $props();
  const brief = useBrief();
  const ranked = $derived(rankHandoffs(handoffs, now));
  const cap = $derived(rows > 1 ? HANDOFF_ROWS : cols > 1 ? HANDOFF_ROWS_SHORT : HANDOFF_ROWS_NARROW);
  const shown = $derived(ranked.slice(0, cap));
  const rest = $derived(ranked.slice(cap));
  const done = $derived(landedCount(ranked));
  const headline = $derived(handoffHeadline(ranked));
  let copied = $state<string | null>(null);

  type HandoffStatus = { key: "needs-you" | "acked" | "waiting" | "landed"; text: string; steps: string | null; hot: boolean };
  /**
   * One status in place of the three receipt dots, same meaning: landed when
   * every receipt is in; "Needs you" while it waits on your acknowledgment;
   * otherwise acked or still waiting, with how many receipts are in. Warm when
   * any receipt is late (the old amber ring).
   */
  function statusOf(h: BriefHandoff): HandoffStatus {
    const n = RECEIPTS.filter((r) => h.receipts[r.key] === true).length;
    const steps = `${n} of ${RECEIPTS.length}`;
    if (landed(h)) return { key: "landed", text: "Landed", steps: null, hot: false };
    if (needsMyAck(h)) return { key: "needs-you", text: "Needs you", steps: null, hot: true };
    const hot = RECEIPTS.some((r) => receiptHot(h, r.key, now));
    return acked(h) ? { key: "acked", text: "Acked", steps, hot } : { key: "waiting", text: "Waiting", steps, hot };
  }

  /** Nudge copies a DM-draft prompt; the person reads and sends it themselves. */
  async function nudge(h: BriefHandoff): Promise<void> {
    const prompt = promptFor(h, prompts);
    if (prompt && (await copyBriefPrompt(prompt))) {
      copied = h.id;
      setTimeout(() => (copied = null), 1400);
    }
  }
</script>

{#if ranked.length}
  <div class="w" data-testid="brief-handoffs">
    <div class="eyebrow">
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="2.5" /><circle cx="18.5" cy="12" r="2.5" /><path d="M8.5 12h6.5M12.5 9.5l2.5 2.5-2.5 2.5" /></svg>
      Ownership moved
    </div>
    <h3 data-testid="brief-handoffs-title">{headline}</h3>
    <div class="list">
      {#each shown as h (h.id)}
        {@const prompt = promptFor(h, prompts)}
        {@const isLanded = landed(h)}
        {@const st = statusOf(h)}
        <div
          class="hr"
          class:me={h.me}
          class:landed={isLanded}
          class:done={brief.cleared[h.id]}
          data-testid="brief-handoff"
          data-handoff={h.id}
          data-landed={isLanded}
          role="group"
          aria-label={`${h.object} · ${h.from} to ${h.to}`}
          use:peek={{ state: brief, content: () => handoffPeek(h, prompt, now) }}
        >
          <span class="ob">
            <span class="name" data-testid="brief-handoff-object">{h.object}</span>
            <BriefOrigin origin={h.origin} product />
          </span>
          <span class="pp">
            <span class="ini" title={h.from} data-testid="brief-handoff-from">{initial(h.from)}</span>
            <svg class="ar" viewBox="0 0 12 12" aria-hidden="true" data-testid="brief-handoff-arrow" data-acked={acked(h)}><path d="M2 6h8M7 3l3 3-3 3" /></svg>
            <span class="ini" title={h.to} data-testid="brief-handoff-to">{initial(h.to)}</span>
          </span>
          <span class="st" class:hot={st.hot} data-testid="brief-handoff-status" data-status={st.key}>
            {st.text}{#if st.steps}<span class="steps">{` · ${st.steps}`}</span>{/if}
          </span>
          <!-- The receipts behind the status, for screen readers; the peek shows them to everyone. -->
          <span class="rc" role="group" aria-label="Receipts">
            {#each RECEIPTS as r (r.key)}
              {@const s = receiptState(h.receipts[r.key])}
              <i
                class="rd {s}"
                class:hot={receiptHot(h, r.key, now)}
                role="img"
                aria-label={`${r.label} ${s}`}
                data-testid="brief-receipt"
                data-receipt={r.key}
                data-state={s}
              ></i>
            {/each}
          </span>
          {#if !isLanded && prompt}
            <span class="acts">
              {#if brief.cleared[h.id]}
                <span class="donechip">Done</span>
              {:else if h.me}
                <span class="verb" data-testid="brief-handoff-ack">Acknowledge</span>
                <BriefLaunch id={h.id} {prompt} compact />
              {:else}
                <button type="button" class="btn nudge" data-testid="brief-handoff-nudge" onclick={() => void nudge(h)}>
                  {copied === h.id ? "Copied" : "Nudge"}
                </button>
              {/if}
            </span>
          {/if}
        </div>
      {/each}
      {#if rest.length}
        <div class="hr more" role="button" tabindex="0" data-testid="brief-handoffs-more" use:peek={{ state: brief, content: () => moreHandoffsPeek(rest, now) }}>
          +{rest.length} more
        </div>
      {/if}
    </div>
    {#if rows > 1}
      <div class="foot" data-testid="brief-handoffs-foot"><span class="fl">Access · Ack · Active</span><span class="fv">{done} of {ranked.length} landed</span></div>
    {/if}
  </div>
{/if}

<style>
  /* Small card headline: 16px, white, wrapped whole words, never hyphenated. */
  .w h3 {
    font-size: 16px;
    font-weight: 500;
    line-height: 1.3;
    letter-spacing: -0.01em;
    color: #fff;
    hyphens: none;
    overflow-wrap: normal;
    word-break: normal;
    text-wrap: pretty;
  }
  .list {
    container: hlist / inline-size;
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 12px;
    min-height: 0;
  }
  /* Glass rows: what moved on the left, giver -> receiver, one status pill on the right. */
  .hr {
    position: relative;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas: "pp ob st";
    align-items: center;
    column-gap: 10px;
    row-gap: 6px;
    padding: 8px 10px;
    border-radius: 10px;
    font-size: var(--b-row-fs, 13px);
    line-height: 1.3;
    color: #fff;
    background: rgba(255, 255, 255, 0.14);
    border: 0;
    transition: background 0.2s, opacity 0.4s;
  }
  .hr:hover,
  .hr:focus-within,
  .hr:focus-visible {
    background: rgba(255, 255, 255, 0.22);
    outline: none;
  }
  .hr.landed {
    opacity: 0.72;
  }
  .hr.done .name {
    text-decoration: line-through;
    text-decoration-color: rgba(255, 255, 255, 0.5);
  }
  /* Narrow card: what moved on the first line, people and status on the second. */
  @container hlist (max-width: 299px) {
    .hr {
      grid-template-columns: auto minmax(0, 1fr) auto;
      grid-template-areas:
        "ob ob ob"
        "pp . st";
    }
    /* The actions take the whole second line, so the people step aside too. */
    .hr .acts {
      top: auto;
      bottom: 7px;
      translate: none;
    }
    .hr:hover .pp,
    .hr:focus-within .pp {
      opacity: 0;
    }
    .hr {
      column-gap: 6px;
    }
    /* No room beside the people for a pill: the status is plain words with its dot, and the peek lists the receipts. */
    .hr .st {
      height: auto;
      padding: 0;
      background: none;
      color: rgba(255, 255, 255, 0.82);
    }
    .steps {
      display: none;
    }
  }
  /* Wide card: on hover the logo steps aside and a long name stops short of the actions. */
  @container hlist (min-width: 300px) {
    .hr:hover .ob :global(.org),
    .hr:focus-within .ob :global(.org) {
      opacity: 0;
    }
    .hr.me:hover .ob,
    .hr.me:focus-within .ob {
      margin-right: 64px;
    }
  }
  .ob {
    grid-area: ob;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    container-type: inline-size;
  }
  .ob .name {
    min-width: 0;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ob :global(.org) {
    flex: none;
    margin-left: auto;
    transition: opacity 0.2s;
  }
  .ob :global(.org b) {
    color: rgba(255, 255, 255, 0.78);
  }
  /* Too narrow for the product name: keep the logo, hide the text. */
  @container (max-width: 170px) {
    .ob :global(.org b) {
      display: none;
    }
  }
  /* Giver -> receiver: two monochrome initial circles and a small arrow. */
  .pp {
    grid-area: pp;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    transition: opacity 0.2s;
  }
  .ini {
    width: 22px;
    height: 22px;
    flex: none;
    border-radius: 50%;
    display: grid;
    place-items: center;
    font-size: 11px;
    font-weight: 500;
    line-height: 1;
    color: #fff;
    background: rgba(255, 255, 255, 0.2);
  }
  .ar {
    width: 12px;
    height: 12px;
    flex: none;
    fill: none;
    stroke: rgba(255, 255, 255, 0.7);
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  /* One status: a small glass pill. */
  .st {
    grid-area: st;
    justify-self: end;
    flex: none;
    height: 20px;
    padding: 0 8px;
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    color: rgba(255, 255, 255, 0.88);
    background: rgba(255, 255, 255, 0.16);
    transition: opacity 0.2s;
  }
  /* Late or waiting on you: a small warm dot leads the words; the pill stays glass so it reads. */
  .st.hot::before {
    content: "";
    flex: none;
    width: 6px;
    height: 6px;
    margin-right: 6px;
    border-radius: 50%;
    background: #ffd27a;
  }
  .steps {
    white-space: pre;
    opacity: 0.8;
  }
  /* The receipts are read out, not drawn. */
  .rc {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  /* Actions take the status's place on the row that has your attention. */
  .acts {
    position: absolute;
    right: 10px;
    top: 50%;
    translate: 0 -50%;
    display: flex;
    align-items: center;
    gap: 6px;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s;
  }
  .hr:hover .acts,
  .hr:focus-within .acts,
  .hr.done .acts {
    opacity: 1;
    pointer-events: auto;
  }
  .hr:hover .st,
  .hr:focus-within .st,
  .hr.done .st {
    opacity: 0;
  }
  .verb {
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.7);
    white-space: nowrap;
  }
  /* Row buttons: small mono caps on soft glass, filled white on hover. The peek keeps the engine switch and copy. */
  .btn,
  .acts :global(.launch .go) {
    all: unset;
    cursor: pointer;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    height: 24px;
    padding: 0 9px;
    border-radius: 6px;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
    color: #fff;
    background: rgba(255, 255, 255, 0.16);
    box-shadow: none;
    transition: background 0.2s, color 0.2s;
  }
  .btn:hover,
  .btn:focus-visible,
  .acts :global(.launch .go:hover),
  .acts :global(.launch .go:focus-visible) {
    color: #18181b;
    background: #fff;
    outline: none;
  }
  .acts :global(.launch .eng),
  .acts :global(.launch .copy) {
    display: none;
  }
  .donechip {
    height: 20px;
    padding: 0 8px;
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.88);
    background: rgba(255, 255, 255, 0.16);
  }
  /* "+N more": a plain glass row, centred. */
  .hr.more {
    display: flex;
    justify-content: center;
    padding: 6px 10px;
    color: rgba(255, 255, 255, 0.85);
    cursor: default;
  }
  /* Foot: the receipts legend as a mono label, the landed count beside it. */
  .foot {
    align-items: center;
  }
  .fl {
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: rgba(255, 255, 255, 0.62);
  }
  .fv {
    font-size: var(--b-row-fs, 13px);
    font-weight: 500;
    color: #fff;
  }
</style>

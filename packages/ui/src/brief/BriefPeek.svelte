<script lang="ts">
  /**
   * The detail card beside whatever is hovered. Actionable items show the
   * full prompt before launch. Compact cards (session dots) show an eyebrow
   * with the company chip, the title, a status line, and two pill buttons:
   * <verb> in <engine> and Copy prompt, with no prompt text.
   */
  import BriefLaunch from "./BriefLaunch.svelte";
  import BriefLogo from "./BriefLogo.svelte";
  import BriefPeekDms from "./BriefPeekDms.svelte";
  import { ENGINES, copyBriefPrompt, useBrief } from "./brief-context.svelte.js";
  import { peekTop } from "./brief-layout.js";

  const brief = useBrief();
  // Level with the hovered thing; moved up only as far as its measured height needs to stay on screen.
  let peekH = $state(0);
  const top = $derived(brief.peek ? peekTop(brief.peek.anchorTop, peekH, typeof window === "undefined" ? 900 : window.innerHeight) : 0);
  const engine = $derived(ENGINES.find((e) => e.id === brief.engine)!);
  let copied = $state(false);

  async function copy(text: string): Promise<void> {
    copied = await copyBriefPrompt(text);
    if (copied) setTimeout(() => (copied = false), 1400);
  }
</script>

{#if brief.peek}
  {@const p = brief.peek}
  <div
    class="peek {p.side}"
    class:compact={p.content.compact}
    role="dialog"
    tabindex="-1"
    aria-label={p.content.title}
    data-testid="brief-peek"
    bind:offsetHeight={peekH}
    style:left="{p.x}px"
    style:top="{top}px"
    style:max-height="min(460px, calc(100vh - 32px))"
    onmouseenter={() => brief.keepPeek()}
    onmouseleave={() => brief.hidePeekSoon()}
  >
    {#if p.content.sample}<div class="sample" data-testid="brief-sample">Sample · no live source yet</div>{/if}
    {#if p.content.eyebrow || p.content.origin}
      <div class="head">
        {#if p.content.eyebrow}<span class="eyebrow" data-testid="brief-peek-eyebrow">{p.content.eyebrow}</span>{/if}
        {#if p.content.origin}
          {@const co = brief.company(p.content.origin.companyUid)}
          <span class="ochip" data-testid="brief-peek-origin">
            {#if co || p.content.origin.companyUid}<BriefLogo company={co} fallback={p.content.origin.companyUid} size={16} />{/if}
            <span>{co ? `${co.label} · ` : ""}{p.content.origin.label}</span>
          </span>
        {/if}
      </div>
    {/if}
    <div class="ttl">{p.content.title}</div>
    {#if p.content.status}<div class="st">{p.content.status}</div>{/if}
    {#each p.content.sections as s, i (i)}
      <div class="sec">
        {#if s.label}<div class="eyebrow {s.tone ? `tone-${s.tone}` : ''}">{s.label}</div>{/if}
        {#if s.text}<p>{s.text}</p>{/if}
        <!-- The full list: the card scrolls past its max height rather than folding into "+N more". -->
        {#each s.lines ?? [] as line, j (j)}
          <div class="li" data-testid="brief-peek-line">
            <div>{line.label}{#if line.tag}<i class="tag" data-testid="brief-peek-tag">{line.tag}</i>{/if}</div><span class="tone-{line.tone ?? 'neutral'}">{line.state}</span>
          </div>
          {#if line.prompt}
            {@const lp = line.prompt}
            <div class="pills small" data-testid="brief-peek-line-launch">
              <button type="button" class="pill go" onclick={() => void brief.start(lp.id, lp.text)}>Start in {engine.label}</button>
              <button type="button" class="pill" onclick={() => void copy(lp.text)}>Copy prompt</button>
            </div>
            {#if brief.notes[lp.id]}<div class="note" role="status">{brief.notes[lp.id]}</div>{/if}
          {/if}
        {/each}
      </div>
    {/each}
    {#if p.content.actions?.length}
      <div class="sec acts">
        {#each p.content.actions as a (a.label)}
          <button type="button" class="peek-act" data-testid={a.testid} onclick={a.run}>{a.label}</button>
        {/each}
      </div>
    {/if}
    {#if p.content.dms}
      {#key p.content.dms.uid}<BriefPeekDms {...p.content.dms} />{/key}
    {/if}
    {#if p.content.prompt && !p.content.dms}
      {@const pr = p.content.prompt}
      {#if p.content.compact}
        <div class="pills">
          <button type="button" class="pill go" data-testid="brief-peek-resume" onclick={() => void brief.start(pr.id, pr.text)}
            >{pr.verb ?? "Start"} in {engine.label}</button
          >
          <button type="button" class="pill" data-testid="brief-peek-copy" onclick={() => void copy(pr.text)}>{copied ? "Copied" : "Copy prompt"}</button>
        </div>
        {#if brief.notes[pr.id]}<div class="note" role="status">{brief.notes[pr.id]}</div>{/if}
      {:else}
        <div class="sec">
          <div class="eyebrow">Prompt</div>
          <div class="prompt" data-testid="brief-peek-prompt">{pr.text}</div>
          <div class="acts"><BriefLaunch id={pr.id} prompt={pr.text} /></div>
        </div>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .peek-act {
    all: unset;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    padding: 6px 14px;
    border-radius: 8px;
    color: var(--b-bg);
    background: rgb(var(--b-ink) / 0.92);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 8px;
  }
  /* The card's kind, in the shared label style: mono, all caps. */
  .head .eyebrow {
    white-space: nowrap;
    font-family: var(--b-code);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--b-t3);
  }
  .ochip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    font-size: 11px;
    color: var(--b-t2);
    white-space: nowrap;
  }
  .compact :global(.ttl) {
    font-size: 15px;
    line-height: 1.3;
  }
  /* Two equal buttons, 30px tall: the primary filled in page ink, Copy as a hairline outline. */
  .pills {
    display: flex;
    gap: 8px;
    margin-top: 14px;
  }
  .pill {
    all: unset;
    box-sizing: border-box;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 1;
    height: 30px;
    padding: 0 12px;
    font-size: 13px;
    font-weight: 500;
    white-space: nowrap;
    border-radius: 8px;
    color: var(--b-t1, #fff);
    box-shadow: inset 0 0 0 1px rgb(var(--b-ink) / 0.14);
    transition: background 0.15s;
  }
  .pill:hover {
    background: rgb(var(--b-ink) / 0.05);
  }
  .pill.go {
    color: var(--b-bg);
    background: rgb(var(--b-ink) / 0.92);
    box-shadow: none;
  }
  .pill.go:hover {
    background: rgb(var(--b-ink) / 0.8);
  }
  .pill:focus-visible {
    outline: 2px solid var(--b-sun, #ffb580);
    outline-offset: 2px;
  }
  .pills.small {
    margin: 4px 0 6px;
  }
  .pills.small .pill {
    flex: none;
    height: 24px;
    font-size: 11px;
    padding: 0 10px;
  }
  /* The shared highlight label (terracotta, white, fully rounded). */
  .tag {
    margin-left: 6px;
    padding: 2px 8px;
    border-radius: 999px;
    font-family: var(--b-ui);
    font-size: 11px;
    font-style: normal;
    letter-spacing: 0;
    color: var(--b-on-hot, #fff);
    background: var(--b-hot, #c9765a);
  }
  .note {
    margin-top: 8px;
    font-size: 13px;
    color: var(--b-t2);
  }
</style>

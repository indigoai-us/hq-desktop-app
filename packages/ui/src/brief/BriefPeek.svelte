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

  const PEEK_MAX_LINES = 5;
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
        <div class="eyebrow {s.tone ? `tone-${s.tone}` : ''}">{s.label}</div>
        {#if s.text}<p>{s.text}</p>{/if}
        <!-- Never more than five lines: past that a list stops being readable. -->
        {#each (s.lines ?? []).slice(0, PEEK_MAX_LINES) as line, j (j)}
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
        {#if (s.lines?.length ?? 0) > PEEK_MAX_LINES}<div class="more">+{s.lines!.length - PEEK_MAX_LINES} more</div>{/if}
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
  .more {
    margin-top: 6px;
    font-size: 13px;
    color: var(--b-t3);
  }
  .peek-act {
    all: unset;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    padding: 6px 14px;
    border-radius: 8px;
    color: #1b1b1e;
    background: rgb(var(--b-ink) / 0.92);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 8px;
  }
  .head .eyebrow {
    white-space: nowrap;
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
    font-size: 20px;
  }
  .pills {
    display: flex;
    gap: 8px;
    margin-top: 14px;
  }
  .pill {
    all: unset;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    padding: 7px 14px;
    border-radius: 999px;
    color: var(--b-t1, #fff);
    box-shadow: inset 0 0 0 1px rgb(var(--b-ink) / 0.18);
  }
  .pill.go {
    color: #1b1b1e;
    background: rgb(var(--b-ink) / 0.92);
    box-shadow: none;
  }
  .pill:focus-visible {
    outline: 2px solid var(--b-sun, #ffb580);
    outline-offset: 2px;
  }
  .pills.small {
    margin: 4px 0 6px;
  }
  .pills.small .pill {
    font-size: 11px;
    padding: 4px 11px;
  }
  .tag {
    margin-left: 6px;
    padding: 0 6px;
    border-radius: 999px;
    font-family: var(--b-mono);
    font-size: 11px;
    font-style: normal;
    letter-spacing: 0;
    color: #1b1b1e;
    background: var(--b-sun, #ffb580);
  }
  .note {
    margin-top: 8px;
    font-size: 13px;
    color: var(--b-t2);
  }
</style>

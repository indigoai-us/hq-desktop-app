<script lang="ts">
  /** The detail card beside whatever is hovered. Actionable items show the full prompt before launch. */
  import BriefLaunch from "./BriefLaunch.svelte";
  import { useBrief } from "./brief-context.svelte.js";

  const brief = useBrief();
</script>

{#if brief.peek}
  {@const p = brief.peek}
  <div
    class="peek {p.side}"
    role="dialog"
    tabindex="-1"
    aria-label={p.content.title}
    data-testid="brief-peek"
    style:left="{p.x}px"
    style:top="{p.y}px"
    onmouseenter={() => brief.keepPeek()}
    onmouseleave={() => brief.hidePeekSoon()}
  >
    <div class="ttl">{p.content.title}</div>
    {#if p.content.status}<div class="st">{p.content.status}</div>{/if}
    {#each p.content.sections as s, i (i)}
      <div class="sec">
        <div class="eyebrow {s.tone ? `tone-${s.tone}` : ''}">{s.label}</div>
        {#if s.text}<p>{s.text}</p>{/if}
        {#each s.lines ?? [] as line, j (j)}
          <div class="li">{line.label}<span class="tone-{line.tone ?? 'neutral'}">{line.state}</span></div>
        {/each}
      </div>
    {/each}
    {#if p.content.prompt}
      <div class="sec">
        <div class="eyebrow">Prompt</div>
        <div class="prompt" data-testid="brief-peek-prompt">{p.content.prompt.text}</div>
        <div class="acts"><BriefLaunch id={p.content.prompt.id} prompt={p.content.prompt.text} /></div>
      </div>
    {/if}
  </div>
{/if}

<script lang="ts">
  // US-025: shimmer placeholder timeline — deterministic row shapes (no
  // randomness) so screenshots are stable, buzz-style varied line widths.
  import Skeleton from './Skeleton.svelte';

  interface Props {
    rows?: number;
  }

  let { rows = 6 }: Props = $props();

  // Deterministic width recipe per row index (author, then body lines).
  const SHAPES = [
    { author: '112px', lines: ['92%', '61%'] },
    { author: '88px', lines: ['74%'] },
    { author: '128px', lines: ['96%', '83%', '38%'] },
    { author: '96px', lines: ['52%'] },
    { author: '120px', lines: ['88%', '69%'] },
    { author: '84px', lines: ['79%', '31%'] },
  ] as const;

  const shapes = $derived(
    Array.from({ length: rows }, (_, i) => SHAPES[i % SHAPES.length]!),
  );
</script>

<div class="ws-timeline-skeleton" data-testid="ws-timeline-skeleton" aria-label="Loading messages">
  {#each shapes as shape, index (index)}
    <div class="row">
      <Skeleton width="28px" height="28px" radius="50%" />
      <div class="lines">
        <Skeleton width={shape.author} height="11px" />
        {#each shape.lines as line, lineIndex (lineIndex)}
          <Skeleton width={line} height="11px" />
        {/each}
      </div>
    </div>
  {/each}
</div>

<style>
  .ws-timeline-skeleton {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-5);
    padding: var(--v4-space-5) var(--v4-space-4);
  }

  .row {
    display: flex;
    gap: var(--v4-space-3);
    align-items: flex-start;
  }

  .lines {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding-top: 2px;
  }
</style>

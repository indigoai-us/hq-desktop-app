<script lang="ts">
  /**
   * Repos a project's PRD declares, plus its working branch, as compact
   * chips. Two repo chips at most, then "+N"; the full list is in the title.
   */
  import { repoChips } from "./project-card.js";

  let {
    repos = [],
    branch = null,
  }: { repos?: readonly string[]; branch?: string | null } = $props();

  const chips = $derived(repoChips(repos));
</script>

{#if chips.shown.length > 0 || branch}
  <span class="repo-chips" data-testid="project-repo-chips">
    {#each chips.shown as repo (repo)}
      <span class="repo-chip" title={`Repo: ${repo}`}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M4 2.5h7.5v9H5a1 1 0 0 0-1 1m0-10v10m0 0a1 1 0 0 0 1 1h6.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span class="repo-text">{repo}</span>
      </span>
    {/each}
    {#if chips.more > 0}
      <span class="repo-chip more" title={chips.all.join(", ")}>+{chips.more}</span>
    {/if}
    {#if branch}
      <span class="repo-chip branch" title={`Branch: ${branch}`} data-testid="project-branch">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="5" cy="4" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3" />
          <circle cx="5" cy="12" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3" />
          <circle cx="11" cy="6" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3" />
          <path d="M5 5.6v4.8M11 7.6c0 2-2.5 2.2-5.4 3.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        </svg>
        <span class="repo-text">{branch}</span>
      </span>
    {/if}
  </span>
{/if}

<style>
  .repo-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    min-width: 0;
  }

  .repo-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    min-width: 0;
    height: 20px;
    padding: 0 6px;
    border: 1px solid var(--v4-hairline);
    border-radius: 5px;
    background: transparent;
    color: var(--v4-text-2);
    font-size: 13px;
    line-height: 1;
  }

  .repo-chip svg {
    flex: 0 0 auto;
    width: 11px;
    height: 11px;
    color: var(--v4-text-3);
  }

  .repo-chip.more,
  .repo-chip.branch {
    color: var(--v4-text-3);
  }

  .repo-chip.branch {
    max-width: 160px;
  }

  .repo-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

<script lang="ts">
  /** First view, the focus slot: the latest threads found and the most active projects. */
  import type { FirstViewProject, FirstViewWork } from "./brief-first-view.js";
  import { firstViewAgo } from "./brief-first-view-copy.js";

  interface Props {
    recent: readonly FirstViewWork[];
    projects: readonly FirstViewProject[];
    now: Date;
  }
  let { recent, projects, now }: Props = $props();
  const shownProjects = $derived(projects.filter((p) => p.name).slice(0, 3));
</script>

<div class="w fv-card" data-testid="first-view-recent">
  <div class="fv-focus" class:solo={!shownProjects.length}>
    <ul class="fv-rows">
      {#each recent as r, i (`${r.title}-${i}`)}
        <li class="fv-row" data-testid="first-view-recent-row">
          <span class="fv-rt"><b>{r.title}</b><span>{[r.project, r.tool].filter(Boolean).join(" · ")}</span></span>
          <span class="fv-when">{firstViewAgo(r.at, now)}</span>
        </li>
      {/each}
    </ul>
    {#if shownProjects.length}
      <div class="fv-proj" data-testid="first-view-projects">
        <div class="fv-sub">Most active projects</div>
        {#each shownProjects as p (p.name)}
          <div class="fv-prow"><span>{p.name}</span>{#if p.sessions}<b>{p.sessions}</b><span class="fv-unit">sessions</span>{/if}</div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .fv-card {
    padding-top: 48px;
    container-type: inline-size;
  }
  .fv-focus {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(160px, 230px);
    gap: 16px;
  }
  .fv-focus.solo {
    grid-template-columns: minmax(0, 1fr);
  }
  .fv-rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .fv-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 5px 10px;
    border-radius: 8px;
    background: var(--b-row-bg, rgba(255, 255, 255, 0.14));
    border: 1px solid var(--b-row-line, rgba(255, 255, 255, 0.2));
    min-width: 0;
  }
  .fv-rt {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .fv-rt b {
    font-weight: 500;
    font-size: 12.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fv-rt span {
    font-size: 11px;
    color: var(--b-t3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .fv-when {
    flex: none;
    font-size: 11px;
    color: var(--b-t3);
  }
  .fv-sub {
    font-size: 11px;
    color: var(--b-t3);
    margin-bottom: 8px;
  }
  .fv-prow {
    display: flex;
    align-items: baseline;
    gap: 6px;
    padding: 8px 0;
    border-top: 1px solid var(--b-line);
  }
  .fv-prow span:first-child {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fv-prow b {
    font-size: 20px;
    font-weight: 400;
    letter-spacing: -0.02em;
  }
  .fv-unit {
    font-size: 11px;
    color: var(--b-t3);
  }
  @container (max-width: 520px) {
    .fv-focus {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>

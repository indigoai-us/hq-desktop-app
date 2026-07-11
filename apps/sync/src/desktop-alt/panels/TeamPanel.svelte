<script lang="ts">
  /**
   * TeamPanel — company Team tab: humans vs agents, top skills, active projects.
   * Loads via Tauri `get_company_team_telemetry` (hq-pro company telemetry).
   */
  import { invoke } from '@tauri-apps/api/core';
  import {
    defaultTelemetryRange,
    normalizeCompanyTeamTelemetry,
    teamTelemetryErrorMessage,
    type TeamMember,
    type TeamTelemetryView,
  } from '../lib/team-telemetry';
  import '../v4/tokens.css';

  interface Props {
    slug: string;
  }

  let { slug }: Props = $props();

  let loading = $state(true);
  let view = $state<TeamTelemetryView>({
    humans: [],
    agents: [],
    error: null,
    empty: true,
  });

  $effect(() => {
    const activeSlug = slug;
    loading = true;
    view = { humans: [], agents: [], error: null, empty: true };
    if (!activeSlug) {
      loading = false;
      return;
    }

    let cancelled = false;
    const range = defaultTelemetryRange(30);

    void (async () => {
      try {
        const raw = await invoke<unknown>('get_company_team_telemetry', {
          slug: activeSlug,
          from: range.from,
          to: range.to,
        });
        if (cancelled) return;
        view = normalizeCompanyTeamTelemetry(raw);
      } catch (err) {
        if (cancelled) return;
        console.error('get_company_team_telemetry failed:', err);
        view = {
          humans: [],
          agents: [],
          error: teamTelemetryErrorMessage(err),
          empty: true,
        };
      } finally {
        if (!cancelled) loading = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  });
</script>

<section class="team-panel" aria-label="Team" data-testid="company-team-panel">
  <header class="team-header">
    <h2>Team</h2>
    <p class="team-meta">Last 30 days · agents vs humans · top skills</p>
  </header>

  {#if loading}
    <p class="team-status" data-testid="team-loading">Loading team…</p>
  {:else if view.error}
    <p class="team-error" role="alert" data-testid="team-error">{view.error}</p>
  {:else if view.empty}
    <p class="team-status" data-testid="team-empty">
      No team telemetry yet for this company. Usage appears after members work with HQ.
    </p>
  {:else}
    <div class="team-sections">
      <section class="team-section" data-testid="team-humans" aria-labelledby="team-humans-title">
        <h3 id="team-humans-title">
          Humans <span class="count">{view.humans.length}</span>
        </h3>
        {#if view.humans.length === 0}
          <p class="team-status subtle">No human activity in this window.</p>
        {:else}
          <ul class="member-list">
            {#each view.humans as member (member.id)}
              {@render memberRow(member)}
            {/each}
          </ul>
        {/if}
      </section>

      <section class="team-section" data-testid="team-agents" aria-labelledby="team-agents-title">
        <h3 id="team-agents-title">
          Agents <span class="count">{view.agents.length}</span>
        </h3>
        {#if view.agents.length === 0}
          <p class="team-status subtle">No agent activity in this window.</p>
        {:else}
          <ul class="member-list">
            {#each view.agents as member (member.id)}
              {@render memberRow(member)}
            {/each}
          </ul>
        {/if}
      </section>
    </div>
  {/if}
</section>

{#snippet memberRow(member: TeamMember)}
  <li class="member-row" data-kind={member.kind} data-testid="team-member">
    <div class="member-main">
      <span class="member-name">{member.displayName}</span>
      <span class="kind-badge">{member.kind === 'agent' ? 'Agent' : 'Human'}</span>
    </div>
    {#if member.topSkills.length > 0}
      <div class="skills" data-testid="team-member-skills">
        {#each member.topSkills as skill (skill.skill)}
          <span class="skill-chip">{skill.skill} <span class="skill-n">{skill.count}</span></span>
        {/each}
      </div>
    {:else}
      <p class="team-status subtle">No skill usage recorded</p>
    {/if}
    {#if member.activeProjects.length > 0}
      <div class="projects" data-testid="team-member-projects">
        {#each member.activeProjects as project (project)}
          <span class="project-chip">{project}</span>
        {/each}
      </div>
    {/if}
  </li>
{/snippet}

<style>
  .team-panel {
    display: grid;
    gap: var(--v4-space-4, 16px);
    min-width: 0;
    font-family: var(--font-sans);
  }

  .team-header h2 {
    margin: 0;
    font-size: var(--text-lg, 15px);
    font-weight: 500;
    color: var(--v4-text-1, rgba(255, 255, 255, 0.92));
  }

  .team-meta {
    margin: 4px 0 0;
    font-size: 11px;
    color: var(--v4-text-3, rgba(255, 255, 255, 0.4));
  }

  .team-sections {
    display: grid;
    gap: var(--v4-space-5, 20px);
  }

  .team-section h3 {
    margin: 0 0 10px;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--v4-text-3, rgba(255, 255, 255, 0.4));
  }

  .count {
    font-variant-numeric: tabular-nums;
    opacity: 0.7;
  }

  .member-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0;
  }

  .member-row {
    padding: 12px 0;
    border-top: 1px solid var(--v4-hairline, rgba(255, 255, 255, 0.06));
    display: grid;
    gap: 8px;
  }

  .member-row:last-child {
    border-bottom: 1px solid var(--v4-hairline, rgba(255, 255, 255, 0.06));
  }

  .member-main {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .member-name {
    font-size: 13px;
    color: var(--v4-text-1, rgba(255, 255, 255, 0.92));
    font-weight: 500;
  }

  .kind-badge {
    font-size: 11px;
    color: var(--v4-text-3, rgba(255, 255, 255, 0.4));
    padding: 1px 6px;
    border: 1px solid var(--v4-hairline, rgba(255, 255, 255, 0.08));
    border-radius: 999px;
  }

  .skills,
  .projects {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .skill-chip,
  .project-chip {
    font-size: 11px;
    color: var(--v4-text-2, rgba(255, 255, 255, 0.6));
    padding: 2px 8px;
    background: var(--v4-raised, rgba(255, 255, 255, 0.03));
    border-radius: 6px;
  }

  .skill-n {
    opacity: 0.55;
    font-variant-numeric: tabular-nums;
    margin-left: 4px;
  }

  .team-status {
    margin: 0;
    font-size: 13px;
    color: var(--v4-text-2, rgba(255, 255, 255, 0.6));
  }

  .team-status.subtle {
    font-size: 11px;
    color: var(--v4-text-3, rgba(255, 255, 255, 0.4));
  }

  .team-error {
    margin: 0;
    font-size: 13px;
    color: var(--v4-error, #f87171);
  }
</style>

<script lang="ts">
  import type { KeyResult, Objective } from '../lib/local-projects';
  import './tokens.css';

  /**
   * Compact goal row for company Overview (DESKTOP-003).
   * Zero-progress with no linked projects explains "No linked work" instead of
   * empty decorative counts. Progress only from real KR values or linked
   * project acceptance — never invented.
   */
  interface Props {
    objective: Objective;
    progress: number;
    projectCount: number;
    storyCount: number;
  }

  let { objective, progress, projectCount, storyCount }: Props = $props();

  const status = $derived(goalStatus(objective.status));
  const krLine = $derived(keyResultLine(objective.keyResults));
  const title = $derived(objective.title || 'Untitled goal');
  const noLinkedWork = $derived(projectCount === 0);
  const footLabel = $derived(
    noLinkedWork
      ? 'No linked work'
      : `${projectCount} ${projectCount === 1 ? 'project' : 'projects'} · ${storyCount} ${
          storyCount === 1 ? 'story' : 'stories'
        } in flight`,
  );

  function goalStatus(raw: string): { label: string; tone: 'ok' | 'warn' | 'error' | 'idle' } {
    const normalized = raw.toLowerCase().replace(/[_\s]+/g, '-').trim();
    if (normalized === 'on-track' || normalized === 'active' || normalized === 'running') {
      return { label: 'ON TRACK', tone: 'ok' };
    }
    if (normalized === 'at-risk' || normalized === 'review') {
      return { label: 'AT RISK', tone: 'warn' };
    }
    if (normalized === 'off-track' || normalized === 'blocked') {
      return { label: 'OFF TRACK', tone: 'error' };
    }
    return { label: normalized ? normalized.replace(/-/g, ' ').toUpperCase() : 'NO STATUS', tone: 'idle' };
  }

  function valueText(value: number | string | null | undefined, unit: string | undefined): string {
    if (value == null || value === '') return '';
    return `${value}${unit ?? ''}`;
  }

  function keyResultLabel(kr: KeyResult): string {
    const name = kr.title || kr.metric || 'Key result';
    const current = valueText(kr.current, kr.unit);
    const target = valueText(kr.target, kr.unit);
    if (current && target) return `${name} ${current}->${target}`;
    if (target) return `${name} ->${target}`;
    return name;
  }

  function keyResultLine(results: KeyResult[]): string {
    const visible = results.map(keyResultLabel).filter(Boolean);
    if (visible.length > 0) return visible.slice(0, 3).join(' · ');
    return objective.description || '';
  }
</script>

<article class="goal-card" data-testid="goal-card" class:zero={noLinkedWork && progress === 0}>
  <header class="goal-top">
    <div class="goal-copy">
      <h3 class="goal-title">{title}</h3>
      {#if krLine}
        <p class="goal-kr">{krLine}</p>
      {/if}
    </div>
    <span class="goal-status">
      <span class={`status-dot ${status.tone}`} aria-hidden="true"></span>
      <span>{status.label}</span>
    </span>
  </header>

  <div class="goal-progress" aria-label={`${progress}% progress`}>
    <span class="progress-track" aria-hidden="true">
      <span class="progress-fill" style={`width: ${progress}%`}></span>
    </span>
  </div>

  <p class="goal-foot">
    <span data-testid="goal-linked-work">{footLabel}</span>
    <span class="goal-pct">{progress}%</span>
  </p>
</article>

<style>
  .goal-card {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 8px;
    padding: 10px 0 12px;
    border: 0;
    border-bottom: 1px solid var(--v4-rowline);
    border-radius: 0;
    background: transparent;
    color: var(--v4-text-1);
    font-family: var(--font-sans);
  }

  .goal-card:last-child {
    border-bottom: 0;
  }

  .goal-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
  }

  .goal-copy {
    display: grid;
    min-width: 0;
    flex: 1 1 auto;
    gap: var(--v4-row-stack-gap, 3px);
  }

  .goal-title {
    min-width: 0;
    margin: 0;
    overflow: hidden;
    color: var(--v4-text-1);
    font-size: var(--type-body, var(--text-base));
    font-weight: 500;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .goal-status {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 6px;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 400;
    line-height: 1.2;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .status-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
  }

  .status-dot.ok {
    background: var(--v4-ok);
  }

  .status-dot.warn {
    background: var(--v4-warn);
  }

  .status-dot.error {
    background: var(--v4-error);
  }

  .status-dot.idle {
    background: var(--v4-idle);
  }

  .goal-kr {
    margin: 0;
    overflow: hidden;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 400;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .goal-progress {
    min-width: 0;
  }

  .progress-track {
    display: block;
    height: 3px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--v4-control-faint);
  }

  .progress-fill {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--v4-text-2);
  }

  .goal-foot {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin: 0;
    color: var(--v4-text-3);
    font-size: var(--type-metadata, var(--text-micro));
    font-weight: 400;
    line-height: 1.25;
  }

  .goal-pct {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
  }
</style>

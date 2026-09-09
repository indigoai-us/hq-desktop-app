<script lang="ts">
  /**
   * The one piece of chrome the chat allows itself: a sub-40px strip.
   *
   * Left is a sidebar toggle (the session list is a DRAWER, not a permanent
   * column — a chat surface with a list glued to its side is the thing the
   * owner rejected). Centre names the session in the only two terms that
   * matter, company and model. Right is the policies chip (what HQ's hooks
   * have bound the session to), a "Hand off" action, a "⋯" session menu
   * (open in Claude Code / Codex, share to channel, end), and a phase dot.
   *
   * Presentation-pure: props in, callbacks out.
   */
  import { loadSessionStarter, type SessionStarter } from './session-starter';
  import PoliciesChip from './PoliciesChip.svelte';
  import SessionMenu from './SessionMenu.svelte';
  import type { HandoffState } from './hook-notices';
  import type { PolicyDigest } from './policy-digest';
  import type { SessionTool } from '../../desktop-alt/lib/live-session-store.svelte';

  interface Props {
    title: string;
    startedBy?: string | null;
    sourceTitle?: string | null;
    sourceSessionId?: string | null;
    onopensource?: () => void;
    /** 'idle' | 'working' | 'needs you' | 'ended' — already humanised. */
    phaseLabel?: string;
    phase?: 'starting' | 'idle' | 'working' | 'needsYou' | 'ended';
    drawerOpen?: boolean;
    /** Policies HQ's hooks reported; the chip stays hidden until one lands. */
    policies?: PolicyDigest | null;
    handoff?: HandoffState;
    /** The session's CLI — names the menu's "Open in …" item. */
    tool?: SessionTool;
    /** A live session is on screen, so the "⋯" menu has something to act on. */
    menuEnabled?: boolean;
    /** One quiet line beside the menu ("Opened in Terminal"); empty hides it. */
    menuResult?: string;
    /** The session's bound project (directory slug); hidden when unbound. */
    projectLabel?: string | null;
    /** The project has a channel, so the pill opens it. */
    projectLinked?: boolean;
    onopenproject?: () => void;
    ontoggledrawer?: () => void;
    /** Send `/handoff` on the live session. */
    onhandoff?: () => void;
    onopeninapp?: () => void;
    onshare?: () => void;
    onend?: () => void;
  }

  let {
    title,
    startedBy = null,
    sourceTitle = null,
    sourceSessionId = null,
    onopensource,
    phaseLabel = '',
    phase = 'idle',
    drawerOpen = false,
    policies = null,
    handoff = 'hidden',
    tool = 'claude',
    menuEnabled = false,
    menuResult = '',
    projectLabel = null,
    projectLinked = false,
    onopenproject,
    ontoggledrawer,
    onhandoff,
    onopeninapp,
    onshare,
    onend,
  }: Props = $props();
  let starter = $state<SessionStarter | null>(null);
  let failedAvatar = $state(false);
  $effect(() => {
    const identity = startedBy;
    starter = null;
    failedAvatar = false;
    let cancelled = false;
    if (identity) void loadSessionStarter(identity).then(value => {
      if (!cancelled) starter = value;
    });
    return () => { cancelled = true; };
  });
  const starterName = $derived(starter?.name || startedBy || 'Unknown');
  const starterDetails = $derived(['Started by ' + starterName, starter?.email !== starterName ? starter?.email : null, starter?.description].filter(Boolean).join('\n'));
  const initials = $derived(starterName === 'Unknown' ? '?' : starterName.split('@')[0].split(/[\s._-]+/).slice(0, 2).map(part => part[0]).join('').toUpperCase());
</script>

<header class="strip" data-testid="sessions-strip">
  <button
    type="button"
    class="strip-button"
    aria-label="Sessions"
    aria-expanded={drawerOpen}
    data-testid="sessions-drawer-toggle"
    onclick={() => ontoggledrawer?.()}
  >
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.6" y="2.6" width="12.8" height="10.8" rx="2" stroke="currentColor" stroke-width="1.1" />
      <path d="M6 2.8v10.4" stroke="currentColor" stroke-width="1.1" />
    </svg>
  </button>

  <div class="strip-center">
    <button type="button" class="starter-avatar" data-testid="session-starter" aria-label={starterDetails}>
      {#if starter?.avatarUrl && !failedAvatar}
        <img src={starter.avatarUrl} alt="" onerror={() => failedAvatar = true} />
      {:else}
        <span aria-hidden="true">{initials}</span>
      {/if}
      <span class="starter-tooltip" role="tooltip">{starterDetails}</span>
    </button>
    <h2 class="strip-title" data-testid="sessions-strip-title">{title}</h2>
    {#if sourceSessionId}
      <button class="strip-button source-link" type="button" data-testid="session-source" onclick={() => onopensource?.()} aria-label={`Open source session: ${sourceTitle || sourceSessionId}`} title={`Forked from ${sourceTitle || sourceSessionId}`}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="4" cy="3" r="2" stroke="currentColor"/><circle cx="12" cy="3" r="2" stroke="currentColor"/><circle cx="4" cy="13" r="2" stroke="currentColor"/><path d="M4 5v6m8-6c0 4-8 1-8 6" stroke="currentColor"/></svg>
      </button>
    {/if}
    {#if projectLabel}
      <!-- The bound project, as a pill beside the company. It opens the
           project's channel when one exists; otherwise it only informs. -->
      <button
        type="button"
        class="project-pill"
        data-testid="sessions-project-pill"
        data-linked={projectLinked ? 'true' : 'false'}
        disabled={!projectLinked}
        title={projectLinked ? `Open #p-${projectLabel}` : `Project ${projectLabel}`}
        onclick={() => onopenproject?.()}
      >
        project {projectLabel}
      </button>
    {/if}
  </div>

  <div class="strip-right">
    {#if policies}
      <PoliciesChip digest={policies} />
    {/if}
    {#if phaseLabel}
      <span class="phase" data-testid="sessions-phase" data-phase={phase}>
        <span class="dot" class:pulse={phase === 'working'} aria-hidden="true"></span>
        {phaseLabel}
      </span>
    {/if}
    {#if handoff !== 'hidden'}
      <button
        type="button"
        class="strip-button handoff"
        class:running={handoff === 'running'}
        aria-label="Hand off this session (⌘⇧H)"
        title="Hand off this session (⌘⇧H)"
        aria-busy={handoff === 'running' ? 'true' : undefined}
        disabled={handoff !== 'ready'}
        data-testid="session-handoff"
        data-state={handoff}
        onclick={() => onhandoff?.()}
      >
        {#if handoff === 'running'}
          <span class="spinner" aria-hidden="true"></span>
        {:else}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M6.5 3.2H3.4a1 1 0 0 0-1 1v8.4a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1V9.5"
              stroke="currentColor"
              stroke-width="1.1"
              stroke-linecap="round"
            />
            <path
              d="M9.2 2.4h4.4v4.4M13.6 2.4 7.6 8.4"
              stroke="currentColor"
              stroke-width="1.1"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        {/if}
        <span class="handoff-label">{handoff === 'running' ? 'Handing off…' : 'Hand off'}</span>
      </button>
    {/if}
    {#if menuResult}
      <span class="menu-result" role="status" data-testid="session-menu-result">{menuResult}</span>
    {/if}
    <SessionMenu
      {tool}
      disabled={!menuEnabled}
      {onopeninapp}
      {onshare}
      {onend}
    />

  </div>
</header>

<style>
  .strip {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    flex: none;
    height: 38px;
    padding: 0 var(--v4-space-2);
    border-bottom: 1px solid var(--v4-hairline);
    font-family: var(--font-sans);
  }

  .starter-avatar { position: relative; flex: none; width: 24px; height: 24px; border: 0; border-radius: 50%; padding: 0; background: var(--v4-active-row); color: var(--v4-text-2); font: 10px var(--font-sans); cursor: default; }
  .starter-avatar img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
  .starter-tooltip { display: none; position: absolute; top: calc(100% + 8px); left: 0; z-index: 50; width: max-content; max-width: 280px; padding: 8px 10px; border: 1px solid var(--v4-hairline); border-radius: 6px; background: var(--v4-bg, #182127); color: var(--v4-text-1); text-align: left; white-space: pre-line; font-size: 12px; line-height: 1.5; box-shadow: 0 4px 16px #0004; pointer-events: none; }
  .starter-avatar:hover .starter-tooltip, .starter-avatar:focus-visible .starter-tooltip { display: block; }
  .source-link { flex: none; }
  .strip-center {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--v4-space-2);
    flex: 1;
    min-width: 0;
  }

  .project-pill {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    height: 18px;
    padding: 0 7px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill, 999px);
    background: transparent;
    color: var(--v4-text-2);
    font-family: inherit;
    font-size: 10px;
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
  }

  .project-pill:hover:not(:disabled) {
    color: var(--v4-text-1);
    background: var(--v4-active-row);
  }

  .project-pill:disabled {
    cursor: default;
  }

  .strip-title {
    min-width: 0;
    margin: 0;
    text-align: center;
    font-size: var(--type-metadata);
    font-weight: 500;
    color: var(--v4-text-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .strip-right {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    flex: none;
  }

  .strip-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 24px;
    height: 24px;
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-3);
    cursor: pointer;
  }

  .strip-button:hover {
    color: var(--v4-text-1);
    background: var(--v4-active-row);
  }

  /* "Hand off": an icon that grows its label on hover or focus, so the strip
     stays quiet until the operator reaches for it. */
  .handoff {
    width: auto;
    gap: 5px;
    padding: 0 5px;
    font-family: inherit;
    font-size: 11px;
    line-height: 1;
  }

  .handoff-label {
    display: none;
    white-space: nowrap;
  }

  .handoff:hover .handoff-label,
  .handoff:focus-visible .handoff-label,
  .handoff.running .handoff-label {
    display: inline;
  }

  .handoff:disabled {
    cursor: default;
    opacity: 0.45;
  }

  .handoff:disabled:hover {
    color: var(--v4-text-3);
    background: transparent;
  }

  .handoff.running:disabled {
    opacity: 1;
    color: var(--v4-text-2);
  }

  .spinner {
    width: 11px;
    height: 11px;
    border: 1.5px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: handoff-spin 0.8s linear infinite;
  }

  @keyframes handoff-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .phase {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: var(--v4-text-3);
  }

  /* "Opened in Terminal" — the menu's one-line receipt, gone on the next action. */
  .menu-result {
    max-width: 220px;
    font-size: 11px;
    color: var(--v4-text-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--v4-text-3);
  }

  .phase[data-phase='working'] .dot,
  .phase[data-phase='needsYou'] .dot {
    background: var(--v4-text-1);
  }

  .dot.pulse {
    animation: phase-pulse 1.4s ease-in-out infinite;
  }

  @keyframes phase-pulse {
    50% {
      opacity: 0.3;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .dot.pulse,
    .spinner {
      animation: none;
    }
  }
</style>

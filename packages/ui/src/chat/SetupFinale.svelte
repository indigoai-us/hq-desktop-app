<script lang="ts">
  /**
   * SetupFinale — the one calm block under the Setup Agent's last message
   * once the run is done. Top to bottom: a thin divider, "You're set up",
   * the three "Continue in …" actions, the Learn-HQ links, the quiet
   * Run again / Open setup chat row, and (when the shell has any) the
   * First Moves list. No box, no background: it sits in the message text
   * column like a reply, and eases in (a 220ms fade with a 6px rise, as a
   * CSS keyframe: the test DOM has no Web Animations API for svelte/transition).
   * Presentational; every action goes back up.
   */
  import SetupButton from "./SetupButton.svelte";
  import FirstMoves from "./FirstMoves.svelte";
  import { SETUP_RESOURCES } from "./setup-channel";
  import { SETUP_RESOURCE_GLYPHS } from "./setup-resource-glyphs";
  import type { FirstMove, FirstMoveId } from "./first-moves";

  const SETUP_FINALE_TITLE = "You're set up";
  const SETUP_FINALE_LEAD = "Pick where to keep going — each opens a fresh chat with your first task ready.";

  interface Props {
    /** Continue in HQ Sessions; the button is hidden when the host has no Sessions page. */
    onsessions?: () => void;
    onclaude: () => void;
    oncodex: () => void;
    /** A launch failure, in plain words, under the action row. */
    launchError?: string | null;
    /** Open a Learn-HQ link via the host (system browser). */
    onopenurl?: (url: string) => void;
    /** "Open setup chat": the underlying session on the Sessions page. */
    onshowdetails?: () => void;
    onrunagain?: () => void;
    /** The shell's self-ticking first moves; omitted/empty → nothing renders. */
    firstMoves?: readonly FirstMove[] | null;
    onmove?: (id: FirstMoveId) => Promise<string | null | void> | string | null | void;
    /** The coding-tools first move's Codex button. */
    onmovecodex?: () => Promise<string | null | void> | string | null | void;
  }

  let {
    onsessions,
    onclaude,
    oncodex,
    launchError = null,
    onopenurl,
    onshowdetails,
    onrunagain,
    firstMoves = null,
    onmove,
    onmovecodex,
  }: Props = $props();

  /** External links never navigate the webview: only http(s) goes to the host. */
  function openResourceLink(event: MouseEvent, href: string): void {
    event.preventDefault();
    if (!/^https?:/i.test(href)) return;
    onopenurl?.(href);
  }

  const hasQuietRow = $derived(Boolean(onshowdetails || onrunagain));
  const hasMoves = $derived(Boolean(firstMoves && firstMoves.length > 0 && onmove));
</script>

<div
  class="setup-finale"
  data-testid="setup-agent-finish"
  role="group"
  aria-label={SETUP_FINALE_TITLE}
>
  <div class="finale-inner">
    <hr class="divider" aria-hidden="true" />

    <div class="title-row">
      <svg
        class="check"
        viewBox="0 0 16 16"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
      </svg>
      <h3 class="title" data-testid="setup-finale-title">{SETUP_FINALE_TITLE}</h3>
    </div>
    <p class="lead">{SETUP_FINALE_LEAD}</p>

    <div class="actions" role="group" aria-label="Keep going">
      {#if onsessions}
        <SetupButton variant="primary" data-testid="setup-agent-open-sessions" onclick={() => onsessions?.()}>
          Continue in HQ Sessions
        </SetupButton>
      {/if}
      <SetupButton variant="primary" data-testid="setup-agent-open-claude" onclick={() => onclaude()}>
        Continue in Claude Code
      </SetupButton>
      <SetupButton variant="primary" data-testid="setup-agent-open-codex" onclick={() => oncodex()}>
        Continue in Codex
      </SetupButton>
    </div>
    {#if launchError}
      <p class="launch-error" role="alert" data-testid="setup-finale-error">{launchError}</p>
    {/if}

    <div class="learn">
      <span class="eyebrow">Learn HQ</span>
      <ul class="resources" aria-label="Learn HQ">
        {#each SETUP_RESOURCES as resource (resource.id)}
          <li>
            <a
              class="resource-link"
              href={resource.href}
              target="_blank"
              rel="noopener noreferrer"
              data-testid={`setup-finale-resource-${resource.id}`}
              onclick={(event) => openResourceLink(event, resource.href)}
            >
              <svg
                class="resource-glyph"
                viewBox="0 0 16 16"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                stroke-width="1.25"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                {@html SETUP_RESOURCE_GLYPHS[resource.kind]}
              </svg>
              <span>{resource.title}</span>
            </a>
          </li>
        {/each}
      </ul>
    </div>

    {#if hasQuietRow}
      <div class="quiet-row">
        {#if onshowdetails}
          <SetupButton variant="quiet" data-testid="setup-run-details" onclick={() => onshowdetails?.()}>
            Open setup chat
          </SetupButton>
        {/if}
        {#if onrunagain}
          <SetupButton variant="quiet" data-testid="setup-run-again" onclick={() => onrunagain?.()}>
            Run again
          </SetupButton>
        {/if}
      </div>
    {/if}

    {#if hasMoves}
      <div class="moves">
        <FirstMoves moves={firstMoves!} onmove={onmove!} oncodex={onmovecodex} />
      </div>
    {/if}
  </div>
</div>

<style>
  .setup-finale {
    max-width: 760px;
    color: var(--text-1, inherit);
    animation: finale-enter 220ms ease-out both;
  }
  @keyframes finale-enter {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  .finale-inner {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .divider {
    margin: 16px 0 0;
    border: 0;
    border-top: 1px solid var(--border);
  }
  .title-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .check {
    flex: 0 0 auto;
    color: var(--text-1, inherit);
  }
  .title {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    line-height: 1.3;
    color: var(--text-1, inherit);
  }
  .lead {
    margin: -6px 0 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-2, inherit);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .launch-error {
    margin: -4px 0 0;
    font-size: 12px;
    line-height: 1.4;
    color: var(--danger, #d9534f);
  }
  .learn {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .eyebrow {
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-3, inherit);
  }
  .resources {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 16px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .resource-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    line-height: 1.4;
    color: var(--text-2, inherit);
    text-decoration: none;
    transition: color 140ms ease;
  }
  .resource-link:hover,
  .resource-link:focus-visible {
    color: var(--text-1, inherit);
  }
  .resource-link:focus-visible {
    outline: 2px solid var(--text-1, currentColor);
    outline-offset: 2px;
  }
  .resource-glyph {
    flex: 0 0 auto;
  }
  .quiet-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-left: -12px; /* quiet buttons carry 12px side padding; keep the text on the column. */
  }
  .moves {
    margin-top: 4px; /* 12px rhythm + 4px = 16px above the list. */
  }
  @media (prefers-reduced-motion: reduce) {
    .setup-finale {
      animation: none;
    }
    .resource-link {
      transition: none;
    }
  }
</style>

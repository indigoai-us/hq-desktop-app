<script lang="ts">
  /**
   * SetupFinale — the end of setup under the Setup Agent's last message:
   * a wallpaper banner (the same art and scrim as the #welcome hero) that
   * says it's done, the three "Continue in …" actions, the Learn-HQ links
   * and the quiet Run again / Open setup chat row; then, on the surface
   * below it, the First Moves list. One column, one rhythm. Eases in with a
   * CSS keyframe (the test DOM has no Web Animations API for
   * svelte/transition). Presentational; every action goes back up.
   */
  import SetupButton from "./SetupButton.svelte";
  import FirstMoves from "./FirstMoves.svelte";
  import { SETUP_RESOURCES } from "./setup-channel";
  import { SETUP_HERO_ART } from "./setup-welcome-art";
  import { SETUP_RESOURCE_GLYPHS } from "./setup-resource-glyphs";
  import type { FirstMove, FirstMoveId } from "./first-moves";

  const SETUP_FINALE_EYEBROW = "Setup complete";
  const SETUP_FINALE_TITLE = "You're set up.";
  const SETUP_FINALE_LEAD = "Pick where to keep going. Each opens a fresh chat with your first task ready.";

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

<section
  class="setup-finale"
  data-testid="setup-agent-finish"
  role="group"
  aria-label={SETUP_FINALE_TITLE}
>
  <div class="banner">
    <img class="art art--light" src={SETUP_HERO_ART.light} alt="" aria-hidden="true" decoding="async" draggable="false" />
    <img class="art art--dark" src={SETUP_HERO_ART.dark} alt="" aria-hidden="true" decoding="async" draggable="false" />
    <div class="scrim" aria-hidden="true"></div>

    <div class="copy">
      <div class="heading">
        <span class="eyebrow">{SETUP_FINALE_EYEBROW}</span>
        <h3 class="title" data-testid="setup-finale-title">{SETUP_FINALE_TITLE}</h3>
        <p class="lead">{SETUP_FINALE_LEAD}</p>
      </div>

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
        <span class="eyebrow eyebrow--small">Learn HQ</span>
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
    </div>
  </div>

  {#if hasMoves}
    <div class="moves">
      <FirstMoves moves={firstMoves!} onmove={onmove!} oncodex={onmovecodex} />
    </div>
  {/if}
</section>

<style>
  .setup-finale {
    display: flex;
    flex-direction: column;
    gap: 24px;
    max-width: 760px;
    animation: finale-enter 240ms ease-out both;
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

  /* ---- The banner: same art, scrim and white-on-dark buttons as the hero. */
  .banner {
    position: relative;
    isolation: isolate;
    overflow: hidden;
    border-radius: 14px;
    background: #0a0b0d;
    color: #ffffff;
    --text-1: #ffffff;
    --text-2: rgba(255, 255, 255, 0.82);
    --text-3: rgba(255, 255, 255, 0.62);
    --setup-btn-fg: #fff;
    --setup-btn-line: rgba(255, 255, 255, 0.6);
    --setup-btn-primary-bg: #fff;
    --setup-btn-primary-fg: #111;
    --setup-btn-muted: rgba(255, 255, 255, 0.78);
    --setup-btn-hover: rgba(255, 255, 255, 0.14);
  }
  .art {
    position: absolute;
    inset: 0;
    z-index: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center 40%;
    user-select: none;
    pointer-events: none;
  }
  .art--dark {
    display: none;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-force-theme="light"])) .art--dark {
      display: block;
    }
    :global(:root:not([data-force-theme="light"])) .art--light {
      display: none;
    }
  }
  :global(:root[data-force-theme="dark"]) .art--dark {
    display: block;
  }
  :global(:root[data-force-theme="dark"]) .art--light {
    display: none;
  }
  .scrim {
    position: absolute;
    inset: 0;
    z-index: 1;
    background:
      linear-gradient(180deg, rgba(6, 6, 6, 0.18) 0%, rgba(6, 6, 6, 0.5) 45%, rgba(6, 6, 6, 0.88) 100%),
      linear-gradient(90deg, rgba(6, 6, 6, 0.5) 0%, rgba(6, 6, 6, 0) 70%);
  }
  .copy {
    position: relative;
    z-index: 2;
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding: 28px 28px 24px;
  }
  .heading {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .eyebrow {
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-3);
  }
  .title {
    margin: 0;
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1.2;
    color: var(--text-1);
  }
  .lead {
    margin: 0;
    max-width: 56ch;
    font-size: 13px;
    line-height: 1.5;
    color: var(--text-2);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .launch-error {
    margin: -12px 0 0;
    font-size: 12px;
    line-height: 1.4;
    color: #ffb4ad;
  }
  .learn {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-top: 16px;
    border-top: 1px solid rgba(255, 255, 255, 0.18);
  }
  .eyebrow--small {
    letter-spacing: 0.1em;
  }
  .resources {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 20px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .resource-link {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: 13px;
    line-height: 1.4;
    color: var(--text-2);
    text-decoration: none;
    transition: color 140ms ease;
  }
  .resource-link:hover,
  .resource-link:focus-visible {
    color: var(--text-1);
  }
  .resource-link:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }
  .resource-glyph {
    flex: 0 0 auto;
    opacity: 0.85;
  }
  .quiet-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: -8px 0 0 -6px; /* quiet buttons carry 6px side padding: keep the text on the column. */
  }

  /* ---- First moves sit on the surface below the banner, same column. */
  .moves {
    padding: 0 2px;
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

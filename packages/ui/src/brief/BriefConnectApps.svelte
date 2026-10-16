<script lang="ts">
  /**
   * "Connect your AI apps" as a full-width brief card: the AI apps found on
   * this computer as glass tiles, each with its brand mark, the same help,
   * steps and Copy button as Settings → AI tools (CONNECTOR_APPS and
   * copyConnectorSetup). Left out when nothing matches.
   *
   * Shown inside the welcome report: in the brief body after the action
   * cards, and under the status card while the report is held, loading or
   * waiting on setup. The card carries its own copy of the brief's card
   * recipe (brief.css is scoped to `.daily-brief`), so it looks the same in
   * both places.
   *
   * The AI apps are one group (`.group`). Below them, in the same card, the
   * suggested integrations (BriefSuggestedApps): the work apps the same scan
   * found, a row per app with a Connect action. One detect() feeds both,
   * held in the owner's connect session so a remount does not scan again.
   */
  import { onDestroy, onMount, untrack } from "svelte";
  import type { FoundWorkApps } from "@hq/platform";
  import { copyConnectorSetup, foundConnectorApps, type ConnectorApp } from "../settings/hq-connector-setup.js";
  import { BRAND_ICONS, type BrandIconName } from "../common/button/rail-icons.js";
  import { matchFoundApps } from "../chat/first-run/found-apps.js";
  import { YOUR_APPS_COPY } from "../chat/first-run/your-apps.js";
  import BriefSuggestedApps from "./BriefSuggestedApps.svelte";
  import type { WelcomeSuggest } from "./welcome-ai-apps.js";
  import { WelcomeConnectSession } from "./welcome-connect-session.svelte.js";

  interface Props {
    /** The launch scan (names only). */
    detect: () => Promise<FoundWorkApps | null>;
    /** Claude Code and the Codex CLI, as the launch detection found them. */
    cli: { claudeCode: boolean; codex: boolean };
    /** The suggested integrations; null or missing leaves that group out. */
    suggest?: WelcomeSuggest | null;
    /** The owner's connect session; without one the card keeps its own while mounted. */
    session?: WelcomeConnectSession | null;
  }
  let { detect, cli, suggest = null, session: given = null }: Props = $props();

  /** The brand mark per app: Claude and Claude Code share the Claude mark, ChatGPT and Codex the OpenAI mark. */
  const MARK: Record<ConnectorApp["id"], BrandIconName> = {
    claude: "claude-code",
    "claude-code": "claude-code",
    chatgpt: "codex",
    codex: "codex",
    "grok-bot": "grok",
    grok: "grok",
  };

  const local = untrack(() => given) ? null : new WelcomeConnectSession();
  const session = $derived(given ?? (local as WelcomeConnectSession));
  onDestroy(() => {
    local?.dispose();
    clearTimeout(copyTimer);
  });
  onMount(() => session.detectOnce(detect));

  const scan = $derived<FoundWorkApps | null>(session.scan);

  const apps = $derived(foundConnectorApps(scan?.apps ?? [], cli));
  const matched = $derived(matchFoundApps(scan));
  const suggesting = $derived(suggest !== null && matched.apps.some((app) => !app.excluded));

  let copiedId = $state<string | null>(null);
  let copyFailedId = $state<string | null>(null);
  let copyTimer: ReturnType<typeof setTimeout> | undefined;

  async function copy(app: ConnectorApp): Promise<void> {
    clearTimeout(copyTimer);
    copiedId = null;
    copyFailedId = null;
    if (await copyConnectorSetup(app.copyText)) {
      copiedId = app.id;
      copyTimer = setTimeout(() => (copiedId = null), 1500);
    } else {
      copyFailedId = app.id;
    }
  }
</script>

{#if apps.length || suggesting}
  <section class="connect" data-testid="connect-ai-apps-card">
    {#if apps.length}
    <h2 class="eyebrow">Connect your AI apps</h2>
    <h3>Let the apps you already use read and write your HQ.</h3>
    <div class="group" data-group="ai-apps">
      <ul class="tiles">
        {#each apps as app (app.id)}
          {@const mark = BRAND_ICONS[MARK[app.id]]}
          <li class="tile" data-testid={`connect-ai-app-${app.id}`}>
            <div class="top">
              <span class="logo" aria-hidden="true">
                <svg class="mark" class:clay={mark.fill === "clay"} viewBox={mark.viewBox} width="18" height="18"><path fill-rule="evenodd" d={mark.d} /></svg>
              </span>
              <span class="name">{app.name}</span>
              <button type="button" class:copied={copiedId === app.id} data-testid={`connect-ai-app-${app.id}-copy`} onclick={() => void copy(app)}>
                {copiedId === app.id ? "Copied" : app.copyLabel || "Copy"}
              </button>
            </div>
            <p class="help">{app.help}</p>
            {#if app.steps}
              <ol class="steps">
                {#each app.steps as step}<li>{step}</li>{/each}
              </ol>
            {/if}
            {#if copyFailedId === app.id}
              <pre class="manual" data-testid={`connect-ai-app-${app.id}-manual`}>{app.copyText}</pre>
              <p class="help" role="status">Copy didn't work. Select the text above, or tap the button to try again.</p>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
    {/if}
    {#if suggest && suggesting}
      <div class="group" class:next={apps.length > 0} data-group="suggested" data-testid="connect-suggested-apps">
        <h2 class="eyebrow">{YOUR_APPS_COPY.kicker}</h2>
        <h3>{YOUR_APPS_COPY.lead} {YOUR_APPS_COPY.em}</h3>
        <div class="rows-wrap"><BriefSuggestedApps scan={matched} {suggest} {session} /></div>
      </div>
    {/if}
  </section>
{/if}

<style>
  /* The brief's widget card (.daily-brief .w in brief.css), full width. */
  .connect {
    position: relative;
    margin-top: 14px;
    border-radius: var(--b-r, 22px);
    background: linear-gradient(155deg, var(--b-card-hi, #26262b), var(--b-card, #222226));
    box-shadow: var(
      --b-raise,
      -1px -1px 0 rgba(255, 255, 255, 0.035),
      -12px -12px 28px rgba(255, 255, 255, 0.022),
      2px 3px 4px rgba(0, 0, 0, 0.35),
      16px 22px 44px rgba(0, 0, 0, 0.6),
      inset 0 1px 0 rgba(255, 255, 255, 0.07),
      inset 0 -1px 0 rgba(0, 0, 0, 0.35)
    );
    padding: 18px 20px 20px;
    color: var(--b-t1, rgba(255, 255, 255, 0.95));
    font-family: var(--b-ui, var(--font-ui, "Geist", -apple-system, system-ui, sans-serif));
    font-size: 13px;
    line-height: 1.45;
    text-align: left;
    animation: in 0.9s cubic-bezier(0.2, 0.8, 0.2, 1) both;
  }
  .connect::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    pointer-events: none;
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.05);
  }
  @keyframes in {
    from {
      opacity: 0;
      transform: translateY(14px) scale(0.985);
    }
  }
  .eyebrow {
    margin: 0;
    font-family: var(--b-mono, var(--font-mono, "Geist Mono", ui-monospace, monospace));
    font-size: 10px;
    font-weight: 400;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--b-t3, rgba(255, 255, 255, 0.32));
  }
  h3 {
    margin: 8px 0 0;
    font-size: 15px;
    font-weight: 500;
    letter-spacing: -0.018em;
    line-height: 1.2;
  }
  .group {
    margin-top: 14px;
  }
  .connect > .group:first-child {
    margin-top: 0;
  }
  .rows-wrap {
    margin-top: 14px;
  }
  /* The second group sits under the AI apps with a hairline between them. */
  .group.next {
    margin-top: 18px;
    padding-top: 16px;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
  }
  .tiles {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 10px;
  }
  /* The brief's glass tile (.daily-brief .b-glass). */
  .tile {
    position: relative;
    min-width: 0;
    padding: 12px 14px;
    border-radius: 14px;
    background:
      linear-gradient(180deg, rgba(255, 255, 255, 0.09), rgba(255, 255, 255, 0.025) 42%, rgba(255, 255, 255, 0.015)),
      radial-gradient(120% 60% at 20% 0%, rgba(255, 255, 255, 0.06), transparent 60%);
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-top-color: rgba(255, 255, 255, 0.18);
    box-shadow:
      0 1px 2px rgba(0, 0, 0, 0.3),
      0 8px 20px -8px rgba(0, 0, 0, 0.5);
  }
  .top {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .logo {
    width: 30px;
    height: 30px;
    flex: none;
    display: grid;
    place-items: center;
    border-radius: 9px;
    background: rgba(0, 0, 0, 0.28);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
    color: var(--b-t1, rgba(255, 255, 255, 0.95));
  }
  .mark {
    display: block;
    fill: currentColor;
  }
  .mark.clay {
    fill: #d97757;
  }
  .name {
    flex: 1;
    min-width: 0;
    font-size: 13.5px;
    font-weight: 500;
    letter-spacing: -0.01em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .help {
    margin: 8px 0 0;
    font-size: 12.5px;
    line-height: 1.4;
    color: var(--b-t2, rgba(255, 255, 255, 0.56));
  }
  .steps {
    margin: 6px 0 0;
    padding-left: 18px;
    font-size: 12px;
    line-height: 1.45;
    color: var(--b-t2, rgba(255, 255, 255, 0.56));
  }
  .manual {
    margin: 8px 0 0;
    padding: 8px 10px;
    border-radius: 8px;
    background: rgba(0, 0, 0, 0.25);
    font-family: var(--b-mono, var(--font-mono, "Geist Mono", ui-monospace, monospace));
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
  }
  button {
    flex: none;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    padding: 5px 12px;
    border-radius: 999px;
    border: 0;
    background: rgba(255, 255, 255, 0.9);
    color: #1b1b1e;
    cursor: pointer;
    transition: opacity 120ms cubic-bezier(0.25, 1, 0.5, 1), background 0.2s;
  }
  button.copied {
    background: var(--b-ok, var(--ok, #34c759));
  }
  button:active {
    opacity: 0.7;
  }
  @media (prefers-reduced-motion: reduce) {
    .connect {
      animation: none;
    }
    button {
      transition: none;
    }
  }
</style>

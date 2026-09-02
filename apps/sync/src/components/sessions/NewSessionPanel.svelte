<script lang="ts">
  /**
   * The "start a session" surface.
   *
   * Preflight FIRST: an in-app session needs an HQ root, ready hooks, an
   * installed `claude`, and a logged-in `claude`. Each of those failing is a
   * different fix, so each gets its own banner with the EXACT remedy rather
   * than one generic "can't start" — a user who is told "run `claude login` in
   * a terminal" can act; one told "preflight failed" cannot.
   *
   * Presentation-pure: the preflight result and the model list are props, and
   * Start is a callback. The page owns the store.
   */
  /** One company the preflight offers as a session binding. */
  interface PreflightCompanyLike {
    slug: string;
    displayName: string;
  }

  /** Mirrors the backend `Preflight` shape (kept structural to stay pure). */
  interface PreflightLike {
    hqRoot: string;
    hooksReady: boolean;
    hooksError: string | null;
    claudeAvailable: boolean;
    claudeLoggedIn: boolean;
    codexAvailable: boolean;
    companies: PreflightCompanyLike[];
  }

  interface Props {
    preflight: PreflightLike | null;
    /** True while the preflight is still in flight. */
    loading?: boolean;
    /** A preflight/start failure, verbatim from the backend. */
    error?: string;
    /** Model ids offered by the CLI catalog; empty falls back to free text. */
    models?: string[];
    starting?: boolean;
    onstart?: (choice: {
      company: string | null;
      model: string | null;
      permissionMode: 'prompt' | 'bypassAll';
    }) => void;
  }

  let {
    preflight,
    loading = false,
    error = '',
    models = [],
    starting = false,
    onstart,
  }: Props = $props();

  let company = $state('');
  let model = $state('');
  let permissionMode = $state<'prompt' | 'bypassAll'>('prompt');
  let seededCompanies = $state(false);

  // Default to the first company the preflight offers, once.
  $effect(() => {
    if (seededCompanies || !preflight) return;
    seededCompanies = true;
    company = preflight.companies[0]?.slug ?? '';
  });

  /** Every blocker, each with the exact thing to do about it. */
  const blockers = $derived.by(() => {
    if (!preflight) return [] as { id: string; title: string; fix: string }[];
    const found: { id: string; title: string; fix: string }[] = [];
    if (!preflight.hqRoot) {
      found.push({
        id: 'hq-root',
        title: 'No HQ folder found',
        fix: 'Open Settings → Sync and point HQ Sync at your HQ folder.',
      });
    }
    if (!preflight.hooksReady) {
      found.push({
        id: 'hooks',
        title: 'HQ hooks are not ready',
        fix:
          preflight.hooksError ??
          'Run `bash core/scripts/check-hq-hooks.sh --root "$PWD"` from your HQ folder and fix what it reports.',
      });
    }
    if (!preflight.claudeAvailable) {
      found.push({
        id: 'claude-missing',
        title: 'Claude Code is not installed',
        fix: 'Install it, then reopen this panel: `npm install -g @anthropic-ai/claude-code`',
      });
    } else if (!preflight.claudeLoggedIn) {
      found.push({
        id: 'claude-login',
        title: 'Claude Code is not signed in',
        fix: 'Run `claude login` in a terminal, then reopen this panel.',
      });
    }
    return found;
  });

  const canStart = $derived(
    !loading && preflight !== null && blockers.length === 0 && !starting,
  );

  function start() {
    if (!canStart) return;
    onstart?.({
      company: company || null,
      model: model.trim() || null,
      permissionMode,
    });
  }
</script>

<section class="new-session" data-testid="session-new-panel" aria-labelledby="new-session-title">
  <h2 id="new-session-title">New session</h2>
  <p class="lede">
    Runs Claude Code from your HQ folder, with HQ's hooks and policies live.
  </p>

  {#if loading}
    <p class="status" role="status">Checking this machine…</p>
  {/if}

  {#if error}
    <p class="banner error" role="alert" data-testid="session-preflight-error">
      <span class="dot error" aria-hidden="true"></span>{error}
    </p>
  {/if}

  {#each blockers as blocker (blocker.id)}
    <div class="banner" role="alert" data-testid="session-preflight-blocker" data-blocker={blocker.id}>
      <strong><span class="dot warn" aria-hidden="true"></span>{blocker.title}</strong>
      <span>{blocker.fix}</span>
    </div>
  {/each}

  <div class="field">
    <label for="new-session-company">Company</label>
    {#if preflight && preflight.companies.length > 0}
      <select id="new-session-company" bind:value={company} data-testid="session-company-select">
        {#each preflight.companies as option (option.slug)}
          <option value={option.slug}>{option.displayName}</option>
        {/each}
      </select>
    {:else}
      <input
        id="new-session-company"
        type="text"
        bind:value={company}
        placeholder="company slug (optional)"
        data-testid="session-company-input"
      />
    {/if}
  </div>

  <div class="field">
    <label for="new-session-model">Model</label>
    {#if models.length > 0}
      <select id="new-session-model" bind:value={model} data-testid="session-model-select">
        <option value="">Default</option>
        {#each models as option (option)}
          <option value={option}>{option}</option>
        {/each}
      </select>
    {:else}
      <input
        id="new-session-model"
        type="text"
        bind:value={model}
        placeholder="Default"
        data-testid="session-model-input"
      />
    {/if}
  </div>

  <fieldset class="field permission">
    <legend>Permissions</legend>
    <label class="radio">
      <input type="radio" name="permission-mode" value="prompt" bind:group={permissionMode} />
      <span>
        <span class="radio-label">Prompt</span>
        <span class="radio-note">Every tool call the agent can't auto-run asks you first.</span>
      </span>
    </label>
    <label class="radio">
      <input type="radio" name="permission-mode" value="bypassAll" bind:group={permissionMode} />
      <span>
        <span class="radio-label">Bypass all</span>
        <span class="radio-note warn">
          The agent runs every tool — including file writes, shell commands, and
          network calls — without asking. Only for work you'd approve unread.
        </span>
      </span>
    </label>
  </fieldset>

  <div class="actions">
    <button
      type="button"
      class="primary"
      disabled={!canStart}
      data-testid="session-start"
      onclick={start}
    >
      {starting ? 'Starting…' : 'Start session'}
    </button>
    {#if preflight?.hqRoot}
      <span class="cwd" title={preflight.hqRoot}>in {preflight.hqRoot}</span>
    {/if}
  </div>
</section>

<style>
  .new-session {
    display: flex;
    flex-direction: column;
    gap: var(--v4-space-3);
    max-width: 460px;
    padding: var(--v4-space-4);
  }

  h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 500;
    color: var(--v4-text-1);
  }

  .lede {
    margin: 0;
    font-size: var(--type-body);
    line-height: 1.5;
    color: var(--v4-text-2);
  }

  .status {
    margin: 0;
    font-size: var(--type-metadata);
    color: var(--v4-text-3);
  }

  /* Neutral perimeter + a small semantic dot, per DESKTOP-018: a colored
     partial edge is never the carrier of meaning here. */
  .banner {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--v4-space-3);
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-card);
    background: var(--v4-raised);
    font-size: var(--type-metadata);
    line-height: 1.45;
    color: var(--v4-text-2);
  }

  .banner strong {
    display: flex;
    align-items: center;
    gap: 6px;
    font-weight: 500;
    color: var(--v4-text-1);
  }

  .dot {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--v4-warn, var(--v4-text-2));
  }

  .dot.error {
    background: var(--v4-error, var(--v4-text-2));
  }

  .banner.error {
    display: flex;
    flex-direction: row;
    align-items: baseline;
    gap: 6px;
    color: var(--v4-text-1);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0;
    padding: 0;
    border: 0;
  }

  .field label,
  .field legend {
    padding: 0;
    font-size: var(--type-metadata);
    color: var(--v4-text-3);
  }

  .field select,
  .field input[type='text'] {
    height: var(--v4-row-h);
    padding: 0 var(--v4-space-2);
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-button);
    background: var(--v4-control-bg, transparent);
    color: var(--v4-text-1);
    font-family: inherit;
    font-size: var(--type-body);
  }

  .permission {
    gap: var(--v4-space-2);
  }

  .radio {
    display: flex;
    align-items: flex-start;
    gap: var(--v4-space-2);
    cursor: pointer;
  }

  .radio > span {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .radio-label {
    font-size: var(--type-body);
    color: var(--v4-text-1);
  }

  .radio-note {
    font-size: var(--type-metadata);
    line-height: 1.4;
    color: var(--v4-text-3);
  }

  .radio-note.warn {
    color: var(--v4-warn, var(--v4-text-2));
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--v4-space-3);
  }

  .actions .primary {
    height: var(--v4-row-h);
    padding: 0 var(--v4-space-4);
    border: 1px solid transparent;
    border-radius: var(--v4-radius-button);
    background: var(--v4-primary-bg);
    color: var(--v4-primary-fg);
    font-family: inherit;
    font-size: var(--type-metadata);
    cursor: pointer;
  }

  .actions .primary:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .cwd {
    font-size: var(--type-metadata);
    color: var(--v4-text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

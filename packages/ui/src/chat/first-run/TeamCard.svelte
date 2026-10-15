<script lang="ts">
  /**
   * TeamCard — "Who do you work with?", drawn under the setup bot's first
   * message when the takeover left the team step unsettled (a `team` hq-block,
   * or the host's own fallback when an older hq-cli sent none).
   *
   * Rows, only the ones that apply, in this order: join a company that
   * invited the person, open a company they belong to, create a company
   * (a name field opens inline), and "Just me for now" as a quiet link.
   * After a pick the card settles into one line with a tick.
   *
   * Presentational: the host runs the pick (claim invite, create company,
   * pin company) and replies to the bot. Failures arrive as plain sentences.
   */
  import SetupButton from "../SetupButton.svelte";
  import { COMPANY_NAME_MAX, TEAM_CARD_COPY, type FirstRunTeamOptions, type TeamCardPick } from "./team-step";

  interface Props {
    options: FirstRunTeamOptions;
    /** Inviter display names by company slug, when the roster knows them. */
    inviters?: Readonly<Record<string, string>>;
    onpick: (pick: TeamCardPick) => void;
    /** The key of the row whose action is running (see `teamCardPickKey`). */
    pendingKey?: string | null;
    /** A plain sentence when the last pick failed. */
    error?: string | null;
    onretry?: () => void;
    /** The one line the card settles into ("Joined Acme"). */
    settled?: string | null;
  }

  let { options, inviters = {}, onpick, pendingKey = null, error = null, onretry, settled = null }: Props = $props();

  let creating = $state(false);
  let name = $state("");

  const busy = $derived(pendingKey !== null);
  const primary = $derived(
    options.invites.length > 0 ? "invite" : options.companies.length > 0 ? "existing" : "create",
  );

  function initials(label: string): string {
    const words = label.trim().split(/\s+/).filter(Boolean);
    const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "").slice(0, 2);
    return letters.toUpperCase();
  }

  function submitCreate(event: SubmitEvent): void {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    onpick({ kind: "create", name: trimmed });
  }
</script>

{#snippet spinner()}
  <span class="spinner" aria-hidden="true" data-testid="team-card-spinner"></span>
{/snippet}

{#if settled}
  <p class="team-card-settled" data-testid="team-card-settled">
    <span class="tick" aria-hidden="true">✓</span>
    {settled}
  </p>
{:else}
  <section class="team-card" data-testid="team-card" role="group" aria-label={TEAM_CARD_COPY.heading}>
    <h3 class="heading">{TEAM_CARD_COPY.heading}</h3>
    <p class="line">{TEAM_CARD_COPY.line}</p>
    <div class="rows">
      {#each options.invites as company (company.slug)}
        <div class="row" data-testid="team-card-invite">
          <span class="avatar" aria-hidden="true">{initials(company.name)}</span>
          <SetupButton
            variant={primary === "invite" ? "primary" : "secondary"}
            data-testid="team-card-join"
            disabled={busy}
            onclick={() => onpick({ kind: "invite", company })}
          >
            {#if pendingKey === `invite:${company.slug}`}{@render spinner()}{/if}
            Join {company.name}
          </SetupButton>
          {#if inviters[company.slug]}
            <span class="note" data-testid="team-card-inviter">{inviters[company.slug]} invited you</span>
          {/if}
        </div>
      {/each}
      {#each options.companies as company (company.slug)}
        <div class="row" data-testid="team-card-existing">
          <span class="avatar" aria-hidden="true">{initials(company.name)}</span>
          <SetupButton
            variant={primary === "existing" ? "primary" : "secondary"}
            data-testid="team-card-open"
            disabled={busy}
            onclick={() => onpick({ kind: "existing", company })}
          >
            {#if pendingKey === `existing:${company.slug}`}{@render spinner()}{/if}
            Open {company.name}
          </SetupButton>
        </div>
      {/each}
      <div class="row" data-testid="team-card-create-row">
        {#if creating}
          <form class="create" onsubmit={submitCreate}>
            <input
              class="new-bot-create-input"
              data-testid="team-card-name"
              aria-label={TEAM_CARD_COPY.nameLabel}
              maxlength={COMPANY_NAME_MAX}
              disabled={busy}
              bind:value={name}
            />
            <SetupButton
              variant={primary === "create" ? "primary" : "secondary"}
              type="submit"
              data-testid="team-card-create-submit"
              disabled={busy || name.trim() === ""}
            >
              {#if pendingKey === "create"}{@render spinner()}{/if}
              {TEAM_CARD_COPY.createButton}
            </SetupButton>
          </form>
        {:else}
          <SetupButton
            variant={primary === "create" ? "primary" : "secondary"}
            data-testid="team-card-create"
            disabled={busy}
            onclick={() => (creating = true)}
          >
            {TEAM_CARD_COPY.create}
          </SetupButton>
        {/if}
      </div>
    </div>
    {#if error}
      <p class="error" role="alert" data-testid="team-card-error">
        {error}
        {#if onretry}
          <SetupButton variant="quiet" data-testid="team-card-retry" onclick={() => onretry?.()}>
            {TEAM_CARD_COPY.retry}
          </SetupButton>
        {/if}
      </p>
    {/if}
    <SetupButton variant="quiet" data-testid="team-card-personal" disabled={busy} onclick={() => onpick({ kind: "personal" })}>
      {#if pendingKey === "personal"}{@render spinner()}{/if}
      {TEAM_CARD_COPY.personal}
    </SetupButton>
  </section>
{/if}

<style>
  .team-card {
    --setup-btn-fg: var(--t1, currentColor);
    --setup-btn-line: var(--line, rgba(127, 127, 127, 0.35));
    --setup-btn-primary-bg: var(--t1, currentColor);
    --setup-btn-primary-fg: var(--panel-bg, #fff);
    --setup-btn-muted: var(--t2, currentColor);
    --setup-btn-hover: var(--hover, rgba(127, 127, 127, 0.12));
    color: var(--t1, inherit);
    background: var(--panel-bg, transparent);
    border: 1px solid var(--line, rgba(127, 127, 127, 0.35));
    border-radius: 12px;
    padding: 16px;
    margin: 4px 0 16px 48px;
    max-width: 560px;
    font-size: 14px;
    display: grid;
    gap: 10px;
  }
  .heading {
    margin: 0;
    font-size: 15px;
    font-weight: 500;
  }
  .line {
    margin: 0;
    color: var(--t2, inherit);
  }
  .rows {
    display: grid;
    gap: 10px;
  }
  .row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 10px;
  }
  .avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
    font-weight: 500;
    background: var(--hover, rgba(127, 127, 127, 0.12));
    color: var(--t1, inherit);
  }
  .note {
    color: var(--t2, inherit);
    font-size: 12px;
  }
  .create {
    display: flex;
    gap: 10px;
    align-items: center;
  }
  .error {
    margin: 0;
    font-size: 12px;
    color: var(--text-danger, #d9534f);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .team-card-settled {
    margin: 4px 0 16px 48px;
    color: var(--t2, inherit);
    font-size: 14px;
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .spinner {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid currentColor;
    border-right-color: transparent;
    display: inline-block;
    margin-right: 6px;
    animation: team-card-spin 0.8s linear infinite;
  }
  @keyframes team-card-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>

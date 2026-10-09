<script lang="ts">
  /**
   * "Your team" (visual first run, slice 2): the body of the screen. One
   * decision, as equal cards in the New bot company grid's look
   * (`.new-bot-companies`): each company that invited the person, each
   * company they already belong to, "Start a company" and "Just me".
   * "Start a company" opens a name field under the cards.
   *
   * The takeover owns the head and the footer: its Next joins or creates
   * the picked company (team-step.ts runs one at a time) and shows the
   * pending label and any failure line.
   */
  import { tick } from "svelte";
  import {
    COMPANY_NAME_MAX,
    TEAM_CARDS_MAX,
    TEAM_COPY,
    teamPickKey,
    type FirstRunTeamOptions,
    type FirstRunTeamPick,
  } from "./team-step.js";

  interface Props {
    options: FirstRunTeamOptions;
    pick: FirstRunTeamPick;
    onpick: (pick: FirstRunTeamPick) => void;
    /** The company name typed for "Start a company". */
    companyName: string;
    oncompanyname: (name: string) => void;
    /** Why the typed name cannot be used, once the person tried. */
    nameIssue?: string | null;
    /** Join or Create is running: the cards hold still. */
    busy?: boolean;
    /** Enter in the name field. */
    onsubmit?: () => void;
  }

  let { options, pick, onpick, companyName, oncompanyname, nameIssue = null, busy = false, onsubmit }: Props = $props();

  let filter = $state("");
  let nameEl = $state<HTMLInputElement | null>(null);

  const allCompanyPicks = $derived<FirstRunTeamPick[]>([
    ...options.invites.map((company) => ({ kind: "invite" as const, company })),
    ...options.companies.map((company) => ({ kind: "existing" as const, company })),
  ]);
  /** Room for the company cards beside "Start a company" and "Just me". */
  const companyRoom = TEAM_CARDS_MAX - 2;
  const needsFilter = $derived(allCompanyPicks.length > companyRoom);
  const matched = $derived.by(() => {
    const q = filter.trim().toLocaleLowerCase();
    if (!q) return allCompanyPicks;
    return allCompanyPicks.filter((p) => p.kind !== "create" && p.kind !== "personal" && p.company.name.toLocaleLowerCase().includes(q));
  });
  const shownCompanyPicks = $derived(matched.slice(0, companyRoom));
  const hidden = $derived(Math.max(0, matched.length - shownCompanyPicks.length));
  const picks = $derived<FirstRunTeamPick[]>([...shownCompanyPicks, { kind: "create" }, { kind: "personal" }]);
  const pickedKey = $derived(teamPickKey(pick));

  function titleOf(p: FirstRunTeamPick): string {
    if (p.kind === "create") return TEAM_COPY.create;
    if (p.kind === "personal") return TEAM_COPY.personal;
    return p.company.name;
  }
  function noteOf(p: FirstRunTeamPick): string {
    if (p.kind === "create") return TEAM_COPY.createNote;
    if (p.kind === "personal") return TEAM_COPY.personalNote;
    return p.kind === "invite" ? TEAM_COPY.inviteNote : TEAM_COPY.existingNote;
  }
  function monogramOf(p: FirstRunTeamPick): string {
    if (p.kind === "create") return "+";
    if (p.kind === "personal") return "1";
    return p.company.name.trim().slice(0, 1).toLocaleUpperCase() || "C";
  }

  function choose(p: FirstRunTeamPick): void {
    if (busy) return;
    onpick(p);
    if (p.kind === "create") void tick().then(() => nameEl?.focus());
  }

  function onKeydown(event: KeyboardEvent): void {
    const buttons = [...((event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("button[role=radio]"))];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (at + 1) % buttons.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (at - 1 + buttons.length) % buttons.length;
    if (next === null) return;
    event.preventDefault();
    buttons[next]?.focus();
  }
</script>

<p class="new-bot-create-copy">{TEAM_COPY.copy}</p>
{#if needsFilter}
  <label class="new-bot-filter-label" for="first-run-team-filter">{TEAM_COPY.filterLabel}</label>
  <input
    id="first-run-team-filter"
    class="new-bot-create-input"
    data-testid="first-run-team-filter"
    value={filter}
    autocomplete="off"
    disabled={busy}
    oninput={(event) => (filter = (event.currentTarget as HTMLInputElement).value)}
  />
{/if}
<div
  class="new-bot-companies first-run-team-grid"
  data-testid="first-run-team-grid"
  role="radiogroup"
  aria-label="Your team"
  tabindex="-1"
  onkeydown={onKeydown}
>
  {#each picks as p (teamPickKey(p))}
    {@const key = teamPickKey(p)}
    {@const selected = key === pickedKey}
    <button
      type="button"
      class="new-bot-company first-run-team-card"
      class:selected
      role="radio"
      aria-checked={selected}
      data-testid={`first-run-team-${key}`}
      data-kind={p.kind}
      tabindex={selected ? 0 : -1}
      disabled={busy}
      onclick={() => choose(p)}
    >
      <span class="new-bot-company-monogram" aria-hidden="true">{monogramOf(p)}</span>
      <span class="first-run-team-text">
        <span class="new-bot-company-label">{titleOf(p)}</span>
        <span class="first-run-team-note">{noteOf(p)}</span>
      </span>
      {#if selected}<svg class="new-bot-company-check" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg>{/if}
    </button>
  {/each}
</div>
{#if needsFilter && matched.length === 0}
  <p class="new-bot-company-empty">{TEAM_COPY.noMatch}</p>
{:else if hidden > 0}
  <p class="new-bot-muted" data-testid="first-run-team-more">{hidden} more. Type to find {hidden === 1 ? "it" : "them"}.</p>
{/if}
{#if pick.kind === "create"}
  <label class="new-bot-create-label" for="first-run-company-name">{TEAM_COPY.nameLabel}</label>
  <input
    bind:this={nameEl}
    id="first-run-company-name"
    class="new-bot-create-input"
    data-testid="first-run-company-name"
    type="text"
    value={companyName}
    maxlength={COMPANY_NAME_MAX + 20}
    autocomplete="off"
    spellcheck="false"
    disabled={busy}
    aria-invalid={nameIssue ? "true" : undefined}
    oninput={(event) => oncompanyname((event.currentTarget as HTMLInputElement).value)}
    onkeydown={(event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      event.stopPropagation();
      onsubmit?.();
    }}
  />
  {#if nameIssue}<p class="new-bot-create-error" role="alert" data-testid="first-run-company-name-issue">{nameIssue}</p>{/if}
{/if}

<style>
  .first-run-team-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .first-run-team-text {
    display: grid;
    flex: 1 1 auto;
    gap: 1px;
    min-width: 0;
  }
  .first-run-team-note {
    overflow: hidden;
    color: var(--new-bot-muted);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

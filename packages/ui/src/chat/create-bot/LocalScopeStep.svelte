<script lang="ts">
  /**
   * The local "Who it's for" step: Personal (acts as you, the default) or
   * Company (its own identity in the owner's companies). With more than one
   * company, Company picks which ones right under the cards.
   */
  import CompanyLabel from "../../company/CompanyLabel.svelte";
  import type { BotScope, CreateBotDraft } from "./create-bot-model.js";

  interface Props {
    draft: CreateBotDraft;
    /** The owner's companies a company bot can belong to. */
    ownerCompanies?: ReadonlyArray<{ slug: string; label: string }>;
    disabled?: boolean;
    onpatch: (patch: Partial<CreateBotDraft>) => void;
  }

  let { draft, ownerCompanies = [], disabled = false, onpatch }: Props = $props();

  const picked = $derived(
    draft.companySlugs
      .map((slug) => ownerCompanies.find((c) => c.slug === slug)?.label)
      .filter((label): label is string => !!label),
  );
  const companyLine = $derived(
    ownerCompanies.length === 0
      ? "You are not in a company yet."
      : ownerCompanies.length === 1
        ? `Shared with your team in ${ownerCompanies[0]!.label}.`
        : picked.length > 0
          ? `Shared with your team in ${picked.length === 1 ? picked[0] : `${picked.slice(0, -1).join(", ")} and ${picked.at(-1)}`}.`
          : "Shared with your team in the companies you pick.",
  );

  function pickScope(scope: BotScope): void {
    if (disabled) return;
    if (scope === "company" && ownerCompanies.length === 0) return;
    // One company: it is the only answer, so it is picked with the card.
    if (scope === "company" && ownerCompanies.length === 1 && draft.companySlugs.length === 0) {
      onpatch({ scope, companySlugs: [ownerCompanies[0]!.slug] });
      return;
    }
    onpatch({ scope });
  }

  function toggleCompany(slug: string): void {
    if (disabled) return;
    const has = draft.companySlugs.includes(slug);
    onpatch({
      scope: "company",
      companySlugs: has ? draft.companySlugs.filter((s) => s !== slug) : [...draft.companySlugs, slug],
    });
  }

  function onKey(event: KeyboardEvent): void {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const next: BotScope = draft.scope === "personal" ? "company" : "personal";
    pickScope(next);
    (event.currentTarget as HTMLElement).querySelector<HTMLButtonElement>(`[data-scope="${draft.scope}"]`)?.focus();
  }
</script>

<div class="new-bot-step-body" data-testid="create-bot-scope-step">
  <div class="new-bot-options new-bot-options--2" role="radiogroup" aria-label="Who it's for" data-testid="chat-bot-scope" tabindex="-1" onkeydown={onKey}>
    <button
      type="button"
      class="new-bot-option"
      role="radio"
      aria-checked={draft.scope === "personal"}
      data-testid="chat-bot-scope-personal"
      data-scope="personal"
      {disabled}
      tabindex={draft.scope === "personal" ? 0 : -1}
      onclick={() => pickScope("personal")}
    >
      <span class="new-bot-option-title">Personal</span>
      <span class="new-bot-option-sub">Acts as you. Only you can see it.</span>
    </button>
    <button
      type="button"
      class="new-bot-option"
      role="radio"
      aria-checked={draft.scope === "company"}
      data-testid="chat-bot-scope-company"
      data-scope="company"
      disabled={disabled || ownerCompanies.length === 0}
      tabindex={draft.scope === "company" ? 0 : -1}
      onclick={() => pickScope("company")}
    >
      <span class="new-bot-option-title">Company</span>
      <span class="new-bot-option-sub" data-testid="chat-bot-scope-company-line">{companyLine}</span>
    </button>
  </div>
  {#if draft.scope === "company" && ownerCompanies.length > 1}
    <div class="new-bot-chips" role="group" aria-label="Companies" data-testid="chat-bot-scope-companies">
      {#each ownerCompanies as company (company.slug)}
        {@const on = draft.companySlugs.includes(company.slug)}
        <button
          type="button"
          class="new-bot-chip"
          role="checkbox"
          aria-checked={on}
          data-testid={`chat-bot-scope-company-${company.slug}`}
          {disabled}
          onclick={() => toggleCompany(company.slug)}
        ><CompanyLabel name={company.label} companyUid={company.slug} /></button>
      {/each}
    </div>
  {/if}
</div>

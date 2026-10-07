<script lang="ts">
  import CompanyLabel from "../../company/CompanyLabel.svelte";
  /**
   * The Local bot's advanced settings, folded away on the coding tool step:
   * the @handle it is created under, who it is for, permissions and memory.
   * None of them can change after the bot exists, so each keeps its default
   * until the person opens this and picks otherwise. The name was given on
   * the first step; the title, avatar and model are asked in the bot's first
   * message (`newBotKickoff`).
   */
  import { hostComputerNoun } from "@hq/platform";
  import {
    botHandle,
    botScopeCopy,
    localHandleIssue,
    type BotMemory,
    type BotScope,
    type CreateBotDraft,
  } from "./create-bot-model.js";
  import "./create-bot.css";

  interface Props {
    draft: CreateBotDraft;
    existingNames: readonly string[];
    /** The owner's companies a company bot can belong to. */
    ownerCompanies?: ReadonlyArray<{ slug: string; label: string }>;
    disabled?: boolean;
    onpatch: (patch: Partial<CreateBotDraft>) => void;
  }

  let { draft, existingNames, ownerCompanies = [], disabled = false, onpatch }: Props = $props();

  const SCOPES: readonly BotScope[] = ["personal", "company"];

  /** "Mac", "PC" or "computer", read once so the copy never renames the machine mid-flow. */
  const hostNoun = hostComputerNoun();
  const scopeCopy = $derived(botScopeCopy({ noun: hostNoun }));
  const handle = $derived(botHandle(draft));
  const handleError = $derived(localHandleIssue(draft, existingNames));

  function pickScope(scope: BotScope): void {
    if (disabled) return;
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

  function onScopeKey(event: KeyboardEvent): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const next: BotScope = draft.scope === "personal" ? "company" : "personal";
    pickScope(next);
    (event.currentTarget as HTMLElement).querySelector<HTMLButtonElement>(`[data-scope="${next}"]`)?.focus();
  }
</script>

<div class="cb-step" data-testid="chat-bot-advanced">
  <div class="cb-field">
    <label class="cb-label" for="create-bot-handle">Handle</label>
    <input
      id="create-bot-handle"
      class="cb-input"
      type="text"
      autocomplete="off"
      spellcheck="false"
      data-testid="chat-bot-handle"
      placeholder="scout-2"
      aria-describedby="create-bot-handle-help"
      aria-invalid={handleError ? "true" : undefined}
      value={handle}
      {disabled}
      oninput={(event) => onpatch({ handle: (event.currentTarget as HTMLInputElement).value })}
    />
    <p class="cb-help" class:error={handleError} id="create-bot-handle-help" data-testid="chat-bot-handle-help">
      {handleError ?? `@${handle} is how the bot is mentioned and what the CLI calls it.`}
    </p>
  </div>

  <div class="cb-field">
    <span class="cb-label" id="create-bot-scope-label">Who is it for?</span>
    <div class="cb-cards scope-cards" role="radiogroup" aria-labelledby="create-bot-scope-label" data-testid="chat-bot-scope" tabindex="-1" onkeydown={onScopeKey}>
      {#each SCOPES as scope (scope)}
        <button
          type="button"
          class="cb-card scope-card"
          role="radio"
          aria-checked={draft.scope === scope}
          data-testid={`chat-bot-scope-${scope}`}
          data-scope={scope}
          {disabled}
          tabindex={draft.scope === scope ? 0 : -1}
          onclick={() => pickScope(scope)}
        >
          <span class="cb-card-row"><span class="cb-card-title">{scopeCopy[scope].title}</span></span>
          <span class="cb-card-sub">{scopeCopy[scope].sub}</span>
        </button>
      {/each}
    </div>
    {#if draft.scope === "company"}
      {#if ownerCompanies.length === 0}
        <p class="cb-help" data-testid="chat-bot-scope-help">You are not in a company yet. Make it personal for now; a personal bot can create a company for you.</p>
      {:else}
        <div class="cb-pills" role="group" aria-label="Companies" data-testid="chat-bot-scope-companies">
          {#each ownerCompanies as company (company.slug)}
            {@const on = draft.companySlugs.includes(company.slug)}
            <button
              type="button"
              class="cb-pill"
              role="checkbox"
              aria-checked={on}
              data-testid={`chat-bot-scope-company-${company.slug}`}
              {disabled}
              onclick={() => toggleCompany(company.slug)}
            >
              <CompanyLabel name={company.label} companyUid={company.slug} />
            </button>
          {/each}
        </div>
        <p class="cb-help" data-testid="chat-bot-scope-help">Pick one or more. Others can @mention it in those companies' rooms.</p>
      {/if}
    {/if}
  </div>

  <div class="cb-field">
    <span class="cb-label" id="create-bot-approve-label">Permissions</span>
    <button
      type="button"
      class="cb-switch"
      role="switch"
      aria-checked={draft.autoApprove}
      aria-labelledby="create-bot-approve-label"
      data-testid="chat-bot-auto-approve"
      {disabled}
      onclick={() => onpatch({ autoApprove: !draft.autoApprove })}
    >
      {draft.autoApprove ? "Pre-approve every action" : "Ask before each action"}
    </button>
    <p class="cb-help">
      {draft.autoApprove
        ? "The bot runs tools and commands without asking. It can't answer prompts on its own."
        : "Gated commands will fail. A bot can't answer approval prompts."}
    </p>
  </div>

  <div class="cb-field">
    <span class="cb-label" id="create-bot-memory-label">Memory</span>
    <div class="cb-pills" role="radiogroup" aria-labelledby="create-bot-memory-label">
      {#each [{ id: "synced", label: "HQ synced" }, { id: "local", label: `This ${hostNoun} only` }] as const as option (option.id)}
        <button
          type="button"
          class="cb-pill"
          role="radio"
          aria-checked={draft.memory === option.id}
          data-testid={`chat-bot-memory-${option.id}`}
          {disabled}
          onclick={() => onpatch({ memory: option.id as BotMemory })}
        >
          {option.label}
        </button>
      {/each}
    </div>
    <p class="cb-help">
      {draft.memory === "synced"
        ? "What the bot learns syncs with your HQ, so it follows you across machines."
        : `Notes and memory stay on this ${hostNoun}.`}
    </p>
  </div>
</div>

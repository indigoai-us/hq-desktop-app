<script lang="ts">
  /**
   * Step C — Details for a Local bot: name, an optional job title, the avatar
   * (pack picker when the host supplies packs, else the generated mark), who
   * the bot is for, and a collapsed Advanced section (permissions, model,
   * memory).
   *
   * The avatar pick is NOT held here. This component is torn down and rebuilt
   * every time the person walks off the step and back, so anything kept in
   * local state would be lost while the draft still held the pick — which is
   * exactly how a chosen avatar used to snap back to the generated mark. The
   * flow owns `avatarSrc`, the draft owns `avatar`, and both are passed in.
   */
  import AvatarPackPicker from "../../avatars/AvatarPackPicker.svelte";
  import type { AvatarPack, AvatarSelection } from "../../avatars/types.js";
  import IdentityMark from "../messaging/IdentityMark.svelte";
  import {
    BOT_SCOPE_COPY,
    TITLE_MAX,
    nameIssue,
    normalizeBotName,
    templateBringsLine,
    titleIssue,
    type BotMemory,
    type BotScope,
    type CreateBotDraft,
    type TemplateCard,
  } from "./create-bot-model.js";
  import "./create-bot.css";

  interface Props {
    draft: CreateBotDraft;
    existingNames: readonly string[];
    /** The chosen template (kind = template) for the "what this brings" line. */
    template?: TemplateCard | null;
    /** The owner's companies a company bot can belong to. */
    ownerCompanies?: ReadonlyArray<{ slug: string; label: string }>;
    avatarPacks?: AvatarPack[] | null;
    loadAvatarPacks?: (() => Promise<AvatarPack[]>) | null;
    /** Resolved src of the avatar already picked in this flow, if any. */
    avatarSrc?: string | null;
    disabled?: boolean;
    autofocus?: boolean;
    onpatch: (patch: Partial<CreateBotDraft>) => void;
    onavatar?: (selection: AvatarSelection | undefined, src: string | null) => void;
  }

  let {
    draft,
    existingNames,
    template = null,
    ownerCompanies = [],
    avatarPacks = null,
    loadAvatarPacks = null,
    avatarSrc = null,
    disabled = false,
    autofocus = true,
    onpatch,
    onavatar,
  }: Props = $props();

  const SCOPES: readonly BotScope[] = ["personal", "company"];

  const nameError = $derived(nameIssue(draft.name, existingNames));
  const nameTouched = $derived(draft.name.trim().length > 0);
  const titleError = $derived(titleIssue(draft.title));
  const brings = $derived(templateBringsLine(template));
  const hasPicker = $derived(Boolean(avatarPacks || loadAvatarPacks));

  let avatarOpen = $state(false);
  const previewAvatar = $derived(avatarSrc);

  function onAvatarChange(selection: AvatarSelection, src: string | null): void {
    const generated = selection.kind === "generated";
    onpatch({ avatar: generated ? undefined : selection });
    onavatar?.(generated ? undefined : selection, generated ? null : src);
  }

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

  function focusOnMount(node: HTMLInputElement): void {
    if (autofocus) {
      node.focus();
      node.select();
    }
  }
</script>

<div class="cb-step" data-testid="create-bot-details-step">
  <div class="cb-field">
    <label class="cb-label" for="create-bot-name">Name</label>
    <input
      id="create-bot-name"
      class="cb-input"
      type="text"
      autocomplete="off"
      spellcheck="false"
      data-testid="chat-bot-name"
      placeholder="assistant"
      aria-describedby="create-bot-name-help"
      aria-invalid={nameTouched && nameError ? "true" : undefined}
      value={draft.name}
      disabled={disabled}
      use:focusOnMount
      oninput={(event) => onpatch({ name: (event.currentTarget as HTMLInputElement).value })}
    />
    <p class="cb-help" class:error={nameTouched && nameError} class:ok={!nameError} id="create-bot-name-help" data-testid="chat-bot-name-help">
      {nameError ?? `${normalizeBotName(draft.name)} is available — it's the bot's @handle everywhere.`}
    </p>
  </div>

  <div class="cb-field">
    <label class="cb-label" for="create-bot-title">Title</label>
    <input
      id="create-bot-title"
      class="cb-input"
      type="text"
      autocomplete="off"
      data-testid="chat-bot-title"
      placeholder="Ad account analyst"
      maxlength={TITLE_MAX + 20}
      aria-describedby="create-bot-title-help"
      aria-invalid={titleError ? "true" : undefined}
      value={draft.title}
      disabled={disabled}
      oninput={(event) => onpatch({ title: (event.currentTarget as HTMLInputElement).value })}
    />
    <p class="cb-help" class:error={titleError} id="create-bot-title-help" data-testid="chat-bot-title-help">
      {titleError ?? "Optional. What it does, shown under its name."}
    </p>
  </div>

  <div class="cb-field">
    <span class="cb-label" id="create-bot-avatar-label">Avatar</span>
    <div class="avatar-row">
      <span class="avatar-mark" aria-hidden="true">
        <IdentityMark kind="agent" label={draft.name || "bot"} avatarUrl={previewAvatar} agentUid={`agt_preview_${normalizeBotName(draft.name) || "bot"}`} />
      </span>
      {#if hasPicker}
        <button
          type="button"
          class="cb-pill"
          aria-pressed={avatarOpen}
          aria-labelledby="create-bot-avatar-label"
          data-testid="chat-bot-avatar-toggle"
          disabled={disabled}
          onclick={() => (avatarOpen = !avatarOpen)}
        >
          {avatarOpen ? "Done" : previewAvatar ? "Change" : "Choose an avatar"}
        </button>
        <span class="cb-help">{previewAvatar ? "Saved once the bot exists." : "A generated mark until you pick one."}</span>
      {:else}
        <span class="cb-help">A generated mark — change it from the bot's profile later.</span>
      {/if}
    </div>
    {#if avatarOpen && hasPicker}
      <div class="avatar-picker" data-testid="chat-bot-avatar-picker">
        <AvatarPackPicker
          agentUid={`agt_preview_${normalizeBotName(draft.name) || "bot"}`}
          packs={avatarPacks}
          loadPacks={loadAvatarPacks ?? undefined}
          selected={draft.avatar ?? null}
          currentSrc={previewAvatar}
          hideSave
          onchange={onAvatarChange}
        />
      </div>
    {/if}
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
          disabled={disabled}
          tabindex={draft.scope === scope ? 0 : -1}
          onclick={() => pickScope(scope)}
        >
          <span class="cb-card-row"><span class="cb-card-title">{BOT_SCOPE_COPY[scope].title}</span></span>
          <span class="cb-card-sub">{BOT_SCOPE_COPY[scope].sub}</span>
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
              disabled={disabled}
              onclick={() => toggleCompany(company.slug)}
            >
              <span class="cb-pill-dot" class:ready={on} aria-hidden="true"></span>
              {company.label}
            </button>
          {/each}
        </div>
        <p class="cb-help" data-testid="chat-bot-scope-help">Pick one or more. Others can @mention it in those companies' rooms.</p>
      {/if}
    {/if}
  </div>

  {#if brings}
    <p class="cb-help brings" data-testid="chat-bot-template-brings">{brings}</p>
  {/if}

  <details class="cb-advanced" data-testid="chat-bot-advanced">
    <summary>Advanced</summary>
    <div class="cb-advanced-body">
      <div class="cb-field">
        <span class="cb-label" id="create-bot-approve-label">Permissions</span>
        <button
          type="button"
          class="cb-switch"
          role="switch"
          aria-checked={draft.autoApprove}
          aria-labelledby="create-bot-approve-label"
          data-testid="chat-bot-auto-approve"
          disabled={disabled}
          onclick={() => onpatch({ autoApprove: !draft.autoApprove })}
        >
          {draft.autoApprove ? "Pre-approve every action" : "Ask before each action"}
        </button>
        <p class="cb-help">
          {draft.autoApprove
            ? "The bot runs tools and commands without asking — it can't answer prompts on its own."
            : "Gated commands will fail — a bot can't answer approval prompts."}
        </p>
      </div>
      <div class="cb-field">
        <label class="cb-label" for="create-bot-model">Model</label>
        <input
          id="create-bot-model"
          class="cb-input"
          type="text"
          autocomplete="off"
          spellcheck="false"
          data-testid="chat-bot-model"
          placeholder="Runtime default"
          value={draft.model}
          disabled={disabled}
          oninput={(event) => onpatch({ model: (event.currentTarget as HTMLInputElement).value })}
        />
        <p class="cb-help">Leave empty to use the runtime's default model.</p>
      </div>
      <div class="cb-field">
        <span class="cb-label" id="create-bot-memory-label">Memory</span>
        <div class="cb-pills" role="radiogroup" aria-labelledby="create-bot-memory-label">
          {#each [{ id: "synced", label: "HQ synced" }, { id: "local", label: "This Mac only" }] as const as option (option.id)}
            <button
              type="button"
              class="cb-pill"
              role="radio"
              aria-checked={draft.memory === option.id}
              data-testid={`chat-bot-memory-${option.id}`}
              disabled={disabled}
              onclick={() => onpatch({ memory: option.id as BotMemory })}
            >
              {option.label}
            </button>
          {/each}
        </div>
        <p class="cb-help">
          {draft.memory === "synced"
            ? "What the bot learns syncs with your HQ, so it follows you across machines."
            : "Notes and memory stay on this computer."}
        </p>
      </div>
    </div>
  </details>
</div>

<style>
  .avatar-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .avatar-mark {
    display: inline-grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    overflow: hidden;
  }
  .avatar-mark :global(.identity) {
    width: 36px;
    height: 36px;
  }
  .avatar-picker {
    max-height: 260px;
    overflow-y: auto;
    padding: 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: 10px;
  }
  .brings {
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--v4-control-faint, rgba(127, 127, 127, 0.08));
    color: var(--t2);
  }
</style>

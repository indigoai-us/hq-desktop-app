<script lang="ts">
  /**
   * Step C — Details for a Local bot: name (live validation + suggestion
   * chips), avatar (pack picker when the host supplies packs, else the
   * generated mark), an optional intro that becomes the bot's first message,
   * and a collapsed Advanced section (permissions, model, memory).
   */
  import AvatarPackPicker from "../../avatars/AvatarPackPicker.svelte";
  import type { AvatarPack, AvatarSelection } from "../../avatars/types.js";
  import IdentityMark from "../messaging/IdentityMark.svelte";
  import {
    INTRO_MAX,
    introIssue,
    nameIssue,
    normalizeBotName,
    suggestBotNames,
    templateBringsLine,
    type BotMemory,
    type CreateBotDraft,
    type TemplateCard,
  } from "./create-bot-model.js";
  import "./create-bot.css";

  interface Props {
    draft: CreateBotDraft;
    existingNames: readonly string[];
    /** The chosen template (kind = template) for the "what this brings" line. */
    template?: TemplateCard | null;
    avatarPacks?: AvatarPack[] | null;
    loadAvatarPacks?: (() => Promise<AvatarPack[]>) | null;
    disabled?: boolean;
    autofocus?: boolean;
    onpatch: (patch: Partial<CreateBotDraft>) => void;
    onavatar?: (selection: AvatarSelection | undefined, src: string | null) => void;
  }

  let {
    draft,
    existingNames,
    template = null,
    avatarPacks = null,
    loadAvatarPacks = null,
    disabled = false,
    autofocus = true,
    onpatch,
    onavatar,
  }: Props = $props();

  const nameError = $derived(nameIssue(draft.name, existingNames));
  const nameTouched = $derived(draft.name.trim().length > 0);
  const suggestions = $derived(suggestBotNames(existingNames, 4, draft.name));
  const introError = $derived(introIssue(draft.intro));
  const brings = $derived(templateBringsLine(template));
  const hasPicker = $derived(Boolean(avatarPacks || loadAvatarPacks));

  let avatarOpen = $state(false);
  let avatarSrc = $state<string | null>(null);
  const previewAvatar = $derived(avatarSrc ?? null);

  function onAvatarChange(selection: AvatarSelection, src: string | null): void {
    avatarSrc = selection.kind === "generated" ? null : src;
    onpatch({ avatar: selection.kind === "generated" ? undefined : selection });
    onavatar?.(selection.kind === "generated" ? undefined : selection, avatarSrc);
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
    {#if suggestions.length > 0}
      <div class="cb-pills" data-testid="chat-bot-name-suggestions" aria-label="Name ideas">
        {#each suggestions as suggestion (suggestion)}
          <button type="button" class="cb-pill" data-testid="chat-bot-name-suggestion" disabled={disabled} onclick={() => onpatch({ name: suggestion })}>
            {suggestion}
          </button>
        {/each}
      </div>
    {/if}
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
          hideSave
          onchange={onAvatarChange}
        />
      </div>
    {/if}
  </div>

  <div class="cb-field">
    <div class="intro-head">
      <label class="cb-label" for="create-bot-intro">Intro</label>
      <span class="cb-count" class:over={draft.intro.length > INTRO_MAX} data-testid="chat-bot-intro-count">{draft.intro.length}/{INTRO_MAX}</span>
    </div>
    <textarea
      id="create-bot-intro"
      class="cb-textarea"
      data-testid="chat-bot-intro"
      placeholder="One line the bot says first — “Hi, I'm Scout. I keep an eye on the ad accounts.”"
      rows="2"
      maxlength={INTRO_MAX + 50}
      aria-invalid={introError ? "true" : undefined}
      aria-describedby="create-bot-intro-help"
      value={draft.intro}
      disabled={disabled}
      oninput={(event) => onpatch({ intro: (event.currentTarget as HTMLTextAreaElement).value })}
    ></textarea>
    <p class="cb-help" class:error={introError} id="create-bot-intro-help">
      {introError ?? "Optional. Becomes the bot's first message in its DM."}
    </p>
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
  .intro-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .brings {
    padding: 8px 10px;
    border-radius: 8px;
    background: var(--v4-control-faint, rgba(127, 127, 127, 0.08));
    color: var(--t2);
  }
</style>

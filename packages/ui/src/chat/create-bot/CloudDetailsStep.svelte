<script lang="ts">
  /**
   * Step C for a Cloud bot: the name and the @handle it is created under.
   *
   * The company channel's "Create a bot" card used to ask for these two and is
   * no longer shown, so this step is the only place they are chosen. Both are
   * prefilled — the handle follows the name until the person edits it — and
   * both are sent to the server exactly as they read here.
   */
  import IdentityMark from "../messaging/IdentityMark.svelte";
  import {
    botHandle,
    cloudNameIssue,
    handleIssue,
    type CreateBotDraft,
  } from "./create-bot-model.js";
  import "./create-bot.css";

  interface Props {
    draft: CreateBotDraft;
    /** The company that will host it, for the help line. */
    companyLabel?: string;
    disabled?: boolean;
    autofocus?: boolean;
    onpatch: (patch: Partial<CreateBotDraft>) => void;
  }

  let { draft, companyLabel = "your company", disabled = false, autofocus = true, onpatch }: Props = $props();

  const handle = $derived(botHandle(draft));
  const nameError = $derived(cloudNameIssue(draft.name));
  const handleError = $derived(handleIssue(draft));
  const nameTouched = $derived(draft.name.trim().length > 0);

  function focusOnMount(node: HTMLInputElement): void {
    if (autofocus) {
      node.focus();
      node.select();
    }
  }
</script>

<div class="cb-step" data-testid="create-bot-cloud-details-step">
  <div class="cb-field">
    <label class="cb-label" for="create-bot-name">Name</label>
    <input
      id="create-bot-name"
      class="cb-input"
      type="text"
      autocomplete="off"
      spellcheck="false"
      data-testid="chat-bot-name"
      placeholder="Polar"
      aria-describedby="create-bot-name-help"
      aria-invalid={nameTouched && nameError ? "true" : undefined}
      value={draft.name}
      disabled={disabled}
      use:focusOnMount
      oninput={(event) => onpatch({ name: (event.currentTarget as HTMLInputElement).value })}
    />
    <p class="cb-help" class:error={nameTouched && nameError} id="create-bot-name-help" data-testid="chat-bot-name-help">
      {nameError ?? `What ${companyLabel} will call it.`}
    </p>
  </div>

  <div class="cb-field">
    <label class="cb-label" for="create-bot-handle">Handle</label>
    <div class="handle-row">
      <span class="handle-at" aria-hidden="true">@</span>
      <input
        id="create-bot-handle"
        class="cb-input"
        type="text"
        autocomplete="off"
        spellcheck="false"
        data-testid="chat-bot-handle"
        placeholder="polar"
        aria-describedby="create-bot-handle-help"
        aria-invalid={handleError ? "true" : undefined}
        value={handle}
        disabled={disabled}
        oninput={(event) => onpatch({ handle: (event.currentTarget as HTMLInputElement).value })}
      />
    </div>
    <p class="cb-help" class:error={handleError} id="create-bot-handle-help" data-testid="chat-bot-handle-help">
      {handleError ?? `People @mention it as @${handle} in ${companyLabel}'s channels.`}
    </p>
  </div>

  <div class="cb-field">
    <span class="cb-label">Then</span>
    <div class="cloud-next">
      <span class="cloud-mark" aria-hidden="true">
        <IdentityMark kind="agent" label={draft.name || "bot"} avatarUrl={null} agentUid={`agt_preview_${handle || "bot"}`} />
      </span>
      <span class="cb-help" data-testid="chat-bot-cloud-next">
        {companyLabel} sets it up and opens its channel. Its runtime, size, and avatar are chosen from its profile once it is online.
      </span>
    </div>
  </div>
</div>

<style>
  .handle-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .handle-at {
    color: var(--t3);
    font: 500 13px/1 var(--font-mono);
  }
  .handle-row .cb-input {
    flex: 1 1 auto;
    min-width: 0;
  }
  .cloud-next {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .cloud-mark {
    display: inline-grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border-radius: 50%;
    overflow: hidden;
    flex: 0 0 auto;
  }
  .cloud-mark :global(.identity) {
    width: 36px;
    height: 36px;
  }
</style>

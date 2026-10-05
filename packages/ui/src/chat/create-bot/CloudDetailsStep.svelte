<script lang="ts">
  import RailIcon from "../../common/button/RailIcon.svelte";
  /**
   * Step C for a Cloud bot: the name, the @handle it is created under, and an
   * optional job title.
   *
   * The company channel's "Create a bot" card used to ask for the name and the
   * handle and is no longer shown, so this step is the only place they are
   * chosen. Both are prefilled — the handle follows the name until the person
   * edits it — and both are sent to the server exactly as they read here. The
   * title is not part of that card sequence at all: the host writes it onto
   * the bot's agent profile once the bot exists, exactly as the Local step does.
  */
  import type { AgentProvisionOptionsView } from "@hq/platform";
  import IdentityMark from "../messaging/IdentityMark.svelte";
  import {
    TITLE_MAX,
    botHandle,
    cloudNameIssue,
    handleIssue,
    titleIssue,
    type CreateBotDraft,
  } from "./create-bot-model.js";
  import "./create-bot.css";

  interface Props {
    draft: CreateBotDraft;
    /** The company that will host it, for the help line. */
    companyLabel?: string;
    claudeProviderEnabled: boolean;
    cloudProvisionOptions: AgentProvisionOptionsView | null;
    cloudQuoteStatus: "loading" | "ready" | "error";
    disabled?: boolean;
    autofocus?: boolean;
    onpatch: (patch: Partial<CreateBotDraft>) => void;
    onretryquote: () => void;
  }

  let {
    draft,
    companyLabel = "your company",
    claudeProviderEnabled,
    cloudProvisionOptions,
    cloudQuoteStatus,
    disabled = false,
    autofocus = true,
    onpatch,
    onretryquote,
  }: Props = $props();

  const handle = $derived(botHandle(draft));
  const nameError = $derived(cloudNameIssue(draft.name));
  const handleError = $derived(handleIssue(draft));
  const nameTouched = $derived(draft.name.trim().length > 0);
  const titleError = $derived(titleIssue(draft.title));

  function focusOnMount(node: HTMLInputElement): void {
    if (autofocus) {
      node.focus();
      node.select();
    }
  }

  function monthly(cents: number): string {
    return `${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)}/month`;
  }

  // The size's own catalog price. The company quote can differ from it (Team
  // credits, custom or free overrides), so it is shown separately below.
  function priceLabel(option: AgentProvisionOptionsView["options"][number]): string {
    return monthly(option.listCents);
  }

  function companyPriceLabel(option: AgentProvisionOptionsView["options"][number]): string | null {
    if (option.notBilled) return "Included for your company";
    if (option.netMonthlyCents === null) return "Price unavailable";
    if (option.netMonthlyCents === option.listCents) return null;
    return `Your company pays ${monthly(option.netMonthlyCents)}`;
  }

  function unavailableLabel(option: AgentProvisionOptionsView["options"][number]): string {
    return option.unavailableReason === "owner-required"
      ? "Only company owners can choose this size."
      : "Unavailable for this company.";
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
    <fieldset class="cloud-choice-group" disabled={disabled} data-testid="cloud-bot-runtime-choice">
      <legend class="cb-label">Runtime</legend>
      <label class="cloud-choice">
        <input
          type="radio"
          name="cloud-bot-runtime"
          value="codex"
          checked={draft.runtime === "codex"}
          data-testid="cloud-bot-runtime-codex"
          onchange={() => onpatch({ runtime: "codex" })}
        />
        <span>Codex</span>
      </label>
      <label class="cloud-choice">
        <input
          type="radio"
          name="cloud-bot-runtime"
          value="grok"
          checked={draft.runtime === "grok"}
          data-testid="cloud-bot-runtime-grok"
          onchange={() => onpatch({ runtime: "grok" })}
        />
        <span>Grok</span>
      </label>
      {#if claudeProviderEnabled}
        <label class="cloud-choice" data-testid="cloud-bot-runtime-claude-choice">
          <input
            type="radio"
            name="cloud-bot-runtime"
            value="claude"
            checked={draft.runtime === "claude"}
            data-testid="cloud-bot-runtime-claude"
            onchange={() => onpatch({ runtime: "claude" })}
          />
          <span>Claude</span>
        </label>
      {/if}
    </fieldset>
  </div>

  {#if draft.runtime === "claude"}
    <div class="cb-field">
      <p class="cb-help" data-testid="cloud-bot-claude-subscription-help">
        After creation, HQ opens the Claude authorization page.
      </p>
    </div>
  {/if}

  <div class="cb-field">
    <fieldset class="cloud-size-options" disabled={disabled || cloudQuoteStatus !== "ready"} data-testid="cloud-bot-size-choice">
      <legend class="cb-label">Size and price</legend>
      {#if cloudQuoteStatus === "loading"}
        <p class="cb-help" role="status" data-testid="cloud-bot-quote-loading">Loading your company’s price quote…</p>
      {:else if cloudQuoteStatus === "error"}
        <p class="cb-help error" role="alert" data-testid="cloud-bot-quote-error">Your company’s price quote couldn’t be loaded, so creation is paused.</p>
        <button type="button" class="cloud-retry" disabled={disabled} data-testid="cloud-bot-quote-retry" onclick={onretryquote}><RailIcon name="refresh" />Try again</button>
      {:else if cloudProvisionOptions?.options.length}
        {#each cloudProvisionOptions.options as option (option.key)}
          <label class="cloud-size-option" class:selected={draft.size === option.key} class:unavailable={!option.selectable || option.netMonthlyCents === null}>
            <input
              type="radio"
              name="cloud-bot-size"
              value={option.key}
              checked={draft.size === option.key}
              disabled={disabled || !option.selectable || option.netMonthlyCents === null}
              data-testid={`cloud-bot-size-${option.key}`}
              onchange={() => onpatch({ size: option.key })}
            />
            <span class="cloud-size-copy">
              <strong>{option.productName}</strong>
              <span data-testid={`cloud-bot-size-${option.key}-price`}>{priceLabel(option)}</span>
              {#if companyPriceLabel(option)}
                <small data-testid={`cloud-bot-size-${option.key}-company-price`}>{companyPriceLabel(option)}</small>
              {/if}
              {#if !option.selectable || option.netMonthlyCents === null}
                <small>{unavailableLabel(option)}</small>
              {/if}
            </span>
          </label>
        {/each}
      {:else}
        <p class="cb-help error" data-testid="cloud-bot-no-size">No bot sizes are available for this company right now.</p>
      {/if}
    </fieldset>
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
        {companyLabel} hosts it and opens its channel. Choose its runtime, sign-in method, and size here. Add an avatar after it is online.
      </span>
    </div>
  </div>
</div>

<style>
  .cloud-choice-group,
  .cloud-size-options {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }
  .cloud-choice-group legend,
  .cloud-size-options legend {
    width: 100%;
    margin-bottom: 2px;
    padding: 0;
  }
  .cloud-choice,
  .cloud-size-option {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    min-width: 0;
    padding: 8px 10px;
    border: 1px solid var(--v4-control-border, var(--border));
    border-radius: 6px;
    background: var(--v4-control-bg, transparent);
    color: var(--t1);
    font-size: 13px;
    cursor: pointer;
  }
  .cloud-choice:has(input:checked),
  .cloud-size-option.selected {
    background: var(--sel, var(--v4-active-row, rgba(127, 127, 127, 0.14)));
  }
  .cloud-choice input,
  .cloud-size-option input {
    margin: 2px 0 0;
    accent-color: var(--v4-brand-accent, #4c6fff);
  }
  .cloud-size-option {
    flex: 1 1 170px;
  }
  .cloud-size-option.unavailable {
    opacity: 0.58;
    cursor: default;
  }
  .cloud-size-copy {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .cloud-size-copy strong {
    font-weight: 500;
  }
  .cloud-size-copy small {
    color: var(--t3);
    font-size: 13px;
    line-height: 1.45;
  }
  .cloud-retry {
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--panel-border, var(--v4-control-border, var(--border)));
    border-radius: 6px;
    background: var(--v4-control-bg, transparent);
    color: var(--t1);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  .cloud-retry:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .handle-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .handle-at {
    color: var(--t3);
    font-size: 13px;
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

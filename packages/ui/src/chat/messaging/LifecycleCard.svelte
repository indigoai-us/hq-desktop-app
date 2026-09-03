<script lang="ts">
  /**
   * Server-stamped lifecycle card (US-008). Markup follows the locked
   * storyboard: a hairline step, mono label, title, controls, one action row.
   * No card chrome. Zero-network — actions bubble via `oncardaction`.
   */
  import type {
    LifecycleCardAction,
    LifecycleCardActionEvent,
    LifecycleCardField,
    LifecycleCardModel,
    LifecycleCardState,
  } from "./channelMessageModels";

  interface Props {
    model: LifecycleCardModel;
    channelId?: string | null;
    onopenurl?: (url: string) => void;
    oncardaction?: (event: LifecycleCardActionEvent) => void;
  }

  let { model, channelId = "", onopenurl, oncardaction }: Props = $props();

  let cardEl = $state<HTMLElement | null>(null);
  let localPending = $state(false);
  let values = $state<Record<string, string>>({});
  let localErrors = $state<Record<string, string>>({});
  let lastSeed = "";

  const displayState = $derived<LifecycleCardState>(
    localPending && model.state === "open" ? "pending" : model.state,
  );
  const collapsed = $derived(
    displayState === "done" || displayState === "skipped",
  );
  const canRetry = $derived(
    model.viewer.canAct &&
      displayState === "blocked" &&
      model.actions.some((action) => action.id === "retry"),
  );
  const canEdit = $derived(
    (model.viewer.canAct && displayState === "open" && !localPending) ||
      canRetry,
  );
  const liveStep = $derived(
    displayState === "open" ||
      displayState === "pending" ||
      displayState === "blocked",
  );
  const statusText = $derived(statusLabelFor(model, displayState));
  const askLabel = $derived(askWho(model.viewer.actorName));

  $effect.pre(() => {
    const key = `${model.cardId}:${model.state}:${model.fields
      .map((field) => `${field.id}=${field.value}:${field.error ?? ""}`)
      .join("|")}`;
    if (key === lastSeed) return;
    lastSeed = key;
    const seed: Record<string, string> = {};
    for (const field of model.fields) seed[field.id] = field.value ?? "";
    values = seed;
    localErrors = {};
    localPending = false;
  });

  function statusLabelFor(
    card: LifecycleCardModel,
    state: LifecycleCardState,
  ): string | null {
    if (card.statusLabel) return card.statusLabel;
    if (state === "pending") return "Pending";
    if (state === "done") return "Done";
    if (state === "blocked") return "Blocked";
    if (state === "skipped") return "Skipped";
    return null;
  }

  function askWho(actorName: string | null): string {
    const name = actorName?.trim();
    if (!name) return "Ask the owner";
    const first = name.split(/\s+/)[0] ?? name;
    return `Ask ${first}`;
  }

  function fieldError(field: LifecycleCardField): string | null {
    return localErrors[field.id] || field.error || null;
  }

  function isWide(field: LifecycleCardField): boolean {
    if (field.control !== "text") return true;
    return model.fields.filter((row) => row.control === "text").length === 1;
  }

  function setValue(fieldId: string, value: string): void {
    values = { ...values, [fieldId]: value };
    if (localErrors[fieldId]) {
      const next = { ...localErrors };
      delete next[fieldId];
      localErrors = next;
    }
  }

  function openUrl(url: string | null): void {
    const href = url?.trim();
    if (!href) return;
    if (onopenurl) {
      onopenurl(href);
      return;
    }
    if (typeof window !== "undefined") {
      window.open(href, "_blank", "noopener,noreferrer");
    }
  }

  function focusCard(): void {
    cardEl?.focus();
  }

  function submitAction(action: LifecycleCardAction): void {
    if (action.style === "link") {
      if (action.href) openUrl(action.href);
      else emitAction(action.id);
      return;
    }
    if (!canEdit) return;
    const errors: Record<string, string> = {};
    for (const field of model.fields) {
      if (!field.required || field.control === "readonly") continue;
      if (!(values[field.id] ?? "").trim()) errors[field.id] = "Required";
    }
    if (Object.keys(errors).length > 0) {
      localErrors = errors;
      return;
    }
    emitAction(action.id);
  }

  function emitAction(actionId: string): void {
    localPending = true;
    oncardaction?.({
      channelId: channelId ?? "",
      cardId: model.cardId,
      actionId,
      values: { ...values },
    });
    focusCard();
  }

  function onTextKeydown(
    event: KeyboardEvent,
    field: LifecycleCardField,
  ): void {
    if (event.key !== "Enter") return;
    if (event.shiftKey) return;
    const textFields = model.fields.filter((row) => row.control === "text");
    if (textFields.length !== 1 || textFields[0]?.id !== field.id) return;
    const primary = model.actions.find((row) => row.style === "primary");
    if (!primary) return;
    event.preventDefault();
    submitAction(primary);
  }

  function fieldInputId(field: LifecycleCardField): string {
    return `lc-${model.cardId}-${field.id}`;
  }
</script>

<article
  bind:this={cardEl}
  class="lc"
  class:lc-summary={model.cardKind === "companies_summary"}
  class:lc-collapsed={collapsed}
  data-testid="lifecycle-card"
  data-card-id={model.cardId}
  data-card-kind={model.cardKind}
  data-state={displayState}
  data-can-act={model.viewer.canAct ? "true" : "false"}
  aria-label={model.title}
  aria-busy={displayState === "pending" ? "true" : undefined}
  tabindex="-1"
>
  <header class="lc-hd">
    {#if liveStep && model.stepLabel}
      <span class="lc-k">{model.stepLabel}</span>
    {/if}
    <h4 class="lc-title">{model.title}</h4>
    {#if statusText}
      <span
        class="lc-st"
        class:pn={displayState === "pending"}
        class:ok={displayState === "done"}
        class:bk={displayState === "blocked"}
        data-testid="lifecycle-card-status"
      >
        {#if displayState === "pending"}
          <span class="lc-spin" aria-hidden="true"></span>
        {:else if displayState === "done"}
          <svg
            class="lc-check"
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="m3.5 8.5 3 3 6-7"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        {/if}
        {statusText}
      </span>
    {/if}
  </header>

  {#if !collapsed}
    {#if model.summary}
      <p class="lc-summary-copy">{model.summary}</p>
    {/if}

    {#if displayState === "blocked" && model.reason}
      <p class="lc-reason" role="alert" data-testid="lifecycle-card-reason">
        {model.reason}
      </p>
    {/if}

    {#if model.fields.length > 0}
      <div class="lc-fields">
        {#each model.fields as field (field.id)}
          {@const error = fieldError(field)}
          {@const current = values[field.id] ?? ""}
          <div
            class="lc-field"
            class:wide={isWide(field)}
            data-testid={`lifecycle-field-${field.id}`}
            data-control={field.control}
          >
            {#if field.control === "text"}
              <label class="lc-label" for={fieldInputId(field)}
                >{field.label}</label
              >
              {#if canEdit}
                <div class="lc-in" data-size="32" class:err={!!error} class:ok={!!field.hint && !error}>
                  <input
                    id={fieldInputId(field)}
                    class="lc-input"
                    type="text"
                    name={field.id}
                    value={current}
                    required={field.required}
                    aria-invalid={error ? "true" : undefined}
                    aria-describedby={error
                      ? `${fieldInputId(field)}-error`
                      : field.hint
                        ? `${fieldInputId(field)}-hint`
                        : undefined}
                    oninput={(event) =>
                      setValue(
                        field.id,
                        (event.currentTarget as HTMLInputElement).value,
                      )}
                    onkeydown={(event) => onTextKeydown(event, field)}
                  />
                  {#if field.hint}
                    <span
                      class="lc-hint"
                      id={`${fieldInputId(field)}-hint`}>{field.hint}</span
                    >
                  {/if}
                </div>
              {:else}
                <div class="lc-in lc-in-ro" aria-readonly="true">
                  <span>{current}</span>
                  {#if field.hint}
                    <span class="lc-hint">{field.hint}</span>
                  {/if}
                </div>
              {/if}
              {#if error}
                <p
                  class="lc-error"
                  id={`${fieldInputId(field)}-error`}
                  role="alert"
                  data-testid={`lifecycle-field-error-${field.id}`}
                >
                  {error}
                </p>
              {/if}
            {:else if field.control === "select"}
              <span class="lc-label" id={`${fieldInputId(field)}-label`}
                >{field.label}</span
              >
              {#if model.viewer.canAct}
                <div
                  class="lc-seg"
                  role="radiogroup"
                  aria-labelledby={`${fieldInputId(field)}-label`}
                  data-testid={`lifecycle-select-${field.id}`}
                >
                  {#each field.options as option (option.id)}
                    <button
                      type="button"
                      class="lc-seg-btn"
                      data-size="32"
                      class:on={current === option.id}
                      role="radio"
                      aria-checked={current === option.id}
                      disabled={!canEdit}
                      onclick={() => canEdit && setValue(field.id, option.id)}
                    >
                      {option.label}
                    </button>
                  {/each}
                </div>
              {:else}
                <p class="lc-ro-value">
                  {field.options.find((option) => option.id === current)?.label ||
                    current}
                </p>
              {/if}
            {:else if field.control === "radio"}
              <span class="lc-label" id={`${fieldInputId(field)}-label`}
                >{field.label}</span
              >
              {#if model.viewer.canAct}
                <div
                  class="lc-radios"
                  role="radiogroup"
                  aria-labelledby={`${fieldInputId(field)}-label`}
                  data-testid={`lifecycle-radio-${field.id}`}
                >
                  {#each field.options as option (option.id)}
                    <button
                      type="button"
                      class="lc-radio"
                      data-size="40"
                      class:on={current === option.id}
                      role="radio"
                      aria-checked={current === option.id}
                      disabled={!canEdit}
                      onclick={() => canEdit && setValue(field.id, option.id)}
                    >
                      <span class="lc-radio-o" aria-hidden="true"></span>
                      <span class="lc-radio-copy">
                        <b>{option.label}</b>
                        {#if option.description}
                          <span class="lc-radio-desc">· {option.description}</span>
                        {/if}
                      </span>
                      {#if option.price}
                        <span class="lc-pr">{option.price}</span>
                      {/if}
                    </button>
                  {/each}
                </div>
              {:else}
                <p class="lc-ro-value">
                  {field.options.find((option) => option.id === current)?.label ||
                    current}
                </p>
              {/if}
            {:else}
              <div class="lc-ro" data-size="36">
                <span class="lc-ro-label">{field.label}</span>
                <span class="lc-ro-value">
                  {#if field.hint === "done" || current === "done"}
                    <svg
                      class="lc-check"
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="m3.5 8.5 3 3 6-7"
                        stroke="currentColor"
                        stroke-width="1.6"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      />
                    </svg>
                  {/if}
                  <span>{current || field.description || ""}</span>
                </span>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    {#if model.viewer.canAct && model.actions.length > 0 && displayState !== "pending"}
      <div class="lc-acts">
        {#each model.actions as action (action.id)}
          <button
            type="button"
            class="lc-btn"
            class:primary={action.style === "primary"}
            class:ghost={action.style === "secondary"}
            class:link={action.style === "link"}
            class:row={action.style === "link"}
            data-size={action.style === "link" ? "28" : "32"}
            data-testid={`lifecycle-action-${action.id}`}
            disabled={action.style !== "link" &&
              (displayState === "blocked" || !canEdit)}
            onclick={() => submitAction(action)}
          >
            {action.label}
          </button>
        {/each}
      </div>
    {/if}

    {#if model.help && model.viewer.canAct}
      <p class="lc-help">{model.help}</p>
    {/if}

    {#if !model.viewer.canAct}
      <p class="lc-ask" data-testid="lifecycle-card-ask">{askLabel}</p>
    {/if}
  {/if}
</article>

<style>
  .lc {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 100%;
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid var(--line, var(--pop-border));
    background: transparent;
    outline: none;
  }

  .lc:focus-visible {
    box-shadow: 0 0 0 2px var(--t1, var(--pop-text));
  }

  .lc-collapsed {
    gap: 0;
  }

  .lc-hd {
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }

  .lc-k {
    font-family: var(--font-mono, ui-monospace, Menlo, monospace);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--t2, var(--pop-muted));
    white-space: nowrap;
  }

  .lc-title {
    margin: 0;
    font-size: 15px;
    font-weight: 500;
    letter-spacing: -0.005em;
    color: var(--t1, var(--pop-text));
    min-width: 0;
  }

  .lc-st {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono, ui-monospace, Menlo, monospace);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--t3, var(--pop-muted));
    white-space: nowrap;
  }

  .lc-st.pn {
    color: var(--warn, #facc15);
  }

  .lc-st.ok {
    color: var(--ok, #34c759);
  }

  .lc-st.bk {
    color: var(--red, #f0616d);
  }

  .lc-check {
    color: var(--ok, #34c759);
    flex: 0 0 auto;
  }

  .lc-spin {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 2px solid var(--line2, var(--pop-border));
    border-top-color: var(--warn, #facc15);
    display: inline-block;
    animation: lc-spin 700ms linear infinite;
  }

  @keyframes lc-spin {
    to {
      transform: rotate(360deg);
    }
  }

  .lc-summary-copy,
  .lc-help,
  .lc-reason,
  .lc-ask {
    margin: 0;
    font-size: 13px;
    line-height: 1.5;
    color: var(--t2, var(--pop-muted));
  }

  .lc-reason {
    color: var(--red, #f0616d);
  }

  .lc-ask {
    color: var(--t1, var(--pop-text));
    text-decoration: none;
  }

  .lc-fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .lc-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }

  .lc-field.wide {
    grid-column: 1 / -1;
  }

  .lc-label {
    font-size: 12px;
    color: var(--t2, var(--pop-muted));
  }

  .lc-in {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    height: 32px;
    padding: 0 10px;
    border: 1px solid var(--line2, var(--pop-border));
    border-radius: 6px;
    background: var(--raised, var(--pop-hover));
    box-sizing: border-box;
  }

  .lc-in.ok {
    border-color: color-mix(in oklab, var(--ok, #34c759) 50%, transparent);
  }

  .lc-in.err {
    border-color: color-mix(in oklab, var(--red, #f0616d) 60%, transparent);
  }

  .lc-input {
    flex: 1 1 auto;
    min-width: 0;
    height: 30px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--t1, var(--pop-text));
    font: inherit;
    font-size: 13px;
    outline: none;
  }

  .lc-hint {
    font-family: var(--font-mono, ui-monospace, Menlo, monospace);
    font-size: 11px;
    color: var(--t3, var(--pop-muted));
    white-space: nowrap;
  }

  .lc-in.ok .lc-hint {
    color: var(--ok, #34c759);
  }

  .lc-in.err .lc-hint {
    color: var(--red, #f0616d);
  }

  .lc-error {
    margin: 0;
    font-size: 12px;
    color: var(--red, #f0616d);
  }

  .lc-seg {
    display: inline-flex;
    border: 1px solid var(--line2, var(--pop-border));
    border-radius: 6px;
    overflow: hidden;
    width: fit-content;
    max-width: 100%;
  }

  .lc-seg-btn {
    height: 32px;
    padding: 0 14px;
    border: 0;
    border-left: 1px solid var(--line, var(--pop-border));
    background: transparent;
    color: var(--t2, var(--pop-muted));
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    box-sizing: border-box;
  }

  .lc-seg-btn:first-child {
    border-left: none;
  }

  .lc-seg-btn.on {
    background: var(--sel, var(--pop-hover));
    color: var(--t1, var(--pop-text));
  }

  .lc-seg-btn:disabled {
    cursor: default;
    opacity: 0.65;
  }

  .lc-radios {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--line2, var(--pop-border));
    border-radius: 6px;
    overflow: hidden;
  }

  .lc-radio {
    display: grid;
    grid-template-columns: 16px 1fr auto;
    align-items: center;
    gap: 12px;
    height: 40px;
    padding: 0 12px;
    border: 0;
    border-top: 1px solid var(--line, var(--pop-border));
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    box-sizing: border-box;
  }

  .lc-radio:first-child {
    border-top: none;
  }

  .lc-radio.on {
    background: var(--sel, var(--pop-hover));
  }

  .lc-radio:disabled {
    cursor: default;
  }

  .lc-radio-o {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1.5px solid var(--t3, var(--pop-muted));
    box-sizing: border-box;
  }

  .lc-radio.on .lc-radio-o {
    border-color: var(--t1, var(--pop-text));
    background: radial-gradient(
      circle,
      var(--t1, var(--pop-text)) 45%,
      transparent 50%
    );
  }

  .lc-radio-copy {
    min-width: 0;
    font-size: 13px;
    color: var(--t1, var(--pop-text));
  }

  .lc-radio-copy b {
    font-weight: 500;
  }

  .lc-radio-desc {
    color: var(--t2, var(--pop-muted));
  }

  .lc-pr {
    font-family: var(--font-mono, ui-monospace, Menlo, monospace);
    font-size: 12px;
    color: var(--t1, var(--pop-text));
    white-space: nowrap;
  }

  .lc-ro {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    height: 36px;
    border-top: 1px solid var(--line, var(--pop-border));
    box-sizing: border-box;
  }

  .lc-field:first-child .lc-ro {
    border-top: none;
  }

  .lc-ro-label {
    color: var(--t2, var(--pop-muted));
  }

  .lc-ro-value {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--t1, var(--pop-text));
  }

  .lc-acts {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: center;
  }

  .lc-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 32px;
    min-height: 32px;
    padding: 0 14px;
    border: 1px solid var(--line2, var(--pop-border));
    border-radius: 0;
    background: transparent;
    color: var(--t1, var(--pop-text));
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    text-decoration: none;
    cursor: pointer;
    box-sizing: border-box;
    transition:
      background-color 140ms cubic-bezier(0.25, 1, 0.5, 1),
      border-color 140ms cubic-bezier(0.25, 1, 0.5, 1),
      opacity 140ms cubic-bezier(0.25, 1, 0.5, 1);
  }

  .lc-btn.primary {
    border-color: var(--t1, var(--pop-text));
    background: var(--t1, var(--pop-text));
    color: var(--elevated, #0a0b0d);
  }

  .lc-btn.ghost {
    background: transparent;
    border-color: var(--line2, var(--pop-border));
    color: var(--t1, var(--pop-text));
  }

  .lc-btn.link,
  .lc-btn.row {
    height: 28px;
    padding: 0 10px;
    font-size: 12px;
    text-decoration: none;
  }

  .lc-btn:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .lc-btn:focus-visible,
  .lc-seg-btn:focus-visible,
  .lc-radio:focus-visible,
  .lc-input:focus-visible {
    outline: 2px solid var(--t1, var(--pop-text));
    outline-offset: 1px;
  }

  .lc-summary .lc-fields {
    grid-template-columns: 1fr;
  }

  @media (prefers-reduced-motion: reduce) {
    .lc-spin {
      animation: none;
    }

    .lc-btn,
    .lc-seg-btn,
    .lc-radio {
      transition: none;
    }
  }
</style>

<script lang="ts">
  import { onMount } from "svelte";
  import type { AdapterPromise, AgentProvisionOptionsView } from "@hq/platform";
  import type { EntryPointResult, EntryPointTarget, CloudBotDraft } from "../lifecycle-entry-points.js";
  import {
    botHandle,
    cloudNameIssue,
    firstSignedInCloudRuntime,
    handleIssue,
    type BotRuntime,
  } from "./create-bot-model.js";

  type Company = { companyUid: string; label: string };

  export interface NewBotCreated {
    name: string;
    companyUid: string;
    brain: BotRuntime;
    target: EntryPointTarget;
  }

  interface Props {
    companies: readonly Company[];
    currentCompanyUid?: string | null;
    runtimeReady?: Record<string, boolean> | null;
    loadProvisionOptions: (companyUid: string) => AdapterPromise<AgentProvisionOptionsView>;
    oncreate: (companyUid: string, draft: CloudBotDraft) => Promise<EntryPointResult>;
    oncomplete: (created: NewBotCreated) => void;
  }

  let {
    companies,
    currentCompanyUid = null,
    runtimeReady = null,
    loadProvisionOptions,
    oncreate,
    oncomplete,
  }: Props = $props();

  const initialCompany = (companies.find((company) => company.companyUid === currentCompanyUid) ?? companies[0])?.companyUid ?? "";
  let companyUid = $state(initialCompany);
  let name = $state("");
  let handle = $state("");
  let runtime = $state<BotRuntime>(firstSignedInCloudRuntime(runtimeReady));
  let options = $state<AgentProvisionOptionsView | null>(null);
  let quoteStatus = $state<"loading" | "ready" | "error">("loading");
  let selectedSize = $state<"basic" | "power" | "dev" | "">("");
  let runtimeChosen = $state(false);
  let moreOptions = $state(false);
  let emailUpdates = $state(false);
  let attempted = $state(false);
  let busy = $state(false);
  let refusal = $state<string | null>(null);
  // This only guards stale promise completions. It intentionally is not
  // reactive: changing it must not retrigger the loading effect.
  let quoteGeneration = 0;

  const derivedHandle = $derived(botHandle({ name, handle }));
  const nameIssue = $derived(cloudNameIssue(name));
  const handleIssueText = $derived(handleIssue({ name, handle }));
  const selectedOption = $derived(options?.options.find((option) => option.key === selectedSize) ?? null);
  const defaultOption = $derived(options?.options.find((option) => option.default && option.selectable && option.netMonthlyCents !== null) ?? null);
  const issue = $derived(nameIssue ?? handleIssueText);
  const canSubmit = $derived(!busy && !!companyUid && !!selectedOption?.selectable && selectedOption.netMonthlyCents !== null && quoteStatus === "ready");
  const canCreate = $derived(canSubmit && !issue);

  function monthly(cents: number): string {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
  }

  function optionPrice(option: AgentProvisionOptionsView["options"][number]): string {
    if (option.notBilled) return "Included for your company";
    return option.netMonthlyCents === null ? "Price unavailable" : `${monthly(option.netMonthlyCents)}/month`;
  }

  function chooseSizeAfterLoad(value: AgentProvisionOptionsView): void {
    const preferred = value.options.find((option) => option.default && option.selectable && option.netMonthlyCents !== null)
      ?? value.options.find((option) => option.selectable && option.netMonthlyCents !== null);
    selectedSize = preferred?.key ?? "";
  }

  $effect(() => {
    if (!runtimeChosen) runtime = firstSignedInCloudRuntime(runtimeReady);
  });

  $effect(() => {
    const uid = companyUid.trim();
    const generation = ++quoteGeneration;
    options = null;
    quoteStatus = uid ? "loading" : "error";
    if (!uid) return;
    let active = true;
    void loadProvisionOptions(uid)
      .then((result) => {
        if (!active || generation !== quoteGeneration || !result.ok || !Array.isArray(result.value.options)) {
          if (active && generation === quoteGeneration) quoteStatus = "error";
          return;
        }
        options = result.value;
        quoteStatus = "ready";
        chooseSizeAfterLoad(result.value);
      })
      .catch(() => {
        if (active && generation === quoteGeneration) quoteStatus = "error";
      });
    return () => { active = false; };
  });

  onMount(() => {
    const input = document.querySelector<HTMLInputElement>("[data-testid='new-bot-name']");
    input?.focus();
  });

  async function submit(): Promise<void> {
    attempted = true;
    refusal = null;
    if (!canCreate || busy) return;
    busy = true;
    const result = await oncreate(companyUid, {
      name: name.trim(),
      handle: derivedHandle,
      runtime,
      size: selectedSize as "basic" | "power" | "dev",
      authMode: "subscription",
    }).catch((): EntryPointResult => ({
      ok: false,
      blocked: false,
      reason: "We couldn't create this bot. Try again in a moment.",
    }));
    busy = false;
    if (result.ok) {
      oncomplete({ name: name.trim(), companyUid, brain: runtime, target: result.target });
      return;
    }
    const message = result.reason.trim() || "We couldn't create this bot. Try again in a moment.";
    const sentence = message.match(/^.*?[.!?](?:\s|$)/)?.[0].trim();
    refusal = sentence || message;
  }
</script>

<div class="new-bot-create" data-testid="new-bot-create-screen">
  <p class="new-bot-takeover-kicker">A new teammate</p>
  <h1 id="new-bot-takeover-title">Make it <em>yours.</em></h1>
  <p class="new-bot-create-copy">Choose a name and the brain it will use.</p>

  <label class="new-bot-create-label" for="new-bot-name">Name</label>
  <div class="new-bot-name-row">
    <input
      id="new-bot-name"
      class="new-bot-create-input"
      data-testid="new-bot-name"
      value={name}
      aria-invalid={attempted && nameIssue ? "true" : undefined}
      aria-describedby="new-bot-handle new-bot-create-issue"
      autocomplete="off"
      oninput={(event) => { name = (event.currentTarget as HTMLInputElement).value; }}
    />
    <span id="new-bot-handle" class="new-bot-handle" data-testid="new-bot-derived-handle">@{derivedHandle || "handle"}</span>
  </div>

  <fieldset class="new-bot-brains" disabled={busy}>
    <legend class="new-bot-create-label">Brain</legend>
    {#each (["codex", "claude", "grok"] as const) as choice}
      <label class:selected={runtime === choice} class="new-bot-brain">
        <input type="radio" name="new-bot-brain" value={choice} checked={runtime === choice} onchange={() => { runtimeChosen = true; runtime = choice; }} />
        <span>{choice === "codex" ? "Codex" : choice === "claude" ? "Claude" : "Grok"}</span>
        {#if runtimeReady?.[choice] === true}<small>Signed in on this Mac</small>{/if}
      </label>
    {/each}
  </fieldset>

  <label class="new-bot-create-label" for="new-bot-company">Company</label>
  <select
    id="new-bot-company"
    class="new-bot-create-input"
    data-testid="new-bot-company"
    value={companyUid}
    disabled={busy}
    onchange={(event) => { companyUid = (event.currentTarget as HTMLSelectElement).value; }}
  >
    {#each companies as company (company.companyUid)}
      <option value={company.companyUid}>{company.label}</option>
    {/each}
  </select>

  <button type="button" class="new-bot-more" aria-expanded={moreOptions} onclick={() => (moreOptions = !moreOptions)}>
    More options
  </button>
  {#if moreOptions}
    <div class="new-bot-advanced" data-testid="new-bot-advanced-options">
      <label class="new-bot-create-label" for="new-bot-handle-input">Handle</label>
      <input id="new-bot-handle-input" class="new-bot-create-input" value={handle} placeholder={derivedHandle} disabled={busy} oninput={(event) => { handle = (event.currentTarget as HTMLInputElement).value; }} />
      <fieldset class="new-bot-sizes" disabled={busy || quoteStatus !== "ready"}>
        <legend class="new-bot-create-label">Size</legend>
        {#each options?.options ?? [] as option (option.key)}
          <label class:selected={selectedSize === option.key} class="new-bot-size">
            <input type="radio" name="new-bot-size" value={option.key} checked={selectedSize === option.key} disabled={!option.selectable || option.netMonthlyCents === null} onchange={() => (selectedSize = option.key)} />
            <span>{option.productName} · {optionPrice(option)}</span>
          </label>
        {:else}
          <span class="new-bot-muted">{quoteStatus === "loading" ? "Loading server options..." : "Server options could not be loaded."}</span>
        {/each}
      </fieldset>
      <label class="new-bot-email"><input type="checkbox" bind:checked={emailUpdates} disabled={busy} /> Email me when it is ready</label>
    </div>
  {/if}

  {#if attempted && issue}
    <p id="new-bot-create-issue" class="new-bot-create-error" role="alert">{issue}</p>
  {:else if refusal}
    <p id="new-bot-create-issue" class="new-bot-create-error" role="alert">{refusal}</p>
  {/if}

  <button type="button" class="new-bot-create-submit" data-testid="new-bot-create-submit" disabled={!canSubmit} aria-busy={busy ? "true" : undefined} onclick={() => void submit()}>
    {busy ? "Creating bot..." : "Create bot"}
  </button>
  {#if defaultOption}
    <p class="new-bot-price" data-testid="new-bot-default-price">{optionPrice(defaultOption)} for {defaultOption.productName}.</p>
  {:else if quoteStatus === "loading"}
    <p class="new-bot-price" aria-live="polite">Loading the server's default price...</p>
  {/if}
</div>

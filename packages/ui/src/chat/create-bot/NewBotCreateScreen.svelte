<script lang="ts">
  import RailIcon from "../../common/button/RailIcon.svelte";
  import { onMount, tick, untrack } from "svelte";
  import { hostComputerNoun, subscribeHostComputerNoun, type AdapterPromise, type AgentProvisionOptionsView } from "@hq/platform";
  import {
    CLOUD_BOT_NAME_INVALID_REASON,
    isUpgradePlanCard,
    type EntryPointResult,
    type EntryPointTarget,
    type CloudBotDraft,
  } from "../lifecycle-entry-points.js";
  import {
    botHandle,
    cloudBrainChoices,
    cloudNameIssue,
    firstSignedInCloudRuntime,
    handleIssue,
    NEW_BOT_COMPANY_GONE_REASON,
    NEW_BOT_LOCAL_LABEL,
    newBotCheckingLine,
    provisionOptionsPriced,
    provisionOptionsProblem,
    provisionOptionsProblemLine,
    type BotRuntime,
    type ProvisionOptionsProblem,
  } from "./create-bot-model.js";
  import NewBotDawn from "./NewBotDawn.svelte";
  import NewBotStepHead from "./NewBotStepHead.svelte";
  import IdentityMark from "../messaging/IdentityMark.svelte";

  type Company = { companyUid: string; label: string };
  export interface NewBotCreated { name: string; companyUid: string; brain: BotRuntime; target: EntryPointTarget; }
  export interface NewBotUpgradeTarget { companyUid: string; channelId: string; cardId: string; }
  interface Props {
    /** The bot's name, given on the takeover's first step. */
    name: string;
    /**
     * How many New bot steps came before this screen (the name, and the
     * Cloud or Local question when it was asked), so the dots count the
     * whole flow.
     */
    leadSteps?: number;
    companies: readonly Company[];
    currentCompanyUid?: string | null;
    runtimeReady?: Record<string, boolean> | null;
    /**
     * True once the host read the Claude provider flag as on. Claude is
     * offered only then: the server refuses a Claude bot for everyone else.
     */
    claudeEnabled?: boolean;
    loadProvisionOptions: (companyUid: string) => AdapterPromise<AgentProvisionOptionsView>;
    oncreate: (companyUid: string, draft: CloudBotDraft) => Promise<EntryPointResult>;
    /**
     * True while the host looks for a bot whose create got no answer. The
     * screen says so in place of "Getting things ready.", and Create bot
     * stays held: nothing is sent again until the look is over.
     */
    checking?: boolean;
    oncomplete: (created: NewBotCreated) => void;
    onopenlocal?: (() => void) | null;
    /**
     * What the button for `onopenlocal` says. It opens the "+" window's bot
     * step, which also makes cloud bots in companies this screen does not
     * list, and the label says so when there are any.
     */
    otherWayLabel?: string;
    /**
     * True when the person belongs to more than one company. The plan line
     * then names the company the bot will be created in, whether it was
     * picked here or is the only one this screen offers.
     */
    nameCompany?: boolean;
    /** Open the company channel on its upgrade card. Without it the plan refusal stays an inline message. */
    onupgrade?: ((target: NewBotUpgradeTarget) => void) | null;
    /** Back from the first step: the "Cloud or Local?" question, or the name. Without it the first step has no Back. */
    onback?: (() => void) | null;
  }
  let {
    name: givenName,
    leadSteps = 2,
    companies,
    currentCompanyUid = null,
    runtimeReady = null,
    claudeEnabled = false,
    loadProvisionOptions,
    oncreate,
    oncomplete,
    onopenlocal = null,
    onback = null,
    otherWayLabel = "",
    nameCompany = false,
    checking = false,
    onupgrade = null,
  }: Props = $props();
  const otherWay = $derived(otherWayLabel.trim() || NEW_BOT_LOCAL_LABEL);

  // A company that sent the person to a card instead of making a bot: where
  // that card lives. Usually the upgrade card (the plan cannot host a cloud
  // bot); `upgradeIsPlan` is false for any other card, which is never
  // described as an upgrade.
  let upgrade = $state<NewBotUpgradeTarget | null>(null);
  let upgradeIsPlan = $state(true);
  /** "Mac", "PC" or "computer": the machine this app runs on. */
  let hostNoun = $state(hostComputerNoun());
  onMount(() => subscribeHostComputerNoun((next) => (hostNoun = next)));
  const upgradeCompany = $derived(companies.find((company) => company.companyUid === upgrade?.companyUid)?.label ?? "This company");
  const initialCompany = (companies.find((company) => company.companyUid === currentCompanyUid) ?? companies[0])?.companyUid ?? "";
  let companyUid = $state(initialCompany);
  /** Read once: the name was given on the step before and is not changed here. */
  const name = untrack(() => givenName.trim());
  /** The brains this screen shows. A brain that is not here is never selected. */
  const brainChoices = $derived(cloudBrainChoices(claudeEnabled));
  let runtime = $state<BotRuntime>(firstSignedInCloudRuntime(runtimeReady, cloudBrainChoices(claudeEnabled)));
  let options = $state<AgentProvisionOptionsView | null>(null);
  let quoteStatus = $state<"loading" | "ready" | "error">("loading");
  /** Why the options did not load. Set while `quoteStatus` is "error". */
  let quoteProblem = $state<ProvisionOptionsProblem | null>(null);
  /** Bumped by Try again: reads the selected company's options once more. */
  let quoteReload = $state(0);
  let selectedSize = $state<"basic" | "power" | "dev" | "">("");
  let runtimeChosen = $state(false);
  let busy = $state(false);
  let refusal = $state<string | null>(null);
  /**
   * 2: the brain. 3: the company, when there is more than one. 4: the
   * machine size. (The name, step 1, is the takeover's.) Only the brain is
   * required: every step but the last can "Finish with defaults".
   */
  type Step = 2 | 3 | 4;
  let step = $state<Step>(2);
  let quoteGeneration = 0;
  let companyFilter = $state("");
  let companyFocusUid = $state(initialCompany);
  const singleCompany = $derived(companies.length === 1);
  const steps = $derived<Step[]>(singleCompany ? [2, 4] : [2, 3, 4]);
  const stepIndex = $derived(Math.max(0, steps.indexOf(step)));
  const nextOf = $derived<Step | null>(steps[stepIndex + 1] ?? null);
  const prevOf = $derived<Step | null>(stepIndex > 0 ? (steps[stepIndex - 1] ?? null) : null);
  const isLast = $derived(nextOf === null);
  const STEP_NAMES: Record<Step, string> = { 2: "Brain", 3: "Company", 4: "Size" };
  const filteredCompanies = $derived(companies.filter((company) => company.label.toLocaleLowerCase().includes(companyFilter.trim().toLocaleLowerCase())));
  /**
   * The grid never scrolls: it shows at most four rows of three. Past that
   * the filter finds the rest, and the picked company always stays in view.
   */
  const COMPANY_TILES = 12;
  const shownCompanies = $derived.by(() => {
    if (filteredCompanies.length <= COMPANY_TILES) return filteredCompanies;
    const first = filteredCompanies.slice(0, COMPANY_TILES);
    if (first.some((company) => company.companyUid === companyUid)) return first;
    const picked = filteredCompanies.find((company) => company.companyUid === companyUid);
    return picked ? [...first.slice(0, COMPANY_TILES - 1), picked] : first;
  });
  const hiddenCompanies = $derived(filteredCompanies.length - shownCompanies.length);
  const derivedHandle = $derived(botHandle({ name, handle: "" }));
  // The handle is made from the name and never shown. The name step already
  // refused a name with no letter or digit the handle can use; this holds
  // Create bot if one ever arrives anyway.
  const nameIssue = $derived(
    cloudNameIssue(name) ?? (handleIssue({ name, handle: "" }) ? CLOUD_BOT_NAME_INVALID_REASON : null),
  );
  const selectedOption = $derived(options?.options.find((option) => option.key === selectedSize) ?? null);
  /** The size Create bot will ask for, when it can be priced. Its price is the one shown. */
  const pricedOption = $derived(selectedOption?.selectable && selectedOption.netMonthlyCents !== null ? selectedOption : null);
  // The list can change while the screen is open. A company that left it is
  // not one this screen may create in, so Create bot is off and says why.
  const companyGone = $derived(!!companyUid && !companies.some((company) => company.companyUid === companyUid));
  const canSubmit = $derived(
    !busy &&
      !!companyUid &&
      !companyGone &&
      brainChoices.includes(runtime) &&
      !!selectedOption?.selectable &&
      selectedOption.netMonthlyCents !== null &&
      quoteStatus === "ready",
  );
  const canCreate = $derived(canSubmit && !nameIssue);

  function monthly(cents: number): string { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100); }
  function optionPrice(option: AgentProvisionOptionsView["options"][number]): string { return option.notBilled || option.netMonthlyCents === 0 ? "Included for your company" : option.netMonthlyCents === null ? "Price unavailable" : `${monthly(option.netMonthlyCents)}/month`; }
  function brainLabel(choice: BotRuntime): string { return choice === "codex" ? "Codex" : choice === "claude" ? "Claude" : "Grok"; }
  function focusStep(): void { void tick().then(() => document.querySelector<HTMLElement>(`[data-testid="new-bot-step-${step}"] input:not([disabled]), [data-testid="new-bot-step-${step}"] button:not([disabled])`)?.focus()); }
  function go(next: Step): void { refusal = null; step = next; focusStep(); }
  function chooseSizeAfterLoad(value: AgentProvisionOptionsView): void { const preferred = value.options.find((option) => option.default && option.selectable && option.netMonthlyCents !== null) ?? value.options.find((option) => option.selectable && option.netMonthlyCents !== null); selectedSize = preferred?.key ?? ""; }
  function selectCompany(next: string): void { if (busy) return; companyUid = next; companyFocusUid = next; }
  function leaveUpgrade(): void { upgrade = null; refusal = null; focusStep(); }
  function companyColumns(): number { return window.matchMedia("(max-width: 420px)").matches ? 1 : window.matchMedia("(max-width: 620px)").matches ? 2 : 3; }
  function focusCompanyAt(index: number): void { const radios = [...document.querySelectorAll<HTMLButtonElement>("[data-testid='new-bot-company-grid'] [role='radio']")]; const next = radios[(index + radios.length) % radios.length]; next?.focus(); companyFocusUid = next?.dataset.companyUid ?? companyFocusUid; }
  function onCompanyKeydown(event: KeyboardEvent): void {
    const visible = shownCompanies; if (!visible.length) return;
    const index = Math.max(0, visible.findIndex((company) => company.companyUid === companyFocusUid)); const columns = companyColumns();
    let next: number | null = null;
    if (event.key === "ArrowRight") next = index + 1;
    else if (event.key === "ArrowLeft") next = index - 1;
    else if (event.key === "ArrowDown") next = index + columns;
    else if (event.key === "ArrowUp") next = index - columns;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = visible.length - 1;
    if (next === null) return;
    event.preventDefault(); focusCompanyAt(next);
  }

  // The preselected brain follows what is signed in on this computer, among
  // the brains this screen offers. A brain the person picked stays, unless it
  // stops being offered (the Claude answer arrived and it is off): then the
  // pick is dropped and the preselection takes over again.
  $effect(() => {
    const offered = brainChoices;
    const ready = runtimeReady;
    untrack(() => {
      if (runtimeChosen && offered.includes(runtime)) return;
      runtimeChosen = false;
      runtime = firstSignedInCloudRuntime(ready, offered);
    });
  });
  // The selected company's options: what a bot costs there, and whether this
  // person may add one. Create bot is off until they load, so a read that
  // fails must say why and offer another try.
  $effect(() => {
    const uid = companyUid.trim();
    void quoteReload;
    const generation = ++quoteGeneration;
    options = null;
    quoteProblem = null;
    quoteStatus = uid ? "loading" : "error";
    if (!uid) return;
    let active = true;
    const current = (): boolean => active && generation === quoteGeneration;
    const fail = (answer: unknown): void => {
      if (!current()) return;
      quoteProblem = provisionOptionsProblem(answer);
      quoteStatus = "error";
    };
    void loadProvisionOptions(uid)
      .then((result) => {
        if (!current()) return;
        if (!result.ok || !Array.isArray(result.value.options)) {
          fail(result);
          return;
        }
        options = result.value;
        quoteStatus = "ready";
        chooseSizeAfterLoad(result.value);
      })
      .catch(() => fail(null));
    return () => {
      active = false;
    };
  });
  const selectedCompanyLabel = $derived(companies.find((company) => company.companyUid === companyUid)?.label ?? "");
  // The options loaded and none of them can be priced: Create bot is off
  // just as it is when they do not load, so it gets a reason and a retry too.
  const unpriced = $derived(quoteStatus === "ready" && !provisionOptionsPriced(options));
  const quoteProblemKind = $derived<ProvisionOptionsProblem["kind"] | null>(
    quoteStatus === "error" ? (quoteProblem?.kind ?? "load") : unpriced ? "unpriced" : null,
  );
  const quoteProblemLine = $derived(
    quoteProblemKind && companyUid
      ? provisionOptionsProblemLine(
          quoteProblemKind === "unpriced" ? { kind: "unpriced", askNames: [] } : (quoteProblem ?? { kind: "load", askNames: [] }),
          selectedCompanyLabel,
        )
      : "",
  );
  function reloadOptions(): void { quoteReload += 1; }
  /**
   * The plan line: once, short, above the buttons, naming the company the
   * bot will be made in. "Checking plan..." holds its place until the
   * company's options answer, so nothing moves when they do.
   */
  const planLine = $derived.by(() => {
    if (!pricedOption) return "";
    // A person in several companies is told which one (review G-1).
    const company = nameCompany && selectedCompanyLabel ? selectedCompanyLabel : "";
    if (pricedOption.notBilled || pricedOption.netMonthlyCents === 0) {
      return company ? `Included with ${company}'s plan.` : "Included with your company's plan.";
    }
    const price = `${optionPrice(pricedOption)} for ${pricedOption.productName}`;
    return company ? `${price}, billed to ${company}.` : `${price}.`;
  });
  $effect(() => { focusStep(); });
  // The sun starts low and creeps while the create request is in flight; the
  // Waking up screen takes over from the same low position. One state change,
  // no timer: the drawing is mounted at the low mark, then told the high one,
  // and its own frame loop eases the sun there (slowly in "creating" mode).
  const CREATING_FROM = 2; const CREATING_TO = 8;
  let creatingProgress = $state(CREATING_FROM);
  $effect(() => { creatingProgress = busy ? CREATING_TO : CREATING_FROM; });

  async function submit(): Promise<void> {
    refusal = null;
    if (!canCreate || busy) return;
    busy = true;
    const result = await oncreate(companyUid, { name: name.trim(), handle: derivedHandle, runtime, size: selectedSize as "basic" | "power" | "dev", authMode: "subscription" }).catch((): EntryPointResult => ({ ok: false, blocked: false, reason: "We couldn't create this bot. Try again in a moment." }));
    // Cancel was pressed while this request was out. The person has moved on:
    // no waiting screen, no message, nothing of this attempt left on screen.
    if (!result.ok && result.cancelled) return;
    busy = false;
    // A bot answers with its own channel and no card. A card in the answer
    // means nothing was created and the server sent the person to that card:
    // the upgrade card when the plan cannot host a bot, else some other step.
    if (result.ok && result.target.cardId) {
      const plan = isUpgradePlanCard(result.target.cardId);
      if (onupgrade) {
        upgradeIsPlan = plan;
        upgrade = { companyUid, channelId: result.target.channelId, cardId: result.target.cardId };
      } else {
        refusal = plan
          ? "This company's plan doesn't include cloud bots yet."
          : "This company has a step to finish before it can add a cloud bot.";
      }
      return;
    }
    if (result.ok) { oncomplete({ name: name.trim(), companyUid, brain: runtime, target: result.target }); return; }
    if (result.upgrade && onupgrade) { upgradeIsPlan = true; upgrade = { companyUid, ...result.upgrade }; return; }
    // The whole reason: a second sentence often says what to do about the first.
    refusal = result.reason.trim() || "We couldn't create this bot. Try again in a moment.";
  }
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || busy) return;
    const target = event.target as HTMLElement;
    if (target.tagName === "BUTTON") return;
    event.preventDefault();
    if (target.id === "new-bot-company-filter") {
      // Enter in the filter picks the one company it found. It never creates
      // the bot: the selected company may not even be among the ones shown.
      if (filteredCompanies.length === 1) selectCompany(filteredCompanies[0]!.companyUid);
      return;
    }
    // Enter finishes from either step, with the company the screen opened on
    // when the person has not picked one.
    void submit();
  }
</script>

{#if busy}
<!-- Creating: the same sunrise the Waking up screen continues, so pressing
     Create bot reads as one unbroken wait instead of a frozen form. -->
<section class="new-bot-waking" data-testid="new-bot-creating">
  <NewBotDawn progress={creatingProgress} mode="creating" label={`Creating ${name.trim()}`} />
  <p class="new-bot-takeover-kicker">A new teammate</p>
  <h1 id="new-bot-takeover-title">Waking up <em>{name.trim()}</em></h1>
  <p class="new-bot-waking-status" data-testid="new-bot-creating-status" data-state={checking ? "checking" : "creating"} aria-live="polite">{checking ? newBotCheckingLine(name) : "Getting things ready."}</p>
</section>
{:else if upgrade}
<!-- The company's plan cannot host a cloud bot. Say so plainly and offer the
     way forward: its upgrade card, another company, or a local bot. -->
<section class="new-bot-waking new-bot-upgrade" data-testid="new-bot-upgrade" data-kind={upgradeIsPlan ? "plan" : "other"}>
  <p class="new-bot-takeover-kicker">One step first</p>
  {#if upgradeIsPlan}
  <h1 id="new-bot-takeover-title">Upgrade to add <em>cloud bots.</em></h1>
  <p class="new-bot-waking-status" data-testid="new-bot-upgrade-copy">{upgradeCompany} is on the Starter plan. Cloud bots are part of HQ Workforce. Upgrade from the company's channel, then come back to create {name.trim()}.</p>
  {:else}
  <!-- Some other card, not the upgrade: say only what is known. -->
  <h1 id="new-bot-takeover-title">Finish a step <em>first.</em></h1>
  <p class="new-bot-waking-status" data-testid="new-bot-upgrade-copy">{upgradeCompany} has a step to finish before it can add a cloud bot. Open the company's channel to see it, then come back to create {name.trim()}.</p>
  {/if}
  <button type="button" class="new-bot-create-submit" data-testid="new-bot-upgrade-open" onclick={() => { if (upgrade) onupgrade?.(upgrade); }}><RailIcon name="external" />{upgradeIsPlan ? "See upgrade options" : "Open the channel"}</button>
  <button type="button" class="new-bot-waking-link" data-testid="new-bot-upgrade-back" onclick={leaveUpgrade}><RailIcon name="folder" />{singleCompany ? "Back" : "Choose another company"}</button>
  {#if onopenlocal}<button type="button" class="new-bot-takeover-local" data-testid="new-bot-upgrade-local" onclick={onopenlocal}>{otherWay}</button>{/if}
</section>
{:else}
<div class="new-bot-create" data-testid="new-bot-create-screen" role="group" onkeydown={onKeydown}>
  <!-- The head of the card, not window chrome: it sits in the centered card,
       well clear of the title bar, so it is a plain div and its step control
       does not go through the shared page header. -->
  <NewBotStepHead
    total={leadSteps + steps.length}
    current={leadSteps + stepIndex + 1}
    optionalFrom={leadSteps + 2}
    onback={prevOf ? () => go(prevOf) : onback}
    backTestId={prevOf ? undefined : "new-bot-back-to-choice"}
    backDisabled={step === 2 && busy}
    kicker={step === 2 ? "Choose a brain" : step === 3 ? "Your workspace" : "Machine size"}
    lead={step === 2 ? "Pick the" : step === 3 ? "Choose a" : "Pick a"}
    em={step === 2 ? "brain." : step === 3 ? "company." : "size."}
  >
    <!-- Who is being made, as one line, on every step after the name. -->
    <p class="new-bot-identity" data-testid="bot-identity-line">
      <span class="new-bot-identity-mark" aria-hidden="true"><IdentityMark kind="agent" label={name || "bot"} agentUid={`agt_preview_${derivedHandle || "bot"}`} /></span>
      <span class="new-bot-identity-name" data-testid="bot-identity-name">{name || "your bot"}</span>
      <span class="new-bot-identity-meta" data-testid="bot-identity-meta">Cloud{selectedCompanyLabel && (step !== 2 || singleCompany) ? ` · ${selectedCompanyLabel}` : ""}</span>
    </p>
  </NewBotStepHead>

  <div class="new-bot-create-scroll" data-testid="new-bot-create-scroll">
    {#if step === 2}
      <section class="new-bot-step" data-testid="new-bot-step-2"><p class="new-bot-create-copy">Choose the model your teammate will use.</p><fieldset class="new-bot-brains" disabled={busy}><legend class="sr-only">Brain</legend>{#each brainChoices as choice (choice)}<label class:selected={runtime === choice} class="new-bot-brain"><input type="radio" name="new-bot-brain" value={choice} checked={runtime === choice} onchange={() => { runtimeChosen = true; runtime = choice; }} /><span>{brainLabel(choice)}</span>{#if runtimeReady?.[choice] === true}<small>Signed in on this {hostNoun}</small>{/if}</label>{/each}</fieldset></section>
    {:else if step === 3}
      <section class="new-bot-step" data-testid="new-bot-step-3"><p class="new-bot-create-copy">Your bot will work with this company from the start.</p>{#if companies.length > 12}<label class="new-bot-filter-label" for="new-bot-company-filter">Find a company</label><input id="new-bot-company-filter" class="new-bot-create-input" data-testid="new-bot-company-filter" value={companyFilter} autocomplete="off" oninput={(event) => { companyFilter = (event.currentTarget as HTMLInputElement).value; }} />{/if}<div class="new-bot-companies" data-testid="new-bot-company-grid" role="radiogroup" aria-label="Company" onkeydown={onCompanyKeydown}>{#each shownCompanies as company (company.companyUid)}<button type="button" class:selected={companyUid === company.companyUid} class="new-bot-company" role="radio" aria-checked={companyUid === company.companyUid} aria-label={company.label} title={company.label} data-company-uid={company.companyUid} tabindex={companyFocusUid === company.companyUid ? 0 : -1} disabled={busy} onclick={() => selectCompany(company.companyUid)} onfocus={() => (companyFocusUid = company.companyUid)}><span class="new-bot-company-monogram" aria-hidden="true">{company.label.trim().slice(0, 1).toLocaleUpperCase()}</span><span class="new-bot-company-label">{company.label}</span>{#if companyUid === company.companyUid}<span class="new-bot-company-check" aria-hidden="true"><RailIcon name="check" size={14} /></span>{/if}</button>{:else}<p class="new-bot-company-empty">No company matches that.</p>{/each}</div>{#if hiddenCompanies > 0}<p class="new-bot-muted" data-testid="new-bot-company-more">{hiddenCompanies} more. Type to find {hiddenCompanies === 1 ? "it" : "them"}.</p>{/if}</section>
    {:else}
      <section class="new-bot-step" data-testid="new-bot-step-4"><p class="new-bot-create-copy">The default fits most bots. A bigger machine runs more work at once.</p><fieldset class="new-bot-sizes" disabled={busy || quoteStatus !== "ready"}><legend class="sr-only">Machine size</legend>{#each options?.options ?? [] as option (option.key)}<label class:selected={selectedSize === option.key} class="new-bot-size"><input type="radio" name="new-bot-size" value={option.key} checked={selectedSize === option.key} disabled={!option.selectable || option.netMonthlyCents === null} onchange={() => (selectedSize = option.key)} /><span>{option.productName} · {optionPrice(option)}</span></label>{:else}<span class="new-bot-muted">{quoteStatus === "loading" ? "Checking plan..." : "Sizes could not be loaded."}</span>{/each}</fieldset></section>
    {/if}
  </div>

  <footer class="new-bot-create-foot">
    {#if nameIssue}<p class="new-bot-create-error" role="alert" data-testid="new-bot-name-unusable">{nameIssue}</p>{/if}
    {#if refusal}<p id="new-bot-create-issue" class="new-bot-create-error" role="alert">{refusal}</p>{/if}
    {#if companyGone}
      <p class="new-bot-create-error" role="alert" data-testid="new-bot-company-gone">{NEW_BOT_COMPANY_GONE_REASON}</p>
    {:else if quoteProblemLine}
      <!-- Create bot is off because the company's options did not load. Say
           which of the two reasons it is, and offer another try. -->
      <p class="new-bot-create-error" role="alert" data-testid="new-bot-options-error" data-kind={quoteProblemKind ?? "load"}>{quoteProblemLine}</p>
      <button type="button" class="new-bot-more" data-testid="new-bot-options-retry" onclick={reloadOptions}><RailIcon name="refresh" />Try again</button>
    {/if}
    <!-- One short plan line, above the buttons. While the company's plan is
         checked it says so in the same place, so nothing moves. -->
    {#if !quoteProblemLine && !companyGone}
      <p class="new-bot-price new-bot-plan-line" data-testid="new-bot-price" data-state={planLine ? "ready" : quoteStatus === "loading" ? "checking" : "none"} aria-live="polite">{planLine || (quoteStatus === "loading" ? "Checking plan..." : "")}</p>
    {/if}
    <!-- Every step but the last: "Next: <step>" and "Finish with defaults"
         (the brain shown, the company it opened on, the default size). The
         last: one button, "Create <Name>". -->
    <div class="new-bot-foot-actions" class:single={isLast}>
      {#if nextOf}<button type="button" class="new-bot-create-next" data-testid={step === 2 ? "new-bot-continue-brain" : "new-bot-continue-company"} onclick={() => { if (nextOf) go(nextOf); }}>Next: {STEP_NAMES[nextOf]}<RailIcon name="arrow-right" /></button>{/if}
      <button type="button" class="new-bot-create-submit" data-testid="new-bot-create-submit" data-finish={isLast ? undefined : "defaults"} disabled={!canSubmit} aria-busy={busy ? "true" : undefined} onclick={() => void submit()}>{busy ? "Creating bot..." : isLast ? `Create ${name || "bot"}` : "Finish with defaults"}</button>
    </div>
    {#if step === 2 && onopenlocal}<button type="button" class="new-bot-takeover-local" data-testid="new-bot-takeover-local" onclick={onopenlocal}>{otherWay}</button>{/if}
  </footer>
</div>
{/if}

<script lang="ts">
  /**
   * The New bot flow: kind → home → details, with a live preview card and
   * one footer. Hosts it inside the create modal (and the Settings → Bots
   * pane). Owns the draft; the host owns the busy/error state because it
   * runs the create and navigates.
   *
   * Both homes walk all three steps. A Cloud draft's details step collects
   * the name and @handle the company channel's retired card used to ask for,
   * plus a title, and hands them to `onCloudCreate` (today's company team
   * action). Local drafts hand `oncreate` the CLI input plus the avatar pick
   * and title. Neither create path takes a title, so for both homes the host
   * saves it onto the agent profile once the bot exists.
   *
   * Cmd-Enter creates from any step once every walked step is valid — except
   * on a Cloud draft, where it moves to the next step until the details step
   * is reached, so a company bot is never made under a name nobody has seen.
   */
  import { onMount, untrack } from "svelte";
  import { hostComputerNoun, primaryEnterKeyHint } from "@hq/platform";
  import type {
    AdapterPromise,
    AgentProvisionOptionsView,
    LocalBotCreateInput,
    LocalBotWorkerOption,
  } from "@hq/platform";
  import type { AvatarPack, AvatarSelection } from "../../avatars/types.js";
  import type { LocalBotEntryResult } from "../local-bots.js";
  import BotPreviewCard from "./BotPreviewCard.svelte";
  import CloudDetailsStep from "./CloudDetailsStep.svelte";
  import DetailsStep from "./DetailsStep.svelte";
  import HomeStep from "./HomeStep.svelte";
  import KindStep from "./KindStep.svelte";
  import type { RuntimeSignInApi } from "./RuntimeSignIn.svelte";
  import type { RuntimeStatus } from "./runtime-status.js";
  import type { CloudBotDraft } from "../lifecycle-entry-points.js";
  import { cloudUnavailableCopy, type CloudUnavailableCopy, type CreateAvailability, type CreateErrorFix } from "@hq/agents";
  import { newWizardIdempotencyKey, type DirectCloudCreate } from "./cloud-create.js";
  import {
    STEP_TITLES,
    botDisplayName,
    botHandle,
    canAdvance,
    canCreate,
    claudeAllowedForCloud,
    companyTemplates,
    defaultCloudRuntime,
    firstBlockingStep,
    initialDraft,
    nextStep,
    prevStep,
    scopeLine,
    stepIssue,
    stepsFor,
    templateCard,
    thinksWithLine,
    toCreateInput,
    type BotRuntime,
    type CreateBotContext,
    type CreateBotDraft,
    type CreateBotStep,
  } from "./create-bot-model.js";

  /**
   * What the host saves onto the bot's agent profile once the CLI has given
   * it a uid. Neither field is a `hq bot create` flag.
   */
  export interface CreateBotExtras {
    avatar?: AvatarSelection;
    /** Job title for the agent profile ("Ad account analyst"). */
    title?: string;
    /**
     * Free-form display name ("Dr Love") when it differs from the handle the
     * bot was created under. `hq bot create` only takes the handle, so the
     * label is PATCHed onto the agent profile the same way the title is.
     */
    displayName?: string;
  }

  interface Props {
    botRuntimeReady?: Record<string, boolean> | null;
    /**
     * Per-runtime state (not-installed / couldn't-check / signed-out /
     * signed-in). Optional: a host that has not been updated keeps the
     * boolean-only behaviour.
     */
    botRuntimeStatus?: Record<string, RuntimeStatus> | null;
    botWorkers?: readonly LocalBotWorkerOption[] | null;
    existingNames?: readonly string[] | null;
    /** Companies a Cloud bot can be added to; empty hides Cloud. */
    agentTargets?: ReadonlyArray<{ companyUid: string; label: string; iconUrl?: string | null }> | null;
    /** The owner's companies (slugs) a Local company bot can belong to. */
    botCompanies?: ReadonlyArray<{ slug: string; label: string }> | null;
    /**
     * Cloud: the host runs the company team action and navigates. `title` is
     * present only when the person typed one — it is not part of the server's
     * card sequence, so the host PATCHes it onto the agent profile after.
     */
    onCloudCreate?: ((companyUid: string, draft: CloudBotDraft) => void | Promise<void>) | null;
    loadClaudeProviderFlag?: (() => AdapterPromise<boolean>) | null;
    loadCloudProvisionOptions?: ((companyUid: string) => AdapterPromise<AgentProvisionOptionsView>) | null;
    /** Local: the host creates through the CLI and opens the DM. */
    oncreate?: ((input: LocalBotCreateInput, extras: CreateBotExtras) => void | Promise<LocalBotEntryResult | void>) | null;
    /** Back from the first step (the host returns to its previous view). */
    onback?: (() => void) | null;
    entryBusy?: "bot" | "agent" | string | null;
    entryError?: string | null;
    /** The action that fixes `entryError` (direct cloud create only). */
    entryFix?: CreateErrorFix | null;
    /**
     * `agents.desktop-agent-creation`: when the flag is on, Cloud is always
     * shown (disabled with the reason and the fix when it cannot be used) and
     * the cloud draft carries a per-session idempotency key and the quote.
     * Absent or flag off → the older behaviour, unchanged.
     */
    directCloud?: DirectCloudCreate | null;
    signInApi?: RuntimeSignInApi | null;
    onsignin?: ((runtime: BotRuntime) => void | Promise<void>) | null;
    onsignedin?: ((runtime: BotRuntime) => void | Promise<void>) | null;
    /** Re-read runtime readiness from the host (Check again / Try again). */
    onrecheckruntimes?: (() => void | Promise<void>) | null;
    /**
     * Live AiTools payload for the install-choice panel that renders in the
     * "coding tool · not installed" state. When missing the panel falls
     * back to a neutral "Checking…" line. Null while the probe is running.
     */
    aiTools?: import("../../install-choice/install-choice.js").AiTools | null;
    /** HQ folder path passed into `claude://code/new?folder=`. Optional. */
    hqFolderPath?: string;
    /**
     * Open the assistant desktop app with the install prompt pre-filled.
     * When provided, the "not installed" state offers "Set up with Claude"
     * / "Set up with ChatGPT" buttons for whichever apps are detected.
     */
    onopenassistant?: (
      assistant: import("../../install-choice/install-choice.js").AssistantId,
      url: string,
    ) => Promise<import("../../install-choice/install-choice.js").InstallOutcome>;
    /**
     * HQ's own one-click installer for a coding tool (fallback when no
     * assistant app is available). Kept separate from the wizard's own
     * `oncreate` — this only runs the installer, never creates a bot.
     */
    onassistedinstall?: (
      tool: import("../../install-choice/install-choice.js").CodingTool,
    ) => Promise<import("../../install-choice/install-choice.js").InstallOutcome>;
    /** Ask the host to (re-)probe `detect_ai_tools` lazily on wizard open. */
    onrequestaitools?: () => void;
    avatarPacks?: AvatarPack[] | null;
    loadAvatarPacks?: (() => Promise<AvatarPack[]>) | null;
    /** Sign-in poll interval; tests shorten it. */
    pollMs?: number;
    /** Force the preview placement (tests); default follows the viewport. */
    previewPlacement?: "rail" | "top" | null;
    /** Company the flow was opened from (Team page Add agent); Cloud starts on it. */
    initialCompanyUid?: string | null;
    /** Slug of that company; a Local bot starts as its company bot (QA-043). */
    initialCompanySlug?: string | null;
  }

  let {
    botRuntimeReady = null,
    botRuntimeStatus = null,
    botWorkers = null,
    existingNames = null,
    agentTargets = null,
    botCompanies = null,
    onCloudCreate = null,
    loadClaudeProviderFlag = null,
    loadCloudProvisionOptions = null,
    oncreate = null,
    onback = null,
    entryBusy = null,
    entryError = null,
    entryFix = null,
    directCloud = null,
    signInApi = null,
    onsignin = null,
    onsignedin = null,
    onrecheckruntimes = null,
    avatarPacks = null,
    loadAvatarPacks = null,
    pollMs = 1500,
    previewPlacement = null,
    initialCompanyUid = null,
    initialCompanySlug = null,
    aiTools = null,
    hqFolderPath = "",
    onopenassistant,
    onassistedinstall,
    onrequestaitools,
  }: Props = $props();

  const templates = $derived<readonly LocalBotWorkerOption[]>(companyTemplates(botWorkers ?? []));
  const names = $derived<readonly string[]>(existingNames ?? []);
  /**
   * The plain-language name for the host machine ("Mac", "PC", or
   * "computer"). Read once so the stepIssue lines never rename the machine
   * mid-flow.
   */
  const hostNoun = hostComputerNoun();
  /**
   * The "submit form with primary modifier + Enter" hint on the footer. Reads
   * "⌘↵" on macOS and "Ctrl+Enter" on Windows / Linux so a person on a PC
   * never sees a Mac key symbol they cannot press.
   */
  const primaryEnterHint = primaryEnterKeyHint();
  const companies = $derived(agentTargets ?? []);
  const ownerCompanies = $derived(botCompanies ?? []);
  const canLocal = $derived(!!oncreate);
  /** `agents.desktop-agent-creation` resolved on for this person or one of their companies. */
  let directCloudOn = $state(false);
  /** Per-company create availability, filled in once the flag is on. */
  let cloudAvailability = $state<Record<string, CreateAvailability>>({});
  /** One key for this New bot session: a double-click or a retry replays it. */
  const cloudIdempotencyKey = newWizardIdempotencyKey();
  const companyBlocks = $derived.by<Record<string, CloudUnavailableCopy>>(() => {
    const out: Record<string, CloudUnavailableCopy> = {};
    if (!directCloudOn) return out;
    for (const company of companies) {
      const copy = cloudUnavailableCopy(cloudAvailability[company.companyUid] ?? null, {
        companyLabel: company.label,
        companies: companies.length,
      });
      if (copy) out[company.companyUid] = copy;
    }
    return out;
  });
  /** Why Cloud cannot be used at all (flag on only): no company, or every company refuses. */
  const cloudBlocked = $derived.by<CloudUnavailableCopy | null>(() => {
    if (!directCloudOn) return null;
    if (companies.length === 0) return cloudUnavailableCopy(null, { companies: 0 });
    if (!onCloudCreate) return null;
    const blocked = companies.map((c) => companyBlocks[c.companyUid]);
    return blocked.every(Boolean) ? (blocked[0] ?? null) : null;
  });
  const canCloud = $derived(!!onCloudCreate && companies.length > 0 && !cloudBlocked);
  let claudeProviderEnabled = $state(false);
  let cloudProvisionOptions = $state<AgentProvisionOptionsView | null>(null);
  let cloudQuoteStatus = $state<"loading" | "ready" | "error">("loading");
  let quoteReloadToken = $state(0);
  let quoteGeneration = 0;

  const ctx = $derived<CreateBotContext>({
    canLocal,
    canCloud,
    runtimeReady: botRuntimeReady,
    runtimeStatus: botRuntimeStatus,
    existingNames: names,
    companies,
    ownerCompanies,
    templates,
    claudeProviderEnabled,
    directCloudOn,
    cloudProvisionOptions,
    cloudQuoteStatus,
    hostNoun,
  });

  // The draft is seeded once from the initial context; later prop changes
  // (a worker list arriving, a sign-in landing) flow through `ctx` only.
  let draft = $state<CreateBotDraft>(untrack(() => initialDraft(ctx, initialCompanyUid, initialCompanySlug)));
  let step = $state<CreateBotStep>("kind");
  let pickedAvatarSrc = $state<string | null>(null);
  /** The user answered "who is it for?" themselves; templates no longer pick for them. */
  let scopeAnswered = $state(false);
  /** The user picked a brain themselves; the Cloud default no longer changes it. */
  let runtimeAnswered = false;

  const busy = $derived(entryBusy !== null && entryBusy !== undefined);
  const steps = $derived(stepsFor(draft));
  const stepIndex = $derived(Math.max(0, steps.indexOf(step)));
  const isLast = $derived(nextStep(step, draft) === null);
  const advanceOk = $derived(!busy && canAdvance(step, draft, ctx));
  const createOk = $derived(!busy && canCreate(draft, ctx));
  const issue = $derived(stepIssue(step, draft, ctx));
  const chosenTemplate = $derived(
    draft.kind === "template" && draft.templateId
      ? (templates.find((t) => t.id === draft.templateId) ?? null)
      : null,
  );
  const chosenTemplateCard = $derived(chosenTemplate ? templateCard(chosenTemplate) : null);
  const kindLine = $derived(
    draft.kind === "template"
      ? chosenTemplateCard
        ? `From ${chosenTemplateCard.name}`
        : "From a template"
      : "Blank bot",
  );
  const scopeText = $derived(scopeLine(draft, ctx));
  const previewKindLine = $derived(scopeText ? `${kindLine} · ${scopeText}` : kindLine);
  const previewAvatar = $derived(pickedAvatarSrc);
  const cloudCompany = $derived(companies.find((c) => c.companyUid === draft.companyUid) ?? null);
  const cloudQuoteCompanyUid = $derived(
    draft.home === "cloud" ? (draft.companyUid ?? "").trim() : "",
  );

  onMount(() => {
    const seam = directCloud;
    if (!seam) return;
    let active = true;
    const uids = untrack(() => companies.map((c) => c.companyUid));
    void seam.anyEnabled(uids).then(async (on) => {
      if (!active || !on) return;
      directCloudOn = true;
      const entries = await Promise.all(
        uids.map(async (uid) => [uid, await seam.availability(uid)] as const),
      );
      if (!active) return;
      cloudAvailability = Object.fromEntries(entries);
    });
    return () => {
      active = false;
    };
  });

  // The direct-create flag resolves after the draft is seeded: a Cloud bot the
  // user has not picked a brain for moves to the Claude default then.
  $effect(() => {
    if (!directCloudOn || draft.home !== "cloud" || untrack(() => runtimeAnswered)) return;
    if (draft.runtime !== "claude") draft = { ...draft, runtime: "claude" };
  });

  // A company that cannot take a cloud bot is never the selected one while
  // another can.
  $effect(() => {
    if (!directCloudOn || draft.home !== "cloud") return;
    const uid = draft.companyUid ?? "";
    if (uid && !companyBlocks[uid]) return;
    const open = companies.find((c) => !companyBlocks[c.companyUid]);
    if (open && open.companyUid !== uid) draft = { ...draft, companyUid: open.companyUid };
  });

  onMount(() => {
    if (!loadClaudeProviderFlag) return;
    let active = true;
    void loadClaudeProviderFlag()
      .then((result) => {
        if (!active) return;
        claudeProviderEnabled = result.ok && result.value === true;
        if (!claudeAllowedForCloud(ctx) && draft.home === "cloud" && draft.runtime === "claude") {
          draft = { ...draft, runtime: "codex" };
        }
        if (!result.ok && result.reason === "error") {
          console.warn("[hq-desktop] Claude provider flag unavailable", result.code ?? result.message ?? "unknown error");
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        claudeProviderEnabled = false;
        console.warn("[hq-desktop] Claude provider flag lookup failed", error);
      });
    return () => { active = false; };
  });

  $effect(() => {
    const companyUid = cloudQuoteCompanyUid;
    const reloadToken = quoteReloadToken;
    void reloadToken;
    const loadOptions = loadCloudProvisionOptions;
    if (!companyUid || !loadOptions) {
      cloudProvisionOptions = null;
      cloudQuoteStatus = companyUid ? "error" : "loading";
      return;
    }
    const generation = ++quoteGeneration;
    let active = true;
    cloudProvisionOptions = null;
    cloudQuoteStatus = "loading";
    void loadOptions(companyUid)
      .then((result) => {
        if (!active || generation !== quoteGeneration) return;
        if (!result.ok || !Array.isArray(result.value.options)) {
          cloudQuoteStatus = "error";
          if (!result.ok && result.reason === "error") {
            console.warn("[hq-desktop] company agent pricing unavailable", result.code ?? result.message ?? "unknown error");
          }
          return;
        }
        cloudProvisionOptions = result.value;
        cloudQuoteStatus = "ready";
        const selected = result.value.options.find(
          (option) => option.key === untrack(() => draft.size) && option.selectable && option.netMonthlyCents !== null,
        );
        if (!selected) {
          const defaultOption = result.value.options.find(
            (option) => option.default && option.selectable && option.netMonthlyCents !== null,
          ) ?? result.value.options.find(
            (option) => option.selectable && option.netMonthlyCents !== null,
          );
          if (defaultOption) draft = { ...draft, size: defaultOption.key };
        }
      })
      .catch((error: unknown) => {
        if (!active || generation !== quoteGeneration) return;
        cloudQuoteStatus = "error";
        console.warn("[hq-desktop] company agent pricing lookup failed", error);
      });
    return () => {
      active = false;
    };
  });

  // Preview placement: right rail on wide windows, top otherwise.
  let wide = $state(true);
  $effect(() => {
    if (previewPlacement || typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(min-width: 900px)");
    const apply = () => (wide = mq.matches);
    apply();
    mq.addEventListener?.("change", apply);
    return () => mq.removeEventListener?.("change", apply);
  });
  const placement = $derived<"rail" | "top">(previewPlacement ?? (wide ? "rail" : "top"));

  function patch(p: Partial<CreateBotDraft>): void {
    if (busy) return;
    draft = { ...draft, ...p };
    if (p.runtime !== undefined) runtimeAnswered = true;
    if (p.home === "cloud" && !runtimeAnswered) {
      draft = { ...draft, runtime: defaultCloudRuntime(ctx) };
    } else if (p.home === "cloud" && draft.runtime === "claude" && !claudeAllowedForCloud(ctx)) {
      draft = { ...draft, runtime: "codex" };
    }
    if (p.scope !== undefined) scopeAnswered = true;
    // A company template is a company bot for that company unless the user
    // already answered "who is it for?" (Personal stays personal even after
    // going back and picking a template).
    if (p.templateId && draft.kind === "template" && !scopeAnswered) {
      const slug = templateCard(templates.find((t) => t.id === p.templateId) ?? { id: p.templateId, path: "" }).company;
      if (slug && ownerCompanies.some((c) => c.slug === slug)) draft = { ...draft, scope: "company", companySlugs: [slug] };
    }
  }

  function goTo(next: CreateBotStep): void {
    step = next;
  }

  function advance(): void {
    if (!advanceOk) return;
    const next = nextStep(step, draft);
    if (next) goTo(next);
  }

  function back(): void {
    if (busy) return;
    const prev = prevStep(step, draft);
    if (prev) goTo(prev);
    else onback?.();
  }

  async function submit(): Promise<void> {
    if (busy) return;
    if (!canCreate(draft, ctx)) {
      const blocking = firstBlockingStep(draft, ctx);
      if (blocking) goTo(blocking);
      return;
    }
    const title = draft.title.trim();
    const displayName = botDisplayName(draft);
    if (draft.home === "cloud") {
      const quotedSize = cloudProvisionOptions?.options.find(
        (option) => option.key === draft.size && option.selectable && option.netMonthlyCents !== null,
      );
      if (draft.companyUid && quotedSize) {
        await onCloudCreate?.(draft.companyUid, {
          name: draft.name.trim(),
          handle: botHandle(draft),
          runtime: draft.runtime,
          size: quotedSize.key,
          ...(title ? { title } : {}),
          ...(directCloudOn && cloudProvisionOptions && quotedSize.netMonthlyCents !== null
            ? {
                idempotencyKey: cloudIdempotencyKey,
                quote: {
                  instanceType: quotedSize.instanceType,
                  netMonthlyCents: quotedSize.netMonthlyCents,
                  catalogVersion: cloudProvisionOptions.catalogVersion,
                },
              }
            : {}),
        });
      }
      return;
    }
    await oncreate?.(toCreateInput(draft), {
      ...(draft.avatar ? { avatar: draft.avatar } : {}),
      ...(title ? { title } : {}),
      ...(displayName ? { displayName } : {}),
    });
  }

  /** Primary action: Next until the last step, then Create. */
  function primary(): void {
    if (isLast) void submit();
    else advance();
  }

  function onKey(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (busy) return;
      // A cloud bot is named on the details step, and nothing is created
      // until the person has seen that name — so from an earlier step the
      // shortcut takes them there rather than creating under the suggestion.
      if (draft.home === "cloud" && !isLast && advanceOk) {
        advance();
        return;
      }
      // Otherwise `submit` is the gate: it creates only when every walked
      // step is valid, and otherwise moves the user to the step that still
      // needs them rather than swallowing the keystroke.
      void submit();
      return;
    }
    if (event.key === "Enter" && !isLast && advanceOk) {
      const target = event.target as HTMLElement | null;
      // Radios/cards handle their own Enter; a plain Enter on the search box advances.
      if (target?.tagName === "INPUT" && (target as HTMLInputElement).type === "search") {
        event.preventDefault();
        advance();
      }
    }
  }

  const primaryLabel = $derived(
    entryBusy === "bot"
      ? "Creating… (about half a minute)"
      : entryBusy === "agent"
        ? "Creating…"
        : !isLast
          ? "Next"
          : draft.home === "cloud"
            ? `Create in ${cloudCompany?.label ?? "the company"}`
            : "Create bot",
  );
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="flow" class:rail={placement === "rail"} data-testid="chat-create-bot-step" data-step={step} onkeydown={onKey}>
  <div class="flow-main">
    <div class="flow-head">
      <ol class="flow-crumbs" aria-label="Steps">
        {#each steps as s, i (s)}
          <li class="flow-crumb" class:current={s === step} class:done={i < stepIndex} aria-current={s === step ? "step" : undefined}>
            <button
              type="button"
              class="flow-crumb-btn"
              data-testid={`create-bot-crumb-${s}`}
              disabled={busy || i > stepIndex}
              onclick={() => goTo(s)}
            >
              <span class="flow-crumb-n" aria-hidden="true">{i + 1}</span>
              {STEP_TITLES[s]}
            </button>
          </li>
        {/each}
      </ol>
    </div>

    {#if placement === "top"}
      <BotPreviewCard
        placement="top"
        name={draft.name}
        handle={botHandle(draft)}
        home={draft.home}
        runtime={draft.runtime}
        thinksWith={thinksWithLine(draft, ctx)}
        title={draft.title}
        avatarUrl={previewAvatar}
        kindLine={previewKindLine}
      />
    {/if}

    <div class="flow-body">
      {#if step === "kind"}
        <KindStep {draft} {templates} disabled={busy} onpatch={patch} onadvance={advance} />
      {:else if step === "home"}
        <HomeStep
          {draft}
          {canLocal}
          {canCloud}
          cloudAlwaysShown={directCloudOn}
          cloudBlocked={cloudBlocked}
          {companyBlocks}
          runtimeReady={botRuntimeReady}
          runtimeStatus={botRuntimeStatus}
          {companies}
          disabled={busy}
          onpatch={patch}
          {signInApi}
          onsignin={onsignin ?? undefined}
          onsignedin={onsignedin ?? undefined}
          onrecheck={onrecheckruntimes ?? undefined}
          {pollMs}
          {aiTools}
          {hqFolderPath}
          {onopenassistant}
          {onassistedinstall}
          {onrequestaitools}
        />
      {:else if draft.home === "cloud"}
        <CloudDetailsStep
          {draft}
          companyLabel={cloudCompany?.label ?? "your company"}
          claudeProviderEnabled={claudeAllowedForCloud(ctx)}
          cloudProvisionOptions={cloudProvisionOptions}
          cloudQuoteStatus={cloudQuoteStatus}
          onretryquote={() => (quoteReloadToken += 1)}
          disabled={busy}
          onpatch={patch}
        />
      {:else}
        <DetailsStep
          {draft}
          existingNames={names}
          template={chosenTemplateCard}
          {ownerCompanies}
          {avatarPacks}
          {loadAvatarPacks}
          avatarSrc={pickedAvatarSrc}
          disabled={busy}
          onpatch={patch}
          onavatar={(_selection, src) => (pickedAvatarSrc = src)}
        />
      {/if}
    </div>

    {#if entryError}
      <p class="flow-error" role="alert" data-testid="chat-create-entry-error">
        {entryError}
        {#if entryFix?.kind === "checkout"}
          <a class="flow-error-fix" href={entryFix.url} target="_blank" rel="noopener noreferrer" data-testid="chat-create-entry-fix">{entryFix.label}</a>
        {:else if entryFix?.kind === "reload_quote"}
          <button type="button" class="flow-error-fix" data-testid="chat-create-entry-fix" disabled={busy} onclick={() => (quoteReloadToken += 1)}>Get the new price</button>
        {:else if entryFix?.kind === "edit_handle" && step !== "details"}
          <button type="button" class="flow-error-fix" data-testid="chat-create-entry-fix" disabled={busy} onclick={() => goTo("details")}>Change handle</button>
        {/if}
      </p>
    {/if}

    <div class="flow-footer">
      <button type="button" class="flow-back" data-testid="create-bot-back" disabled={busy} onclick={back}>
        {prevStep(step, draft) ? "Back" : "Cancel"}
      </button>
      <span class="flow-issue" data-testid="create-bot-issue" aria-live="polite">{issue ?? ""}</span>
      <span class="flow-hint" aria-hidden="true">{primaryEnterHint} to create</span>
      <button
        type="button"
        class="flow-primary"
        data-testid={isLast ? "chat-bot-create" : "create-bot-next"}
        disabled={isLast ? !createOk : !advanceOk}
        aria-busy={busy ? "true" : undefined}
        onclick={primary}
      >
        {primaryLabel}
      </button>
    </div>
  </div>

  {#if placement === "rail"}
    <div class="flow-rail">
      <BotPreviewCard
        placement="rail"
        name={draft.name}
        handle={botHandle(draft)}
        home={draft.home}
        runtime={draft.runtime}
        thinksWith={thinksWithLine(draft, ctx)}
        title={draft.title}
        avatarUrl={previewAvatar}
        kindLine={previewKindLine}
      />
    </div>
  {/if}
</div>

<style>
  .flow {
    display: flex;
    flex-direction: column;
    min-height: 0;
    flex: 1 1 auto;
  }
  .flow.rail {
    flex-direction: row;
  }
  .flow-main {
    display: flex;
    flex-direction: column;
    gap: 12px;
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    padding: 14px 16px 12px;
  }
  .flow-rail {
    flex: 0 0 240px;
    padding: 14px 16px 14px 0;
  }
  .flow-head {
    display: flex;
    align-items: center;
  }
  .flow-crumbs {
    display: flex;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
    flex-wrap: wrap;
  }
  .flow-crumb-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--t3);
    font: inherit;
    font-size: 13px;
    line-height: 17px;
    cursor: pointer;
  }
  .flow-crumb-btn:hover:not(:disabled) {
    background: var(--hover, var(--v4-control-faint));
  }
  .flow-crumb-btn:disabled {
    cursor: default;
  }
  .flow-crumb.current .flow-crumb-btn {
    color: var(--t1);
    font-weight: 500;
  }
  .flow-crumb.done .flow-crumb-btn {
    color: var(--t2);
  }
  .flow-crumb-btn:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: 1px;
  }
  /* Step numbers are plain sans digits, no ring or filled disc. */
  .flow-crumb-n {
    color: var(--t3);
    font-variant-numeric: tabular-nums;
  }
  .flow-crumb.current .flow-crumb-n {
    color: var(--t2);
  }
  .flow-crumb:not(:last-child)::after {
    content: "›";
    color: var(--t3);
    align-self: center;
    margin-left: 4px;
  }
  .flow-crumb {
    display: inline-flex;
  }
  .flow-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding-right: 2px;
  }
  .flow-error {
    margin: 0;
    padding: 8px 10px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--v4-error, #d9534f) 10%, transparent);
    color: var(--v4-error, #d9534f);
    font-size: 13px;
    line-height: 1.45;
  }
  .flow-error-fix {
    margin-left: 6px;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    font-weight: 500;
    text-decoration: underline;
    cursor: pointer;
  }
  .flow-footer {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--v4-hairline);
  }
  .flow-back {
    font: inherit;
    font-size: 13px;
    height: 28px;
    padding: 0 10px;
    border: 1px solid var(--overlay-field-border);
    border-radius: 6px;
    background: var(--v4-control-bg, transparent);
    color: var(--t1);
    cursor: pointer;
  }
  .flow-issue {
    flex: 1 1 auto;
    color: var(--t3);
    font-size: 13px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .flow-hint {
    color: var(--t3);
    font-size: 13px;
  }
  /* Messages sheet primary: --t1 fill on panel ink, 28px, radius 6. */
  .flow-primary {
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    height: 28px;
    padding: 0 12px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: var(--t1, #111);
    color: var(--panel-bg, #fff);
    cursor: pointer;
  }
  .flow-primary:disabled,
  .flow-back:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .flow-primary:focus-visible,
  .flow-back:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: 2px;
  }
</style>

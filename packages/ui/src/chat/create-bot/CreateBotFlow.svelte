<script lang="ts">
  /**
   * The New bot flow: kind → home → details, with a live preview card and
   * one footer. Hosts it inside the create modal (and the Settings → Bots
   * pane). Owns the draft; the host owns the busy/error state because it
   * runs the create and navigates.
   *
   * Cloud drafts end at the home step and hand off to `onCloudCreate`
   * (today's company team action). Local drafts continue to details and
   * hand `oncreate` the CLI input plus the avatar pick, which the host saves
   * once the bot exists. Cmd-Enter creates from any step once every walked
   * step is valid.
   */
  import { untrack } from "svelte";
  import type { LocalBotCreateInput, LocalBotWorkerOption } from "@hq/platform";
  import type { AvatarPack, AvatarSelection } from "../../avatars/types.js";
  import type { LocalBotEntryResult } from "../local-bots.js";
  import BotPreviewCard from "./BotPreviewCard.svelte";
  import DetailsStep from "./DetailsStep.svelte";
  import HomeStep from "./HomeStep.svelte";
  import KindStep from "./KindStep.svelte";
  import type { RuntimeSignInApi } from "./RuntimeSignIn.svelte";
  import {
    STEP_TITLES,
    canAdvance,
    canCreate,
    draftFromClone,
    firstBlockingStep,
    initialDraft,
    nextStep,
    prevStep,
    stepIssue,
    stepsFor,
    templateCard,
    thinksWithLine,
    toCreateInput,
    type BotRuntime,
    type CloneCandidate,
    type CreateBotContext,
    type CreateBotDraft,
    type CreateBotStep,
  } from "./create-bot-model.js";

  export interface CreateBotExtras {
    avatar?: AvatarSelection;
  }

  interface Props {
    botRuntimeReady?: Record<string, boolean> | null;
    botWorkers?: readonly LocalBotWorkerOption[] | null;
    cloneCandidates?: readonly CloneCandidate[] | null;
    existingNames?: readonly string[] | null;
    /** Companies a Cloud bot can be added to; empty hides Cloud. */
    agentTargets?: ReadonlyArray<{ companyUid: string; label: string; iconUrl?: string | null }> | null;
    /** Cloud: the host runs the company team action and navigates. */
    onCloudCreate?: ((companyUid: string) => void | Promise<void>) | null;
    /** Local: the host creates through the CLI and opens the DM. */
    oncreate?: ((input: LocalBotCreateInput, extras: CreateBotExtras) => void | Promise<LocalBotEntryResult | void>) | null;
    /** Back from the first step (the host returns to its previous view). */
    onback?: (() => void) | null;
    entryBusy?: "bot" | "agent" | string | null;
    entryError?: string | null;
    signInApi?: RuntimeSignInApi | null;
    onsignin?: ((runtime: BotRuntime) => void | Promise<void>) | null;
    onsignedin?: ((runtime: BotRuntime) => void | Promise<void>) | null;
    avatarPacks?: AvatarPack[] | null;
    loadAvatarPacks?: (() => Promise<AvatarPack[]>) | null;
    /** Sign-in poll interval; tests shorten it. */
    pollMs?: number;
    /** Force the preview placement (tests); default follows the viewport. */
    previewPlacement?: "rail" | "top" | null;
  }

  let {
    botRuntimeReady = null,
    botWorkers = null,
    cloneCandidates = null,
    existingNames = null,
    agentTargets = null,
    onCloudCreate = null,
    oncreate = null,
    onback = null,
    entryBusy = null,
    entryError = null,
    signInApi = null,
    onsignin = null,
    onsignedin = null,
    avatarPacks = null,
    loadAvatarPacks = null,
    pollMs = 1500,
    previewPlacement = null,
  }: Props = $props();

  const templates = $derived<readonly LocalBotWorkerOption[]>(botWorkers ?? []);
  const clones = $derived<readonly CloneCandidate[]>(cloneCandidates ?? []);
  const names = $derived<readonly string[]>(existingNames ?? []);
  const companies = $derived(agentTargets ?? []);
  const canLocal = $derived(!!oncreate);
  const canCloud = $derived(!!onCloudCreate && companies.length > 0);

  const ctx = $derived<CreateBotContext>({
    canLocal,
    canCloud,
    runtimeReady: botRuntimeReady,
    existingNames: names,
    companies,
    templates,
  });

  // The draft is seeded once from the initial context; later prop changes
  // (a worker list arriving, a sign-in landing) flow through `ctx` only.
  let draft = $state<CreateBotDraft>(untrack(() => initialDraft(ctx)));
  let step = $state<CreateBotStep>("kind");
  /** A cloned bot's photo; cleared when the user picks a pack avatar. */
  let inheritedAvatarUrl = $state<string | null>(null);
  let pickedAvatarSrc = $state<string | null>(null);

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
  const chosenClone = $derived(draft.kind === "clone" && draft.cloneUid ? (clones.find((c) => c.uid === draft.cloneUid) ?? null) : null);
  const kindLine = $derived(
    draft.kind === "template"
      ? chosenTemplateCard
        ? `From ${chosenTemplateCard.name}`
        : "From a template"
      : draft.kind === "clone"
        ? chosenClone
          ? `Clone of ${chosenClone.displayName}`
          : "Clone of a bot"
        : "Blank bot",
  );
  const previewAvatar = $derived(pickedAvatarSrc ?? inheritedAvatarUrl);
  const cloudCompany = $derived(companies.find((c) => c.companyUid === draft.companyUid) ?? null);

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
    // A Cloud draft has no details step: never strand the user there.
    if (draft.home === "cloud" && step === "details") step = "home";
  }

  function clone(bot: CloneCandidate): void {
    if (busy) return;
    draft = draftFromClone(bot, draft, names);
    inheritedAvatarUrl = bot.avatarUrl ?? null;
    pickedAvatarSrc = null;
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
    if (draft.home === "cloud") {
      if (draft.companyUid) await onCloudCreate?.(draft.companyUid);
      return;
    }
    await oncreate?.(toCreateInput(draft), draft.avatar ? { avatar: draft.avatar } : {});
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
      if (createOk) void submit();
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
        ? "Opening…"
        : !isLast
          ? "Next"
          : draft.home === "cloud"
            ? `Continue in ${cloudCompany?.label ?? "the company"}`
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
        home={draft.home}
        runtime={draft.runtime}
        thinksWith={thinksWithLine(draft, ctx)}
        intro={draft.intro}
        avatarUrl={previewAvatar}
        {kindLine}
      />
    {/if}

    <div class="flow-body">
      {#if step === "kind"}
        <KindStep {draft} {templates} cloneCandidates={clones} disabled={busy} onpatch={patch} onadvance={advance} onclone={clone} />
      {:else if step === "home"}
        <HomeStep
          {draft}
          {canLocal}
          {canCloud}
          runtimeReady={botRuntimeReady}
          {companies}
          disabled={busy}
          onpatch={patch}
          {signInApi}
          onsignin={onsignin ?? undefined}
          onsignedin={onsignedin ?? undefined}
          {pollMs}
        />
      {:else}
        <DetailsStep
          {draft}
          existingNames={names}
          template={chosenTemplateCard}
          {avatarPacks}
          {loadAvatarPacks}
          {inheritedAvatarUrl}
          disabled={busy}
          onpatch={patch}
          onavatar={(_selection, src) => (pickedAvatarSrc = src)}
        />
      {/if}
    </div>

    {#if entryError}
      <p class="flow-error" role="alert" data-testid="chat-create-entry-error">{entryError}</p>
    {/if}

    <div class="flow-footer">
      <button type="button" class="flow-back" data-testid="create-bot-back" disabled={busy} onclick={back}>
        {prevStep(step, draft) ? "Back" : "Cancel"}
      </button>
      <span class="flow-issue" data-testid="create-bot-issue" aria-live="polite">{issue ?? ""}</span>
      <span class="flow-hint" aria-hidden="true">⌘↵ TO CREATE</span>
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
        home={draft.home}
        runtime={draft.runtime}
        thinksWith={thinksWithLine(draft, ctx)}
        intro={draft.intro}
        avatarUrl={previewAvatar}
        {kindLine}
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
    font-size: 12px;
    cursor: pointer;
  }
  .flow-crumb-btn:disabled {
    cursor: default;
  }
  .flow-crumb.current .flow-crumb-btn {
    color: var(--t1);
    font-weight: 600;
  }
  .flow-crumb.done .flow-crumb-btn {
    color: var(--t2);
  }
  .flow-crumb-btn:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: 1px;
  }
  .flow-crumb-n {
    display: grid;
    place-items: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 1px solid currentColor;
    font: 500 10px/1 var(--font-mono);
  }
  .flow-crumb.current .flow-crumb-n {
    background: var(--t1);
    border-color: var(--t1);
    color: var(--v4-surface-solid, #fff);
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
    font-size: 12px;
    line-height: 1.4;
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
    padding: 6px 12px;
    border: 1px solid var(--v4-control-border, var(--border));
    border-radius: 8px;
    background: var(--v4-control-bg, transparent);
    color: var(--t1);
    cursor: pointer;
  }
  .flow-issue {
    flex: 1 1 auto;
    color: var(--t3);
    font-size: 12px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .flow-hint {
    color: var(--t3);
    font: 500 10px/1 var(--font-mono);
    letter-spacing: 0.06em;
  }
  .flow-primary {
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    padding: 7px 14px;
    border: 0;
    border-radius: 8px;
    background: var(--v4-cta-bg, var(--v4-brand-accent, #4c6fff));
    color: var(--v4-cta-text, #fff);
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

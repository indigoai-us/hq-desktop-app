<script lang="ts">
  import RailIcon from "../../common/button/RailIcon.svelte";
  /**
   * The New bot flow, as one question per screen in the New bot takeover's
   * card: the name first (unless the host already asked it), then Cloud or
   * Local (unless the host already asked, or Cloud is not shown), then the
   * steps for that home. Every entry point (the takeover, the "+" window,
   * Settings > Bots) uses it. Owns the draft; the host owns the busy/error
   * state because it runs the create and navigates.
   *
   * Local: the coding tool, with a template and the advanced settings folded
   * away on the same screen. The bot asks for its title, avatar and model in
   * its first message (a kickoff on the CLI input). Cloud: company (when
   * there is a choice), then name, brain and size. A cloud draft hands
   * `onCloudCreate` the name, @handle and title; a local draft hands
   * `oncreate` the CLI input plus the display name.
   *
   * Cmd-Enter creates from any step once every walked step is valid, except
   * on a Cloud draft, where it moves to the next step until the details step
   * is reached, so a company bot is never made under a name nobody has seen.
   */
  import { onMount, untrack } from "svelte";
  import { hostComputerNoun } from "@hq/platform";
  import { formatShortcut, matchesShortcut } from "../../common/keyboard-shortcuts.js";
  import type {
    AdapterPromise,
    AgentProvisionOptionsView,
    LocalBotCreateInput,
    LocalBotWorkerOption,
  } from "@hq/platform";
  import type { AvatarSelection } from "../../avatars/types.js";
  import type { LocalBotEntryResult } from "../local-bots.js";
  import CloudDetailsStep from "./CloudDetailsStep.svelte";
  import HomeStep from "./HomeStep.svelte";
  import KindStep from "./KindStep.svelte";
  import LocalBotAdvanced from "./LocalBotAdvanced.svelte";
  import NewBotStepHead from "./NewBotStepHead.svelte";
  import NewBotNameStep from "./NewBotNameStep.svelte";
  import NewBotKindChoice, { type NewBotKind } from "./NewBotKindChoice.svelte";
  import IdentityMark from "../messaging/IdentityMark.svelte";
  import { LOCAL_BOT_RUNTIMES } from "../local-bots.js";
  import type { RuntimeSignInApi } from "./RuntimeSignIn.svelte";
  import type { RuntimeStatus } from "./runtime-status.js";
  import type { CloudBotDraft } from "../lifecycle-entry-points.js";
  import type { CloudUnavailableCopy, CreateAvailability, CreateErrorFix } from "@hq/agents";
  import type { DirectCloudFlowSeam } from "./direct-cloud-lazy.js";
  import { newWizardIdempotencyKey } from "./wizard-key.js";
  import {
    botDisplayName,
    botHandle,
    canAdvance,
    canCreate,
    claudeAllowedForCloud,
    companyTemplates,
    defaultCloudRuntime,
    firstBlockingStep,
    initialDraft,
    localHandleIssue,
    nextStep,
    prevStep,
    scopeIssue,
    scopeLine,
    stepIssue,
    stepsFor,
    templateCard,
    stepTitle,
    templateBringsLine,
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
     * present only when the person typed one. It is not part of the server's
     * card sequence, so the host PATCHes it onto the agent profile after.
     */
    onCloudCreate?: ((companyUid: string, draft: CloudBotDraft) => void | Promise<void>) | null;
    loadClaudeProviderFlag?: (() => AdapterPromise<boolean>) | null;
    loadCloudProvisionOptions?: ((companyUid: string) => AdapterPromise<AgentProvisionOptionsView>) | null;
    /** Local: the host creates through the CLI and opens the DM. */
    oncreate?: ((input: LocalBotCreateInput, extras: CreateBotExtras) => void | Promise<LocalBotEntryResult | void>) | null;
    /**
     * Back from the first screen (the host returns to its previous view),
     * with the name as it stands so the host can carry it.
     */
    onback?: ((name: string) => void) | null;
    entryBusy?: "bot" | "agent" | string | null;
    entryError?: string | null;
    /** The action that fixes `entryError` (direct cloud create only). */
    entryFix?: CreateErrorFix | null;
    /**
     * `agents.desktop-agent-creation`: when the flag is on, Cloud is always
     * shown (disabled with the reason and the fix when it cannot be used) and
     * the cloud draft carries a per-session idempotency key and the quote.
     * Absent or flag off: the older behaviour, unchanged.
     */
    directCloud?: DirectCloudFlowSeam | null;
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
     * `oncreate`: this only runs the installer, never creates a bot.
     */
    onassistedinstall?: (
      tool: import("../../install-choice/install-choice.js").CodingTool,
    ) => Promise<import("../../install-choice/install-choice.js").InstallOutcome>;
    /** Ask the host to (re-)probe `detect_ai_tools` lazily on wizard open. */
    onrequestaitools?: () => void;
    /** Sign-in poll interval; tests shorten it. */
    pollMs?: number;
    /** Company the flow was opened from (Team page Add agent); Cloud starts on it. */
    initialCompanyUid?: string | null;
    /** Slug of that company; a Local bot starts as its company bot (QA-043). */
    initialCompanySlug?: string | null;
    /**
     * The home picked on the New bot "Where should it live?" screen. The
     * flow opens on that home's first step; without it the flow asks.
     */
    initialHome?: "local" | "cloud" | null;
    /**
     * The name given on the New bot takeover's first step. With it the flow
     * does not ask for the name again.
     */
    initialName?: string | null;
    /** Local coding tool step: "Create a cloud bot instead", with the name. Without it the flow offers it only after its own Cloud or Local question. */
    onswitchcloud?: ((name: string) => void) | null;
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
    pollMs = 1500,
    initialCompanyUid = null,
    initialCompanySlug = null,
    initialHome = null,
    initialName = null,
    onswitchcloud = null,
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
  // OWNER-D 8 (AUDIT-2-15): the app's own chord label, read from the window's
  // platform, so a Mac shows ⌘↵ even before the Tauri host probe answers.
  const CREATE_CHORD = "Mod+Enter";
  const primaryEnterHint = formatShortcut(CREATE_CHORD);
  const companies = $derived(agentTargets ?? []);
  const ownerCompanies = $derived(botCompanies ?? []);
  const canLocal = $derived(!!oncreate);
  /** `agents.desktop-agent-creation` resolved on for this person or one of their companies. */
  let directCloudOn = $state(false);
  /** `@hq/agents` copy for an unavailable Cloud, loaded with the flag (kept off the startup bundle). */
  let unavailableCopy = $state<typeof import("@hq/agents").cloudUnavailableCopy | null>(null);
  /** Per-company create availability, filled in once the flag is on. */
  let cloudAvailability = $state<Record<string, CreateAvailability>>({});
  /**
   * One key per create attempt: a double-click or a retry after a network
   * failure replays it. A refusal the server answered with a fix (handle
   * taken, new price, plan) made no bot, so the next create gets a new key
   * instead of replaying the refusal.
   */
  let cloudIdempotencyKey = newWizardIdempotencyKey();
  let keyRotatedForFix: CreateErrorFix | null = null;
  const companyBlocks = $derived.by<Record<string, CloudUnavailableCopy>>(() => {
    const out: Record<string, CloudUnavailableCopy> = {};
    const cloudUnavailableCopy = unavailableCopy;
    if (!directCloudOn || !cloudUnavailableCopy) return out;
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
    const cloudUnavailableCopy = unavailableCopy;
    if (!directCloudOn || !cloudUnavailableCopy) return null;
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

  /** The name the host already asked for, if it did. Read once. */
  const givenName = untrack(() => (initialName ?? "").trim());
  // The draft is seeded once from the initial context; later prop changes
  // (a worker list arriving, a sign-in landing) flow through `ctx` only.
  let draft = $state<CreateBotDraft>(
    untrack(() => initialDraft(ctx, initialCompanyUid, initialCompanySlug, initialHome, givenName || null)),
  );
  /**
   * The flow asks "Cloud or Local?" itself when the host has not and Cloud is
   * shown: it can be used, or the direct-create flag shows it disabled with
   * its reason. Otherwise (no company, or a host without a cloud create, like
   * Settings) Cloud stays hidden and the flow goes from the name to the local
   * steps.
   */
  const homeGiven = untrack(() => (initialHome === "local" ? canLocal : initialHome === "cloud" ? canCloud : false));
  const asksHome = $derived(!homeGiven && canLocal && !!onCloudCreate && (canCloud || directCloudOn));
  /** The person answered the flow's own "Cloud or Local?". */
  let homeAnswered = false;
  /** The person changed something on the home's steps. */
  let stepsTouched = false;
  /**
   * Which screen is on: the name, "Where should it live?", or the home's
   * steps. A name the host already asked for skips the name screen.
   */
  type Phase = "name" | "where" | "steps";
  let phase = $state<Phase>(untrack(() => (givenName ? (asksHome ? "where" : "steps") : "name")));
  /** A cloud bot gets a "Pick the company" step only when there is a choice. */
  const pickCompany = untrack(() => companies.length > 1);
  const stepOpts = { pickCompany };
  let step = $state<CreateBotStep>(untrack(() => stepsFor(draft, stepOpts)[0] ?? "details"));
  /** The user answered "who is it for?" themselves; templates no longer pick for them. */
  let scopeAnswered = $state(false);
  /** The user picked a brain themselves; the Cloud default no longer changes it. */
  let runtimeAnswered = false;

  /** The local step's folded parts. */
  let templatesOpen = $state(untrack(() => draft.kind === "template"));
  let advancedOpen = $state(false);

  const busy = $derived(entryBusy !== null && entryBusy !== undefined);
  const steps = $derived(stepsFor(draft, stepOpts));
  const stepIndex = $derived(Math.max(0, steps.indexOf(step)));
  const isLast = $derived(nextStep(step, draft, stepOpts) === null);
  const advanceOk = $derived(!busy && canAdvance(step, draft, ctx, stepOpts));
  const createOk = $derived(!busy && canCreate(draft, ctx, stepOpts));
  const issue = $derived(stepIssue(step, draft, ctx, stepOpts));
  const chosenTemplate = $derived(
    draft.kind === "template" && draft.templateId
      ? (templates.find((t) => t.id === draft.templateId) ?? null)
      : null,
  );
  const chosenTemplateCard = $derived(chosenTemplate ? templateCard(chosenTemplate) : null);
  const scopeText = $derived(scopeLine(draft, ctx));
  const runtimeLabel = $derived(LOCAL_BOT_RUNTIMES.find((r) => r.id === draft.runtime)?.label ?? draft.runtime);
  /** The coding tool signed in on this computer, named on the Local tile. */
  const signedInTool = $derived(
    LOCAL_BOT_RUNTIMES.find((runtime) => botRuntimeReady?.[runtime.id] === true)?.label ?? null,
  );
  const cloudCompany = $derived(companies.find((c) => c.companyUid === draft.companyUid) ?? null);
  const cloudQuoteCompanyUid = $derived(
    draft.home === "cloud" ? (draft.companyUid ?? "").trim() : "",
  );
  /**
   * Step dots for the whole New bot: the name, the where question when it
   * is part of this New bot (asked here or by the host), then the home's
   * steps.
   */
  const leadSteps = $derived(1 + (homeGiven || asksHome ? 1 : 0));
  const totalSteps = $derived(leadSteps + steps.length);

  // A handle that cannot be used, or a company bot with no company, is fixed
  // in Advanced: open it so the field that says so is on screen.
  $effect(() => {
    if (draft.home !== "local") return;
    if (localHandleIssue(draft, names) || scopeIssue(draft, ctx)) advancedOpen = true;
  });

  onMount(() => {
    const seam = directCloud;
    if (!seam) return;
    let active = true;
    const uids = untrack(() => companies.map((c) => c.companyUid));
    void seam.anyEnabled(uids).then(async (on) => {
      if (!active || !on) return;
      const agents = await import("@hq/agents");
      if (!active) return;
      unavailableCopy = agents.cloudUnavailableCopy;
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

  function patch(p: Partial<CreateBotDraft>): void {
    if (busy) return;
    draft = { ...draft, ...p };
    if (phase === "steps") stepsTouched = true;
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
    phase = "steps";
    step = next;
  }

  // The direct-create flag can show Cloud after the flow opened: ask then,
  // unless the person already started on the local steps.
  $effect(() => {
    if (!asksHome || homeAnswered) return;
    untrack(() => {
      if (phase === "steps" && step === steps[0] && !stepsTouched) phase = "where";
    });
  });

  /** The name is in: on to "Where should it live?", or the home's first step. */
  function continueName(name: string): void {
    if (busy) return;
    draft = { ...draft, name };
    if (asksHome) {
      phase = "where";
      return;
    }
    goTo(stepsFor(draft, stepOpts)[0] ?? "details");
  }

  /** The flow's own "Cloud or Local?": that home's first step. */
  function pickHome(kind: NewBotKind): void {
    if (busy) return;
    homeAnswered = true;
    if (kind !== draft.home) {
      patch(kind === "local"
        ? { home: "local", runtime: initialDraft(ctx, null, null, "local").runtime }
        : { home: "cloud" });
      if (kind === "local") runtimeAnswered = false;
    }
    goTo(stepsFor(draft, stepOpts)[0] ?? "details");
  }

  /** "Create a cloud bot instead": the host's cloud screen, or this flow's cloud steps. */
  const switchCloud = $derived(
    onswitchcloud
      ? () => onswitchcloud?.(draft.name.trim())
      : asksHome && canCloud
        ? () => pickHome("cloud")
        : null,
  );

  function advance(): void {
    if (!advanceOk) return;
    const next = nextStep(step, draft, stepOpts);
    if (next) goTo(next);
  }

  /**
   * Back from a step: the step before it, then the flow's own where
   * question, then the name. A name the host asked for goes back to the host.
   */
  function back(): void {
    if (busy) return;
    const prev = prevStep(step, draft, stepOpts);
    if (prev) goTo(prev);
    else if (asksHome) phase = "where";
    else if (givenName) onback?.(draft.name.trim());
    else phase = "name";
  }

  async function submit(): Promise<void> {
    if (busy) return;
    if (!canCreate(draft, ctx, stepOpts)) {
      const blocking = firstBlockingStep(draft, ctx, stepOpts);
      if (blocking) goTo(blocking);
      return;
    }
    const displayName = botDisplayName(draft);
    if (draft.home === "cloud") {
      const title = draft.title.trim();
      const quotedSize = cloudProvisionOptions?.options.find(
        (option) => option.key === draft.size && option.selectable && option.netMonthlyCents !== null,
      );
      if (draft.companyUid && quotedSize) {
        if (entryFix && entryFix !== keyRotatedForFix) {
          keyRotatedForFix = entryFix;
          cloudIdempotencyKey = newWizardIdempotencyKey();
        }
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
    // The title, avatar and model are asked by the bot itself: the CLI input
    // carries the kickoff that has it ask (see `toCreateInput`).
    await oncreate?.(toCreateInput(draft), displayName ? { displayName } : {});
  }

  /** Primary action: Next until the last step, then Create. */
  function primary(): void {
    if (isLast) void submit();
    else advance();
  }

  function onKey(event: KeyboardEvent): void {
    if (matchesShortcut(CREATE_CHORD, event)) {
      event.preventDefault();
      event.stopPropagation();
      if (busy) return;
      // A cloud bot is named on the details step, and nothing is created
      // until the person has seen that name, so from an earlier step the
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
    if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      // The cloud flow's keys: Enter moves on (and creates on the last
      // step); a button or a list handles its own Enter.
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "BUTTON" || target?.tagName === "TEXTAREA") return;
      event.preventDefault();
      if (busy) return;
      if (isLast) {
        if (createOk) void submit();
      } else advance();
      return;
    }
  }

  const primaryLabel = $derived(
    entryBusy === "bot"
      ? "Creating… (about half a minute)"
      : busy
        ? "Creating…"
        : !isLast
          ? "Continue"
          : draft.home === "cloud"
            ? `Create in ${cloudCompany?.label ?? "the company"}`
            : "Create bot",
  );
  const cloudReason = $derived(canCloud ? null : (cloudBlocked?.reason ?? "Cloud bots aren't available right now."));
</script>

<!-- One question per screen, in the New bot takeover's card. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="new-bot-create" data-testid="chat-create-bot-step" data-step={phase === "steps" ? step : phase} data-home={draft.home} role="group" onkeydown={phase === "steps" ? onKey : undefined}>
{#if phase === "name"}
  <NewBotNameStep
    name={draft.name}
    total={totalSteps}
    current={1}
    onback={onback ? () => onback?.(draft.name.trim()) : null}
    backTestId="create-bot-back"
    disabled={busy}
    oninput={(name) => { if (!busy) draft = { ...draft, name }; }}
    oncontinue={continueName}
  />
{:else if phase === "where"}
  <NewBotKindChoice
    name={draft.name}
    {cloudReason}
    localTool={signedInTool}
    total={totalSteps}
    current={2}
    onback={() => (phase = "name")}
    backTestId="create-bot-back"
    backDisabled={busy}
    onpick={pickHome}
  />
  {#if entryError}
    <p class="new-bot-create-error" role="alert" data-testid="chat-create-entry-error">{entryError}</p>
  {/if}
  {#if !canCloud && cloudBlocked?.fix?.kind === "checkout"}
    <p class="new-bot-price" data-testid="chat-bot-where-cloud-fix-line">
      <a class="new-bot-takeover-local" href={cloudBlocked.fix.url} target="_blank" rel="noopener noreferrer" data-testid="chat-bot-where-cloud-fix">{cloudBlocked.fix.label}</a>
    </p>
  {/if}
{:else}
  {@const head = stepTitle(step, draft.home)}
  <NewBotStepHead
    total={totalSteps}
    current={leadSteps + stepIndex + 1}
    onback={back}
    backTestId="create-bot-back"
    backDisabled={busy}
    kicker={head.kicker}
    lead={head.lead}
    em={head.em}
    tail={head.tail ?? ""}
  >
    <!-- Who is being made, and how, as one line, on every step after the name. -->
    <p class="new-bot-identity" data-testid="bot-identity-line">
      <span class="new-bot-identity-mark" aria-hidden="true"><IdentityMark kind="agent" label={draft.name || "bot"} agentUid={`agt_preview_${botHandle(draft) || "bot"}`} /></span>
      <span class="new-bot-identity-name" data-testid="bot-identity-name">{draft.name.trim() || "your bot"}</span>
      {#if draft.home === "local"}
        <span class="new-bot-identity-meta" data-testid="bot-identity-meta">Local · {runtimeLabel}{chosenTemplateCard ? ` · from ${chosenTemplateCard.name}` : ""}{scopeText ? ` · ${scopeText}` : ""}</span>
      {:else}
        <span class="new-bot-identity-meta" data-testid="bot-identity-meta">Cloud{cloudCompany ? ` · ${cloudCompany.label}` : ""}</span>
      {/if}
    </p>
  </NewBotStepHead>

  <div class="new-bot-create-scroll" data-testid="new-bot-create-scroll">
    <section class="new-bot-step" data-testid={`create-bot-sunrise-${step}`}>
      <p class="new-bot-create-copy">{head.copy.replace("this computer", `this ${hostNoun}`)}</p>
      {#if draft.home === "cloud"}
        {#if step === "home"}
          <HomeStep
            runtimeOnly
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
          />
        {:else}
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
        {/if}
      {:else}
        <HomeStep
          runtimeOnly
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
        <!-- A template and the advanced settings: one click away, never a step. -->
        <div class="new-bot-local-more" data-testid="create-bot-local-more">
          {#if templates.length > 0}
            <button
              type="button"
              class="new-bot-more"
              aria-expanded={templatesOpen}
              data-testid="create-bot-templates-toggle"
              disabled={busy}
              onclick={() => (templatesOpen = !templatesOpen)}
            ><RailIcon name="folder" />{chosenTemplateCard ? `From ${chosenTemplateCard.name}` : "Start from a template"}</button>
          {/if}
          <button
            type="button"
            class="new-bot-more"
            aria-expanded={advancedOpen}
            data-testid="chat-bot-advanced-toggle"
            disabled={busy}
            onclick={() => (advancedOpen = !advancedOpen)}
          ><RailIcon name="sliders" />Advanced</button>
        </div>
        {#if templatesOpen && templates.length > 0}
          <KindStep sunrise {draft} {templates} disabled={busy} onpatch={patch} onadvance={() => (templatesOpen = false)} />
          {#if chosenTemplateCard && templateBringsLine(chosenTemplateCard)}
            <!-- What the template brings, where it is picked. -->
            <p class="cb-help brings" data-testid="chat-bot-template-brings">{templateBringsLine(chosenTemplateCard)}</p>
          {/if}
        {/if}
        {#if advancedOpen}
          <LocalBotAdvanced {draft} existingNames={names} {ownerCompanies} disabled={busy} onpatch={patch} />
        {/if}
      {/if}
    </section>
  </div>

  <footer class="new-bot-create-foot">
    {#if entryError}
      <p class="new-bot-create-error" role="alert" data-testid="chat-create-entry-error">
        {entryError}
        {#if entryFix?.kind === "checkout"}
          <a class="new-bot-takeover-local" href={entryFix.url} target="_blank" rel="noopener noreferrer" data-testid="chat-create-entry-fix">{entryFix.label}</a>
        {:else if entryFix?.kind === "reload_quote"}
          <button type="button" class="new-bot-takeover-local" data-testid="chat-create-entry-fix" disabled={busy} onclick={() => (quoteReloadToken += 1)}><RailIcon name="refresh" />Get the new price</button>
        {:else if entryFix?.kind === "edit_handle" && draft.home === "cloud" && step !== "details"}
          <button type="button" class="new-bot-takeover-local" data-testid="chat-create-entry-fix" disabled={busy} onclick={() => goTo("details")}><RailIcon name="pencil" />Change handle</button>
        {/if}
      </p>
    {/if}
    {#if issue}<p class="new-bot-price" data-testid="create-bot-issue" aria-live="polite">{issue}</p>{/if}
    <button
      type="button"
      class="new-bot-create-submit"
      data-testid={isLast ? "chat-bot-create" : "create-bot-next"}
      disabled={isLast ? !createOk : !advanceOk}
      aria-busy={busy ? "true" : undefined}
      onclick={primary}
    ><RailIcon name={isLast ? "plus" : "arrow-right"} />{primaryLabel}</button>
    {#if isLast}<p class="new-bot-price new-bot-chord-hint" aria-hidden="true" data-testid="create-bot-hint"><kbd class="new-bot-chord">{primaryEnterHint}</kbd> to create</p>{/if}
    {#if step === steps[0] && draft.home === "local" && switchCloud}
      <button type="button" class="new-bot-takeover-local" data-testid="create-bot-switch-cloud" disabled={busy} onclick={switchCloud}>Create a cloud bot instead</button>
    {/if}
  </footer>
{/if}
</div>

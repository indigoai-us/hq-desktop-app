<script lang="ts">
  /**
   * Visual first-run setup (slice 1): the New bot takeover's step-through
   * screens, opened on a first run instead of the setup bot's chat. Name
   * your HQ assistant, Your coding tools, Done. The steps come from
   * `FIRST_RUN_STEPS`, so later slices add screens without touching the
   * bars or the footers here.
   *
   * The host owns the create (`creation`, `onconfirmname`, `onretry`): it
   * starts as soon as the name is confirmed and a coding tool is ready, and
   * runs while the person is on the later screens. Every async action shows
   * its pending state at once and holds duplicate presses.
   *
   * Slice 4 adds "Bring in your context" (the knowledge tree) when the host
   * can scan this computer (`importHost`). The scan runs here, one at a
   * time; leaving the step (Next, Finish, Back, Continue in chat) cancels a
   * scan that is still running. A finished scan's counts and report path go
   * to the host (`onimport`) for the setup bot's handoff.
   *
   * Slice 2 adds "Your team" (`teamOptions` + `teamHost`): Next joins or
   * starts the picked company, one action at a time. Slice 5 adds Note taker
   * and Project management (`appsHost`) for the company picked there; a
   * connect never holds Next. What they settle goes to the host
   * (`onsettled`) for the setup bot's handoff.
   *
   * Your coding tools is required (owner, 2026-10-10): the assistant runs on
   * a signed-in coding tool, so the screen has no Continue in chat. While no
   * tool is signed in it shows one Sign in per tool (FirstRunToolsSignIn),
   * leading with the tool whose desktop app is here, and reads readiness
   * again when a sign-in ends and when the window comes back into focus.
   */
  import { onDestroy, onMount, tick, untrack } from "svelte";
  import LazyDoor from "../../shell/LazyDoor.svelte";
  import { firstRunImportDoor } from "../../shell/lazy-doors.js";
  import {
    createImportRunner,
    importResultOf,
    type ImportRunView,
    type ImportScanHost,
  } from "./knowledge-tree/import-runner.js";
  import { createSceneClock, type SceneClock } from "./knowledge-tree/scene-clock.js";
  import { hostComputerNoun, subscribeHostComputerNoun } from "@hq/platform";
  import RailIcon from "../../common/button/RailIcon.svelte";
  import { suspendShortcuts } from "../../common/keyboard-shortcuts.js";
  import { portal } from "../portal.js";
  import NewBotNameStep from "../create-bot/NewBotNameStep.svelte";
  import NewBotStepHead from "../create-bot/NewBotStepHead.svelte";
  import NewBotOrbIcon from "../create-bot/NewBotOrbIcon.svelte";
  import HomeStep from "../create-bot/HomeStep.svelte";
  import type { RuntimeSignInApi } from "../create-bot/RuntimeSignIn.svelte";
  import type { RuntimeStatus } from "../create-bot/runtime-status.js";
  import { initialDraft, type BotRuntime, type CreateBotDraft } from "../create-bot/create-bot-model.js";
  import { newBotWallpaper } from "../create-bot/new-bot-wallpapers.js";
  import type {
    AiTools,
    AssistantId,
    CodingTool,
    InstallOutcome,
  } from "../../install-choice/install-choice.js";
  import { SETUP_BOT_RUNTIME_ORDER } from "../setup-bot.js";
  import {
    FIRST_RUN_COPY,
    FIRST_RUN_NAME_TITLE,
    FIRST_RUN_STEPS,
    anyToolReady,
    assistantNameIssue,
    firstRunCanLeave,
    firstRunDoneTitle,
    firstRunFinishTarget,
    firstRunNextLabel,
    firstRunOffersChat,
    firstRunOffersFinish,
    firstRunStepNumber,
    firstRunStepsFor,
    firstRunTalkLabel,
    firstRunToolsTitle,
    nextFirstRunStep,
    normalizeAssistantName,
    prevFirstRunStep,
    runtimeLabel,
    type FirstRunCreation,
    type FirstRunImportHandoff,
    type FirstRunStep,
    type FirstRunStepId,
  } from "./visual-first-run.js";
  import FirstRunTeamStep from "./FirstRunTeamStep.svelte";
  import CompanyLabel from "../../company/CompanyLabel.svelte";
  import FirstRunAppStep from "./FirstRunAppStep.svelte";
  import FirstRunToolsSignIn from "./FirstRunToolsSignIn.svelte";
  import { preferredSignInTool, toolRowKinds, toolsSignInLead, type SignInTool } from "./tools-signin.js";
  import {
    TEAM_COPY,
    companyNameIssue,
    createTeamActionRunner,
    defaultTeamChoice,
    defaultTeamPick,
    teamHandoff,
    teamPickKey,
    teamSummary,
    teamVerb,
    type FirstRunTeamChoice,
    type FirstRunTeamCompany,
    type FirstRunTeamOptions,
    type FirstRunTeamPick,
    type TeamActionResult,
    type TeamActionState,
  } from "./team-step.js";
  import {
    appStepCopy,
    appSummary,
    createAppConnectRunner,
    type AppCatalogResult,
    type AppCatalogState,
    type AppConnectResult,
    type AppConnectRunner,
    type AppConnectState,
    type FirstRunApp,
    type FirstRunAppKind,
  } from "./app-step.js";
  import type { FirstRunAppsHandoff } from "./visual-first-run.js";
  import type { FirstRunAppsHost, FirstRunSettled, FirstRunTeamHost } from "./first-run-hosts.js";
  import "../create-bot/new-bot-takeover.css";


  interface Props {
    /** The suggested name the name step opens with. */
    initialName: string;
    steps?: readonly FirstRunStep[];
    /** Test and harness seam: open on this step. */
    initialStep?: FirstRunStepId;
    runtimeReady: Record<string, boolean> | null;
    runtimeStatus?: Record<string, RuntimeStatus> | null;
    signInApi?: RuntimeSignInApi | null;
    onsignedin?: ((runtime: BotRuntime) => void | Promise<void>) | null;
    onrecheck?: (() => void | Promise<void>) | null;
    /** Test seam: how long opening a sign-in may take before it fails. */
    signInOpenTimeoutMs?: number;
    /** Test seam: how long a tool may read "Checking…" before Check again shows. */
    toolCheckingStaleMs?: number;
    aiTools?: AiTools | null;
    hqFolderPath?: string;
    onopenassistant?: (assistant: AssistantId, url: string) => Promise<InstallOutcome>;
    onassistedinstall?: (tool: CodingTool) => Promise<InstallOutcome>;
    onrequestaitools?: () => void;
    pollMs?: number;
    /** Where creating the assistant stands (the host runs it). */
    creation: FirstRunCreation;
    /**
     * The name is confirmed: the host starts creating the assistant now if a
     * coding tool is ready, and as soon as one is otherwise.
     */
    onconfirmname: (name: string, runtime: BotRuntime) => void;
    /** The coding tool the person picked on the tools step. */
    onruntime?: ((runtime: BotRuntime) => void) | null;
    onretry: () => void;
    /** Done: open the assistant's chat. */
    ontalk: () => void | Promise<void>;
    /** Leave for the setup chat (every screen but Your coding tools, and the failure line). */
    oncontinueinchat: () => void | Promise<void>;
    /**
     * Runs the context scan on this computer. Without it the flow has no
     * "Bring in your context" step.
     */
    importHost?: ImportScanHost | null;
    /** The scan finished: its counts and report path, for the handoff. */
    onimport?: ((result: FirstRunImportHandoff) => void) | null;
    /** Test seam for the context step: null follows prefers-reduced-motion. */
    reducedMotion?: boolean | null;
    /** The person's companies and invites. Without it (or `teamHost`) there is no "Your team". */
    teamOptions?: FirstRunTeamOptions | null;
    teamHost?: FirstRunTeamHost | null;
    /** Without it there are no Note taker and Project management screens. */
    appsHost?: FirstRunAppsHost | null;
    /** Every change to what "Your team" and the app screens settled. */
    onsettled?: ((settled: FirstRunSettled) => void) | null;
  }

  let {
    initialName,
    steps = FIRST_RUN_STEPS,
    initialStep = "name",
    runtimeReady,
    runtimeStatus = null,
    signInApi = null,
    onsignedin = null,
    onrecheck = null,
    signInOpenTimeoutMs = undefined,
    toolCheckingStaleMs = undefined,
    aiTools = null,
    hqFolderPath = "",
    onopenassistant,
    onassistedinstall,
    onrequestaitools,
    pollMs = 1500,
    creation,
    onconfirmname,
    onruntime = null,
    onretry,
    ontalk,
    oncontinueinchat,
    importHost = null,
    onimport = null,
    reducedMotion = null,
    teamOptions = null,
    teamHost = null,
    appsHost = null,
    onsettled = null,
  }: Props = $props();

  // ── Your team ──────────────────────────────────────────────────────────
  const canTeam = $derived(!!teamOptions && !!teamHost);
  const teamOpts = $derived<FirstRunTeamOptions>(teamOptions ?? { invites: [], companies: [] });
  /** The card picked on the screen; starts on the default. */
  let teamPick = $state<FirstRunTeamPick>(untrack(() => defaultTeamPick(teamOptions ?? { invites: [], companies: [] })));
  /** What the person settled on; null until they pass the screen. */
  let teamChoice = $state<FirstRunTeamChoice | null>(null);
  let companyName = $state("");
  let companyNameTried = $state(false);
  let teamAction = $state<TeamActionState>({ state: "idle" });
  const teamRunner = createTeamActionRunner((next) => {
    teamAction = next;
    if (next.state === "done") {
      if (next.choice.kind === "company" && next.choice.how === "created") {
        createdChoice = next.choice;
        companyName = next.choice.company.name;
      }
      settleTeam(next.choice);
      // The press that started it moves on once it is done.
      if (step === "team") goTo(nextFirstRunStep("team", shownSteps));
    }
  });
  /** The choice as the later screens and the handoff see it: settled, else the default. */
  const effectiveTeam = $derived<FirstRunTeamChoice | null>(
    teamChoice ?? (canTeam ? defaultTeamChoice(teamOpts) : null),
  );
  const appsCompany = $derived(
    effectiveTeam?.kind === "company" && effectiveTeam.company.companyUid
      ? { uid: effectiveTeam.company.companyUid, name: effectiveTeam.company.name }
      : null,
  );
  const companyIssue = $derived(teamPick.kind === "create" && companyNameTried ? companyNameIssue(companyName) : null);

  // ── Note taker and Project management ─────────────────────────────────
  let appCatalog = $state<Record<FirstRunAppKind, AppCatalogState | null>>({ notes: null, projects: null });
  let appConnect = $state<Record<FirstRunAppKind, AppConnectState>>({ notes: { state: "idle" }, projects: { state: "idle" } });
  /** Screens passed forward (Next or Finish from them). */
  let appsPassed = $state<Record<FirstRunAppKind, boolean>>({ notes: false, projects: false });
  /** One runner per screen and company: a different company starts over. */
  const appRunners = new Map<string, AppConnectRunner>();
  let appsCompanyUid: string | null = null;

  /** The steps this host can show (no context step without a scan host, and so on). */
  const shownSteps = $derived(
    firstRunStepsFor(
      {
        canImport: !!importHost,
        canTeam,
        canConnectApps: !!appsHost && !!appsCompany,
        personal: !appsCompany,
      },
      steps,
    ),
  );

  /**
   * The app a screen has connected: the one connected here, else the first of
   * its apps the company already had (the screen shows it as Connected).
   */
  function connectedAppOf(kind: FirstRunAppKind): FirstRunApp | null {
    const state = appConnect[kind];
    if (state.state === "connected") return state.app;
    const catalog = appCatalog[kind];
    if (!catalog || catalog.state !== "loaded" || !catalog.ok) return null;
    const already = new Set(catalog.connected);
    return catalog.apps.find((app) => already.has(app.domain)) ?? null;
  }

  function settled(): FirstRunSettled {
    const apps: FirstRunAppsHandoff = {};
    for (const kind of ["notes", "projects"] as const) {
      if (!appsPassed[kind]) continue;
      const app = connectedAppOf(kind);
      // A connect still running is not settled either way: left out until it answers.
      if (!app && appConnect[kind].state === "connecting") continue;
      apps[kind] = app ? { name: app.name, domain: app.domain } : null;
    }
    return { team: teamChoice ? teamHandoff(teamChoice) : null, apps };
  }
  function report(): void {
    onsettled?.(settled());
  }
  function companyUidOf(choice: FirstRunTeamChoice | null): string | null {
    return choice?.kind === "company" ? choice.company.companyUid : null;
  }
  /**
   * Take a team choice. When it moves the company the apps connect to, the
   * app screens start over first, so nothing reported belongs to the old one.
   */
  function applyTeam(choice: FirstRunTeamChoice): void {
    teamChoice = choice;
    const uid = appsHost ? companyUidOf(choice) : null;
    if (uid !== appsCompanyUid) resetApps(uid);
  }
  function settleTeam(choice: FirstRunTeamChoice): void {
    applyTeam(choice);
    report();
  }
  /** The company Join or Start is working on, for the held Next button. */
  let teamPending = $state<{ verb: string; name: string; companyUid: string | null } | null>(null);
  /** The company a successful "Start a company" made: Next keeps it, never makes a second. */
  let createdChoice = $state<FirstRunTeamChoice | null>(null);
  /** Calls off an app connect still waiting when the takeover goes away. */
  const appsAbort = new AbortController();

  function runnerFor(kind: FirstRunAppKind): AppConnectRunner | null {
    const company = appsCompany;
    const host = appsHost;
    if (!company || !host) return null;
    const key = `${kind}:${company.uid}`;
    let runner = appRunners.get(key);
    if (!runner) {
      runner = createAppConnectRunner(
        (app) => host.connect(company.uid, app, appsAbort.signal),
        (state) => {
          // A company changed meanwhile: this answer is not the screen's any more.
          if (appsCompany?.uid !== company.uid) return;
          appConnect = { ...appConnect, [kind]: state };
          if (state.state === "connected") report();
        },
      );
      appRunners.set(key, runner);
    }
    return runner;
  }

  function loadCatalog(kind: FirstRunAppKind): void {
    const company = appsCompany;
    const host = appsHost;
    if (!company || !host) return;
    appCatalog = { ...appCatalog, [kind]: { state: "loading" } };
    void Promise.resolve()
      .then(() => host.catalog(company.uid, kind))
      .then(
        (result) => result,
        (err: unknown): AppCatalogResult => {
          console.warn("[hq-desktop] first-run catalog read threw:", err);
          return { ok: false, reason: "Could not load the apps. Try again.", retry: true };
        },
      )
      .then((result) => {
        if (appsCompany?.uid === company.uid) appCatalog = { ...appCatalog, [kind]: { ...result, state: "loaded" } };
      });
  }

  function resetApps(uid: string | null): void {
    appsCompanyUid = uid;
    appCatalog = { notes: null, projects: null };
    appConnect = { notes: { state: "idle" }, projects: { state: "idle" } };
    appsPassed = { notes: false, projects: false };
    for (const kind of ["notes", "projects"] as const) {
      const runner = uid ? appRunners.get(`${kind}:${uid}`) : null;
      if (runner) appConnect[kind] = runner.current();
    }
  }
  // The company the apps connect to changed (the default moved with the
  // roster): the screens start over.
  $effect(() => {
    const uid = appsCompany?.uid ?? null;
    untrack(() => {
      if (uid !== appsCompanyUid) resetApps(uid);
    });
  });
  // An app screen opens: its list loads the first time.
  $effect(() => {
    if (step !== "notes" && step !== "projects") return;
    const kind = step;
    untrack(() => {
      if (!appCatalog[kind]) loadCatalog(kind);
    });
  });

  let step = $state<FirstRunStepId>(untrack(() => initialStep));
  /** The name as typed or confirmed. */
  let name = $state(untrack(() => initialName));
  /** The coding tool card that is picked. Starts on the first ready one. */
  let draft = $state<CreateBotDraft>(
    untrack(() =>
      initialDraft(
        { canLocal: true, canCloud: false, existingNames: [], companies: [], runtimeReady },
        null,
        null,
        "local",
        initialName || "assistant",
      ),
    ),
  );
  let hostNoun = $state(hostComputerNoun());
  onMount(() => subscribeHostComputerNoun((next) => (hostNoun = next)));
  // The takeover owns the keyboard while it is open (as NewBotTakeover does).
  onMount(() => suspendShortcuts());

  /** One leave at a time: Talk or Continue in chat, whichever was pressed. */
  let leaving = $state<"talk" | "chat" | null>(null);

  const total = $derived(shownSteps.length);
  const ready = $derived(anyToolReady(runtimeReady));
  /** The name is part of setup now: changing it would not reach the bot. */
  const nameLocked = $derived(creation.state === "creating" || creation.state === "ready");
  const shownName = $derived((creation.state === "idle" ? name : creation.name).trim() || "your assistant");
  const doneTitle = $derived(firstRunDoneTitle(shownName));
  const toolsTitle = $derived(firstRunToolsTitle(shownName, hostNoun));
  const botRuntime = $derived<BotRuntime | null>(
    runtimeReady?.[draft.runtime] === true
      ? draft.runtime
      : (SETUP_BOT_RUNTIME_ORDER.find((runtime) => runtimeReady?.[runtime] === true) ?? null),
  );

  // ── Your coding tools ──────────────────────────────────────────────────
  /** What each tool's Sign in row offers (Claude Code and Codex). */
  const toolKinds = $derived(toolRowKinds(runtimeStatus, runtimeReady, aiTools));
  /** The tool the screen leads with: the one whose desktop app is here. */
  const preferredTool = $derived<SignInTool>(preferredSignInTool(toolKinds, aiTools));
  /** The person picked a tool (a card, or a Sign in): the pick is theirs now. */
  let runtimePicked = false;
  /**
   * The tool the pick moves to while the person has not chosen: the
   * preferred tool when it is signed in (or none is), else the first signed
   * in one.
   */
  const autoRuntime = $derived<BotRuntime>(
    !anyToolReady(runtimeReady) || runtimeReady?.[preferredTool] === true
      ? preferredTool
      : (SETUP_BOT_RUNTIME_ORDER.find((runtime) => runtimeReady?.[runtime] === true) ?? preferredTool),
  );
  // Preselect the preferred tool, and follow a tool signed in later, so the
  // assistant thinks with what the person sees picked. A pick the person made
  // stays unless it is not signed in and another one is.
  $effect(() => {
    const target = autoRuntime;
    untrack(() => {
      const current = draft.runtime;
      if (runtimePicked && (runtimeReady?.[current] === true || !anyToolReady(runtimeReady))) return;
      if (!runtimePicked || runtimeReady?.[target] === true) {
        if (target !== current) {
          draft = { ...draft, runtime: target };
          onruntime?.(target);
        }
      }
    });
  });
  /** What the tools step asks the one live region to say (a sign-in's state). */
  let toolsAnnouncement = $state("");
  onMount(() => {
    // The rows lead with a desktop app's tool, so ask which apps are here.
    if (untrack(() => aiTools) == null) onrequestaitools?.();
  });
  let focusRecheck = false;
  /**
   * Back from the browser or a desktop app: read readiness (and the desktop
   * apps) again, so a sign-in finished elsewhere shows at once.
   */
  async function recheckOnFocus(): Promise<void> {
    if (step !== "tools" || ready || focusRecheck) return;
    focusRecheck = true;
    try {
      onrequestaitools?.();
      await onrecheck?.();
    } finally {
      focusRecheck = false;
    }
  }
  function pickTool(tool: SignInTool): void {
    runtimePicked = true;
    if (draft.runtime !== tool) {
      draft = { ...draft, runtime: tool };
      onruntime?.(tool);
    }
  }

  // ── Bring in your context ──────────────────────────────────────────────
  /** The context scene's clock, started the first time the step opens. */
  let importClock = $state.raw<SceneClock | null>(null);
  let importRun = $state.raw<ImportRunView>({ phase: "idle", scanStart: null, events: [], failure: null });
  let importReported = false;
  const importRunner = createImportRunner(
    untrack(() => importHost),
    () => importClock?.now() ?? 0,
    (view) => {
      importRun = view;
      if (view.phase === "done" && !importReported) {
        importReported = true;
        const result = importResultOf(view.events);
        if (result) onimport?.(result);
      }
    },
  );
  $effect(() => {
    if (step !== "context" || importClock) return;
    untrack(() => {
      importClock = createSceneClock();
    });
  });
  onMount(() => {
    // Warm the scene's chunk while the person is on the earlier steps.
    if (untrack(() => importHost)) firstRunImportDoor.preload();
  });
  onDestroy(() => {
    appsAbort.abort();
    importRunner.dispose();
    importClock?.dispose();
  });

  /** A scan still running stops when the person leaves its step, however they leave. */
  function leaveContext(): void {
    if (importRunner.current().phase === "running") importRunner.cancel();
    importAnnouncement = "";
  }
  /** What the context step asks the one live region to say (its scan's state). */
  let importAnnouncement = $state("");

  function goTo(next: FirstRunStepId | null): void {
    if (!next) return;
    if (step === "context" && next !== "context") leaveContext();
    const from = shownSteps.findIndex((s) => s.id === step);
    const to = shownSteps.findIndex((s) => s.id === next);
    if (to > from) passForward(from, to);
    step = next;
  }

  /**
   * Moving forward past screens settles them: "Your team" takes its default
   * when it was never answered (Finish with defaults), and an app screen
   * left forward counts as passed (connected or skipped). An app screen
   * jumped over is not passed: the setup bot still asks about it.
   */
  function passForward(from: number, to: number): void {
    let changed = false;
    for (let i = Math.max(0, from); i < to; i += 1) {
      const id = shownSteps[i]?.id;
      if (id === "team" && !teamChoice && canTeam) {
        applyTeam(defaultTeamChoice(teamOpts));
        changed = true;
      }
      if ((id === "notes" || id === "projects") && i === from && !appsPassed[id]) {
        appsPassed = { ...appsPassed, [id]: true };
        changed = true;
      }
    }
    if (changed) report();
  }

  /** Next on "Your team": settle the picked card, joining or starting a company first. */
  function teamNext(): void {
    if (teamAction.state === "running" || !teamHost) return;
    const pick = teamPick;
    const key = teamPickKey(pick);
    if (teamAction.state === "done" && teamAction.key === key) {
      settleTeam(teamAction.choice);
      goTo(nextFirstRunStep("team", shownSteps));
      return;
    }
    if (pick.kind === "create" && createdChoice) {
      settleTeam(createdChoice);
      goTo(nextFirstRunStep("team", shownSteps));
      return;
    }
    if (pick.kind === "personal") {
      settleTeam({ kind: "personal" });
      goTo(nextFirstRunStep("team", shownSteps));
      return;
    }
    if (pick.kind === "existing") {
      settleTeam({ kind: "company", how: "existing", company: pick.company });
      goTo(nextFirstRunStep("team", shownSteps));
      return;
    }
    const host = teamHost;
    if (pick.kind === "invite") {
      teamPending = { verb: "Joining ", name: pick.company.name, companyUid: pick.company.companyUid ?? pick.company.slug };
      teamRunner.run(key, `Joining ${pick.company.name}…`, () => host.join(pick.company));
      return;
    }
    companyNameTried = true;
    if (companyNameIssue(companyName)) return;
    const typed = companyName.split(/\s+/).filter(Boolean).join(" ");
    teamPending = { verb: "Starting ", name: typed, companyUid: null };
    teamRunner.run(key, `Starting ${typed}…`, () => host.create(typed));
  }

  /** The person chose a card: the roster arriving later no longer moves the pick. */
  let teamPickTouched = false;
  function pickTeam(pick: FirstRunTeamPick): void {
    teamPickTouched = true;
    teamPick = pick;
    teamRunner.clear();
  }
  // The roster can answer after the takeover opened: the untouched pick follows the default.
  $effect(() => {
    const opts = teamOpts;
    untrack(() => {
      if (!teamPickTouched && !teamChoice) teamPick = defaultTeamPick(opts);
    });
  });

  function connectApp(kind: FirstRunAppKind, app: FirstRunApp): void {
    runnerFor(kind)?.connect(app);
  }

  function confirmName(next: string, finish: boolean): void {
    if (!nameLocked) {
      name = normalizeAssistantName(next);
      onconfirmname(name, draft.runtime);
    }
    goTo(finish ? firstRunFinishTarget(runtimeReady, shownSteps, "name") : nextFirstRunStep("name", shownSteps));
  }

  function patchDraft(patch: Partial<CreateBotDraft>): void {
    if (patch.runtime) runtimePicked = true;
    draft = { ...draft, ...patch };
    if (patch.runtime) onruntime?.(patch.runtime);
  }

  async function leave(kind: "talk" | "chat"): Promise<void> {
    if (leaving) return;
    leaving = kind;
    leaveContext();
    try {
      await (kind === "talk" ? ontalk() : oncontinueinchat());
    } finally {
      leaving = null;
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    // Escape does not leave a first run by accident: the header's
    // "Continue in chat" is the way out, and on Your coding tools there is
    // none (a signed-in tool is required).
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  /**
   * What the one live region says. It stays mounted for the whole takeover
   * and only its text changes, so screen readers hear every change of the
   * create, on every screen. On the context step it says how the scan is
   * going (the step has no live region of its own).
   */
  const announcement = $derived(
    step === "context" && importAnnouncement
      ? importAnnouncement
      : step === "tools" && toolsAnnouncement && !ready
      ? toolsAnnouncement
      : step === "team" && teamAction.state === "running"
      ? teamAction.label
      : step === "team" && teamAction.state === "failed"
      ? teamAction.reason
      : (step === "notes" || step === "projects") && appConnect[step].state === "failed"
      ? (appConnect[step] as { reason: string }).reason
      : creation.state === "failed"
      ? creation.reason
      : creation.state === "creating"
        ? `Getting ${shownName} ready…`
        : creation.state === "ready"
          ? `${shownName} is ready.`
          : "",
  );

  let cardEl = $state<HTMLDivElement | null>(null);
  /**
   * Focus stays in the dialog: on open, and after every step change (the
   * pressed button is gone). The name step focuses its field itself, unless
   * the field is locked, when Next takes it.
   */
  $effect(() => {
    void step;
    const locked = nameLocked;
    const card = cardEl;
    if (!card) return;
    void tick().then(() => {
      const active = document.activeElement;
      if (active && active !== card && card.contains(active)) return;
      const target =
        (step === "name" && locked
          ? card.querySelector<HTMLElement>('[data-testid="new-bot-continue-name"]')
          : card.querySelector<HTMLElement>(
              'input:not([disabled]), button[role=radio][aria-checked=true]:not([disabled]), .first-run-tool-action.primary:not([disabled]), [data-testid="first-run-import-start"]:not([disabled]), [data-testid="first-run-next"]:not([disabled]), [data-testid="first-run-talk"]:not([disabled])',
            )) ?? card;
      target.focus();
    });
  });

  /** The finished scan's counts, for the Done summary. */
  const importSummary = $derived(importRun.phase === "done" ? (importResultOf(importRun.events)?.summary ?? null) : null);
  const contextSummary = $derived.by(() => {
    const s = importSummary;
    if (!s) return importRun.phase === "running" ? "Still reading…" : "Not brought in";
    const parts: string[] = [];
    const companies = s.companies ?? 0;
    const projects = s.projects ?? 0;
    if (companies) parts.push(`${companies} ${companies === 1 ? "company" : "companies"}`);
    if (projects) parts.push(`${projects} ${projects === 1 ? "project" : "projects"}`);
    return parts.length ? parts.join(", ") : "Brought in";
  });
  const summaryRows = $derived(
    2 +
      (canTeam ? 1 : 0) +
      shownSteps.filter((s) => s.id === "context" || s.id === "notes" || s.id === "projects").length,
  );

  /**
   * "Continue in chat" ends the takeover, so it is held back on the steps
   * before the import (firstRunOffersChat): Next is the only way forward
   * there, and the import is never skipped without being seen.
   */
  const offersChat = $derived(firstRunOffersChat(step, runtimeReady, shownSteps));

  const talkLabel = $derived(
    leaving === "talk"
      ? FIRST_RUN_COPY.opening
      : creation.state === "creating"
        ? `Getting ${shownName} ready…`
        : firstRunTalkLabel(shownName),
  );
</script>

<svelte:window onkeydown={onKeydown} onfocus={() => void recheckOnFocus()} />

<div
  class="new-bot-takeover chat-shell"
  data-testid="first-run-takeover"
  data-step={step}
  style={`--new-bot-wallpaper: url("${newBotWallpaper(0)}")`}
  use:portal
>
  <div class="new-bot-takeover-shade" aria-hidden="true"></div>
  <header class="new-bot-takeover-header">
    <span class="new-bot-takeover-wordmark">HQ</span>
    {#if offersChat}<button
      type="button"
      class="new-bot-takeover-cancel"
      data-testid="first-run-continue-in-chat"
      disabled={leaving !== null}
      aria-busy={leaving === "chat" ? "true" : undefined}
      onclick={() => void leave("chat")}
    >{leaving === "chat" ? FIRST_RUN_COPY.opening : FIRST_RUN_COPY.continueInChat}</button>{/if}
  </header>
  {#if step === "context"}
    <!-- Bring in your context: a full-window scene instead of the card. -->
    <div
      bind:this={cardEl}
      class="first-run-import-host"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-bot-takeover-title"
      tabindex="-1"
    >
      <div class="first-run-import-step" data-testid="first-run-step" data-step={step} role="group">
        {#if importClock}
          <LazyDoor
            door={firstRunImportDoor}
            props={{
              name: shownName,
              stepNumber: firstRunStepNumber("context", shownSteps),
              total,
              run: importRun,
              clock: importClock,
              nextLabel: firstRunNextLabel("context", shownSteps),
              offersFinish: firstRunOffersFinish("context", shownSteps),
              finishLabel: FIRST_RUN_COPY.finish,
              leaving: leaving !== null,
              onback: () => goTo(prevFirstRunStep("context", shownSteps)),
              onstart: () => importRunner.start(),
              onskip: () => {
                importRunner.skip();
                goTo(nextFirstRunStep("context", shownSteps));
              },
              onretry: () => importRunner.retry(),
              onrecheck: () => importRunner.recheck(),
              onnext: () => goTo(nextFirstRunStep("context", shownSteps)),
              onfinish: () => goTo(firstRunFinishTarget(runtimeReady, shownSteps, "context")),
              reducedMotion,
              onannounce: (text: string) => (importAnnouncement = text),
            }}
          >
            {#snippet skeleton()}
              <div class="first-run-import-loading" data-testid="first-run-import-loading" aria-hidden="true"></div>
            {/snippet}
          </LazyDoor>
        {/if}
      </div>
    </div>
  {:else}
  <main class="new-bot-takeover-stage">
    <div
      bind:this={cardEl}
      class="new-bot-takeover-card new-bot-takeover-card--flow new-bot-takeover-card--steps"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-bot-takeover-title"
      tabindex="-1"
    >
      <div class="new-bot-create" data-testid="first-run-step" data-step={step} role="group">
        {#if step === "name"}
          <NewBotNameStep
            name={creation.state === "idle" ? name : creation.name}
            {total}
            current={firstRunStepNumber("name", shownSteps)}
            title={FIRST_RUN_NAME_TITLE}
            issueFor={assistantNameIssue}
            showHandle={false}
            nextLabel={firstRunNextLabel("name", shownSteps)}
            onfinish={firstRunOffersFinish("name", shownSteps) ? (next) => confirmName(next, true) : null}
            note={nameLocked ? FIRST_RUN_COPY.nameLocked : ""}
            locked={nameLocked}
            oninput={(next) => { if (!nameLocked) name = next; }}
            oncontinue={(next) => confirmName(next, false)}
          />
        {:else}
          {@const appKind = step === "notes" || step === "projects" ? step : null}
          {@const appCopy = appKind ? appStepCopy(appKind, shownName, appsCompany?.name ?? "") : null}
          {@const title = step === "tools" ? toolsTitle : step === "team" ? TEAM_COPY : appCopy ?? doneTitle}
          {@const isLast = nextFirstRunStep(step, shownSteps) === null}
          {@const canLeave = firstRunCanLeave(step, runtimeReady)}
          <NewBotStepHead
            {total}
            current={firstRunStepNumber(step, shownSteps)}
            onback={() => goTo(prevFirstRunStep(step, shownSteps))}
            backTestId="first-run-back"
            backDisabled={leaving !== null}
            kicker={title.kicker}
            lead={title.lead}
            em={title.em}
          />
          <section class="new-bot-step new-bot-step--fit" data-testid={`first-run-${step}`}>
            {#if step === "team"}
              <FirstRunTeamStep
                options={teamOpts}
                pick={teamPick}
                onpick={pickTeam}
                {companyName}
                oncompanyname={(next) => (companyName = next)}
                nameIssue={companyIssue}
                busy={teamAction.state === "running"}
                nameLocked={!!createdChoice}
                onsubmit={teamNext}
              />
            {:else if appKind && appCopy}
              <FirstRunAppStep
                kind={appKind}
                copy={appCopy}
                company={appsCompany?.name ?? ""}
                catalog={appCatalog[appKind] ?? { state: "loading" }}
                connect={appConnect[appKind]}
                onconnect={(app) => connectApp(appKind, app)}
                onreload={() => loadCatalog(appKind)}
              />
            {:else if step === "tools" && !ready}
            <p class="new-bot-create-copy" data-testid="first-run-tools-lead">{toolsSignInLead(shownName, hostNoun, preferredTool, toolKinds, aiTools)}</p>
            {:else}
            <p class="new-bot-create-copy">{title.copy}</p>
            {/if}
            {#if step === "tools" && !ready}
              <FirstRunToolsSignIn
                kinds={toolKinds}
                preferred={preferredTool}
                noun={hostNoun}
                {signInApi}
                {pollMs}
                openTimeoutMs={signInOpenTimeoutMs}
                checkingStaleMs={toolCheckingStaleMs}
                {hqFolderPath}
                onpick={pickTool}
                onsignedin={async (tool) => {
                  await (onsignedin ? onsignedin(tool) : onrecheck?.());
                }}
                onrecheck={async () => {
                  onrequestaitools?.();
                  await onrecheck?.();
                }}
                {onopenassistant}
                {onassistedinstall}
                onannounce={(text) => (toolsAnnouncement = text)}
              />
            {:else if step === "tools"}
              <HomeStep
                runtimeOnly
                {draft}
                canLocal={true}
                canCloud={false}
                runtimeReady={runtimeReady}
                {runtimeStatus}
                companies={[]}
                onpatch={patchDraft}
                {signInApi}
                onsignedin={onsignedin ?? undefined}
                onrecheck={onrecheck ?? undefined}
                {pollMs}
                {aiTools}
                {hqFolderPath}
                {onopenassistant}
                {onassistedinstall}
                {onrequestaitools}
              />
            {:else if step === "done"}
              <ul class="first-run-summary" class:dense={summaryRows > 3} data-testid="first-run-summary">
                <li>
                  <span class="first-run-summary-orb" aria-hidden="true"><NewBotOrbIcon kind="local" size={34} /></span>
                  <span class="first-run-summary-text">
                    <span class="first-run-summary-label">Your HQ assistant</span>
                    <span class="first-run-summary-value" data-testid="first-run-summary-name">{shownName}</span>
                  </span>
                </li>
                {#if canTeam}
                  <li>
                    <span class="first-run-summary-dot ready" aria-hidden="true"></span>
                    <span class="first-run-summary-text">
                      <span class="first-run-summary-label">Your team</span>
                      <span class="first-run-summary-value" data-testid="first-run-summary-team"
                        >{#if effectiveTeam?.kind === "company"}{teamVerb(effectiveTeam)}<CompanyLabel
                            name={effectiveTeam.company.name}
                            companyUid={effectiveTeam.company.companyUid ?? effectiveTeam.company.slug}
                            size={16}
                          />{:else}{teamSummary(effectiveTeam)}{/if}</span
                      >
                    </span>
                  </li>
                {/if}
                <li>
                  <span class="first-run-summary-dot" class:ready={!!botRuntime} aria-hidden="true"></span>
                  <span class="first-run-summary-text">
                    <span class="first-run-summary-label">Coding tool</span>
                    <span class="first-run-summary-value" data-testid="first-run-summary-tool">
                      {botRuntime ? `${runtimeLabel(botRuntime)}, signed in` : "None signed in yet"}
                    </span>
                  </span>
                </li>
                {#if shownSteps.some((s) => s.id === "context")}
                  <li>
                    <span class="first-run-summary-dot" class:ready={!!importSummary} aria-hidden="true"></span>
                    <span class="first-run-summary-text">
                      <span class="first-run-summary-label">Your context</span>
                      <span class="first-run-summary-value" data-testid="first-run-summary-context">{contextSummary}</span>
                    </span>
                  </li>
                {/if}
                {#each ["notes", "projects"] as const as kind (kind)}
                  {#if shownSteps.some((s) => s.id === kind)}
                    {@const state = appConnect[kind]}
                    <li>
                      <span class="first-run-summary-dot" class:ready={state.state === "connected"} aria-hidden="true"></span>
                      <span class="first-run-summary-text">
                        <span class="first-run-summary-label">{kind === "notes" ? "Note taker" : "Project management"}</span>
                        <span class="first-run-summary-value" data-testid={`first-run-summary-${kind}`}>
                          {appSummary(connectedAppOf(kind), appsPassed[kind])}
                        </span>
                      </span>
                    </li>
                  {/if}
                {/each}
              </ul>
            {/if}
          </section>

          <footer class="new-bot-create-foot">
            <!-- A failed join, start or connect on this screen comes first. -->
            {#if step === "team" && teamAction.state === "failed"}
              <p class="new-bot-price first-run-status" data-testid="first-run-team-status" data-state="failed">
                {teamAction.reason}
                <button type="button" class="new-bot-inline-link" data-testid="first-run-team-retry" onclick={() => teamRunner.retry()}>{FIRST_RUN_COPY.retry}</button>
                {#if offersChat}<span aria-hidden="true">·</span>
                <button type="button" class="new-bot-inline-link" data-testid="first-run-team-chat" disabled={leaving !== null} onclick={() => void leave("chat")}>{FIRST_RUN_COPY.continueInChat}</button>{/if}
              </p>
            {:else if appKind && appConnect[appKind].state === "failed"}
              {@const failed = appConnect[appKind] as { reason: string; retry: boolean }}
              <p class="new-bot-price first-run-status" data-testid={`first-run-${appKind}-status`} data-state="failed">
                {failed.reason}
                {#if failed.retry}<button type="button" class="new-bot-inline-link" data-testid={`first-run-${appKind}-retry`} onclick={() => runnerFor(appKind)?.retry()}>{FIRST_RUN_COPY.retry}</button>
                <span aria-hidden="true">·</span>{/if}
                <button type="button" class="new-bot-inline-link" data-testid={`first-run-${appKind}-chat`} disabled={leaving !== null} onclick={() => void leave("chat")}>{FIRST_RUN_COPY.continueInChat}</button>
              </p>
            {:else if appKind && appConnect[appKind].state === "idle" && creation.state !== "failed"}
              <p class="new-bot-price first-run-status" data-testid={`first-run-${appKind}-hint`}>Don't use one? Skip this with Next.</p>
            <!-- Creating the assistant runs behind the screens: one quiet line. -->
            {:else if creation.state === "failed"}
              <p class="new-bot-price first-run-status" data-testid="first-run-create-status" data-state="failed">
                {creation.reason}
                <button type="button" class="new-bot-inline-link" data-testid="first-run-retry" onclick={onretry}>{FIRST_RUN_COPY.retry}</button>
                {#if offersChat}<span aria-hidden="true">·</span>
                <button type="button" class="new-bot-inline-link" data-testid="first-run-failed-chat" disabled={leaving !== null} onclick={() => void leave("chat")}>{FIRST_RUN_COPY.continueInChat}</button>{/if}
              </p>
            {:else if creation.state === "creating" && !isLast}
              <!-- On Done the held button already says it. -->
              <p class="new-bot-price first-run-status" data-testid="first-run-create-status" data-state="creating">Getting {shownName} ready…</p>
            {:else if creation.state === "ready" && step !== "done"}
              <p class="new-bot-price first-run-status" data-testid="first-run-create-status" data-state="ready">{shownName} is ready.</p>
            {:else if creation.state === "idle" && !ready}
              <p class="new-bot-price first-run-status" data-testid="first-run-create-status" data-state="waiting">{shownName} starts as soon as a coding tool is signed in.</p>
            {/if}
            {#if isLast}
              <div class="new-bot-foot-actions single">
                <button
                  type="button"
                  class="new-bot-create-submit"
                  data-testid="first-run-talk"
                  disabled={creation.state !== "ready" || leaving !== null}
                  aria-busy={creation.state === "creating" || leaving === "talk" ? "true" : undefined}
                  onclick={() => void leave("talk")}
                >{talkLabel}</button>
              </div>
            {:else}
              {@const offersFinish = firstRunOffersFinish(step, shownSteps)}
              {@const teamBusy = step === "team" && teamAction.state === "running"}
              <div class="new-bot-foot-actions" class:single={!offersFinish}>
                <button
                  type="button"
                  class={offersFinish ? "new-bot-create-next" : "new-bot-create-submit"}
                  data-testid="first-run-next"
                  disabled={!canLeave || teamBusy}
                  aria-busy={teamBusy ? "true" : undefined}
                  onclick={() => (step === "team" ? teamNext() : goTo(nextFirstRunStep(step, shownSteps)))}
                >{#if teamBusy && teamPending}{teamPending.verb}<CompanyLabel name={teamPending.name} companyUid={teamPending.companyUid} size={14} />…{:else}{firstRunNextLabel(step, shownSteps)}<RailIcon name="arrow-right" />{/if}</button>
                {#if offersFinish}
                  <button
                    type="button"
                    class="new-bot-create-submit"
                    data-testid="first-run-finish"
                    disabled={!canLeave || (step === "team" && teamAction.state === "running")}
                    onclick={() => goTo(firstRunFinishTarget(runtimeReady, shownSteps, step))}
                  >{FIRST_RUN_COPY.finish}</button>
                {/if}
              </div>
            {/if}
          </footer>
        {/if}
      </div>
    </div>
  </main>
  {/if}
  <!-- The one live region: always here, only its text changes. -->
  <p class="first-run-live" data-testid="first-run-live" aria-live="polite" aria-atomic="true">{announcement}</p>
</div>

<style>
  /* Bring in your context fills the window under the header. */
  .first-run-import-host,
  .first-run-import-step,
  .first-run-import-loading {
    position: absolute;
    inset: 0;
  }
  .first-run-import-host {
    z-index: 0;
    outline: none;
  }
  .first-run-import-loading {
    background: rgba(0, 0, 0, 0.72);
  }
  .new-bot-takeover[data-step="context"] .new-bot-takeover-header {
    position: relative;
    z-index: 3;
  }
  .first-run-summary {
    display: grid;
    gap: 10px;
    margin: 4px 0 0;
    padding: 0;
    list-style: none;
  }
  .first-run-summary li {
    display: flex;
    align-items: center;
    gap: 14px;
    min-height: 58px;
    border: 1px solid var(--new-bot-line);
    border-radius: 12px;
    padding: 10px 14px;
    background: rgba(9, 9, 11, 0.36);
  }
  /* Six rows fit without scrolling as two columns of shorter rows. */
  .first-run-summary.dense {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }
  .first-run-summary.dense li {
    min-height: 50px;
    gap: 10px;
    padding: 8px 12px;
  }
  .first-run-summary-orb {
    display: inline-grid;
    flex: 0 0 auto;
    place-items: center;
    width: 34px;
    height: 34px;
  }
  .first-run-summary-dot {
    flex: 0 0 auto;
    width: 10px;
    height: 10px;
    margin: 0 12px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.3);
  }
  .first-run-summary-dot.ready {
    background: #4ade80;
    box-shadow: 0 0 10px rgba(74, 222, 128, 0.55);
  }
  .first-run-summary-text {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .first-run-summary-label {
    color: var(--new-bot-muted);
    font-size: 12px;
  }
  .first-run-summary-value {
    overflow: hidden;
    font-size: 15px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .first-run-status {
    margin: 0;
  }
  /* Read by screen readers only; the visible line says the same. */
  .first-run-live {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
</style>

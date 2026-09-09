<script lang="ts">
  import ProviderConnect from '../../components/sessions/ProviderConnect.svelte';
  /**
   * Sessions — a chat with a Claude Code session running inside the app.
   *
   * THE WHOLE PAGE IS THE CHAT. There is no setup screen, no model-selection
   * step, no permanent side column: opening Sessions with nothing selected
   * shows an empty transcript with the composer focused, and the FIRST MESSAGE
   * starts the session it belongs to. Company, model, effort and permission
   * mode live as pills on the composer, so choosing them is something you can
   * do, not something you must do first.
   *
   * First send, in order:
   *   1. the bubble is mirrored in the store and painted immediately,
   *   2. `agent_session_start` mints a session id,
   *   3. `agent_session_send` delivers `/startwork {company} [project]` as a
   *      HIDDEN orientation turn (a system divider, not a bubble) — unless the
   *      company menu's toggle is off or the text already IS a `/startwork`,
   *   4. `agent_session_send` delivers the user's text (plus any context
   *      blocks, appended after the words),
   *   5. `onopensession(id)` moves the route.
   * The route change remounts this component under a new `{#key}`, which
   * replays the session from seq 0 — and the mirrored bubble survives because
   * the store keeps it OUTSIDE the per-session entry that `close()` drops.
   *
   * This page is the ONLY place the live-session store is driven from: the
   * strip, drawer, transcript and composer read it, the cards call back into
   * it, and every `agent_session_*` invoke lives inside it.
   */
  import { onDestroy } from 'svelte';
  import SessionListPanel from '../panels/SessionListPanel.svelte';
  import SessionComposer from '../../components/sessions/SessionComposer.svelte';
  import SessionTranscript from '../../components/sessions/SessionTranscript.svelte';
  import SessionsStrip from '../../components/sessions/SessionsStrip.svelte';
  import {
    deliveryStatusLine,
    loadMentionCandidates,
    notifyMentions,
    type Mention,
    type MentionCandidate,
  } from '../../components/sessions/mentions';
  import {
    mergeSlashCommands,
    mergeSkillMetadata,
    type SkillCatalog,
  } from '../../components/sessions/slash-commands';
  import {
    forgetLastProject,
    planFirstSend,
    readLastProject,
    readStartworkEnabled,
    rememberLastProject,
    rememberStartworkEnabled,
    startworkCommand,
    type ProjectEntry,
    type ProjectViewer,
  } from '../../components/sessions/startwork';
  import {
    composeWithContext,
    hqRelativePath,
    type LoadedAttachment,
  } from '../../components/sessions/context-attachments';
  import {
    emptyTranscript,
    type TranscriptState,
    type UserTurnMeta,
  } from '../../components/sessions/transcript-adapter';
  import ShareToChannelDialog from '../../components/sessions/ShareToChannelDialog.svelte';
  import {
    deployCommandFor,
    tauriArtifactActions,
  } from '../../components/sessions/session-artifacts';
  import {
    CHECKPOINT_COMMAND,
    HANDOFF_COMMAND,
    type HandoffState,
  } from '../../components/sessions/hook-notices';
  import type { SessionCommand } from '../../components/sessions/session-events';
  import {
    LAST_COMPANY_KEY,
    LAST_TOOL_KEY,
    TOOL_OPTIONS,
    clampEffort,
    effortOptionsFor,
    friendlyModelName,
    isFallbackCatalog,
    modelPillLabel,
    pickModel,
    plausibleModelForTool,
    readRemembered,
    readRememberedEffort,
    readRememberedModel,
    readRememberedTool,
    readSessionModels,
    remember,
    rememberEffort,
    rememberModel,
    validateModel,
    type ComposerImage,
    type SessionModel,
    type SessionToolId,
  } from '../../components/sessions/session-models';
  import {
    liveSessionStore,
    type PermissionMode,
    type Preflight,
    type SessionSpec,
    type TurnOverrides,
  } from '../lib/live-session-store.svelte';
  import type { AgentSession } from '../lib/sessions';
  import { encodeHistorySessionParam } from './sessions-route-param';
  import { sessionsStore } from '../lib/sessions-store.svelte';
  import ProjectCreatedCard from '../../components/sessions/ProjectCreatedCard.svelte';
  import { projectLinksStore } from '../lib/project-links-store.svelte';
  import {
    linkForProject,
    linkForSession,
    projectNameFor,
    projectSlugFor,
  } from '../lib/session-project-links';
  import '../../components/sessions/sessions-tokens.css';

  interface Props {
    /** Route-selected session. Absent → a fresh chat that starts on first send. */
    sessionId?: string;
    /** Navigate to `sessions:<id>` (the page never touches the router itself). */
    onopensession?: (sessionId: string, options?: { replace?: boolean }) => void;
    /** Open a channel by id after a share — the shell's own route mechanism. */
    onopenchannel?: (channelId: string) => void;
    /** A fresh chat pre-bound to this company (the sidebar's "New session"). */
    initialCompany?: string | null;
    /** …and to this project (directory slug), once the project list is in. */
    initialProject?: string | null;
    initialChannelId?: string;
    /** Durable metadata supplied by a nested project-session route. */
    initialHistorySession?: AgentSession | null;
    /** Restore via open vs openHistory. Absent on new drafts (nothing to restore). */
    restorePath?: 'open' | 'openHistory';
    /** Unique unsent-draft identity for composer persistence. */
    draftKey?: string | null;
    restoreScroll?: import('@hq/ui').NavigationScrollState | null;
  }

  let {
    sessionId,
    onopensession,
    onopenchannel,
    initialCompany = null,
    initialProject = null,
    initialChannelId,
    initialHistorySession = null,
    restorePath,
    draftKey = null,
    restoreScroll = null,
  }: Props = $props();

  let preflight = $state<Preflight | null>(null);
  let preflightLoading = $state(false);
  let actionError = $state('');
  let sessionUnavailable = $state(false);
  let starting = $state(false);
  let busyRequestId = $state<string | null>(null);
  let probeCommands = $state<SessionCommand[]>([]);
  let models = $state<SessionModel[]>([]);
  let drawerOpen = $state(false);
  /** Guards the once-per-page preflight. */
  let preflightRequested = $state(false);
  /** The tool the loaded catalog belongs to — the catalog is per CLI. */
  let catalogTool = $state<SessionToolId | null>(null);
  /**
   * The probe for `catalogTool` returned a real catalog. False while it is in
   * flight and after it failed — the fallback rows are a courtesy, not a list
   * a model can be validated against.
   */
  let catalogLoaded = $state(false);
  let modelsLoading = $state(false);
  let catalogRefresh = $state(0);
  let consumedCatalogRefresh = 0;
  /** The catalog probe's own complaint, e.g. Codex not being wired up yet. */
  let catalogError = $state('');
  let openedId = $state<string | null>(null);
  /** Last id observed from the route; distinct from a newly minted provisional id. */
  let routedId: string | null = null;

  // --- @mentions ------------------------------------------------------------
  /** Who the composer's `@` can offer: the company pill's people + agents. */
  let mentionCandidates = $state<MentionCandidate[]>([]);
  /** The company the candidate list belongs to. */
  let mentionCompany = $state<string | null>(null);
  /** What the composer footer says about the last mention DMs. */
  let mentionStatus = $state<{ text: string; error: boolean } | null>(null);

  // --- the composer's pills, remembered across restarts --------------------
  //
  // Model and effort are remembered PER TOOL. A model is only meaningful to
  // the CLI that offers it: one shared memory is how a Codex session's
  // `gpt-5.6-sol` came to be sent on every turn of the next Claude session,
  // each of which failed with `model_not_found`.
  const initialTool = readRememberedTool();
  let company = $state<string | null>(readRemembered(LAST_COMPANY_KEY));
  // The `sessions` route without an id IS the new-session route, and a new
  // session starts on "No project": forget the remembered project for the
  // remembered company before the project effect below reads it back. The
  // company itself stays — only the project resets.
  if (!sessionId) forgetLastProject(company);
  let tool = $state<SessionToolId>(initialTool);
  let model = $state<string | null>(readRememberedModel(initialTool));
  let effort = $state<string | null>(readRememberedEffort(initialTool));
  let permissionMode = $state<PermissionMode>('prompt');
  let companySeeded = $state(false);
  /** "Model reset to Default for Claude" — the composer's footer, until the next pick. */
  let modelNote = $state('');

  // --- company / project start-work -----------------------------------------
  /** The company pill's second level: a project NAME, or null for company mode. */
  let project = $state<string | null>(null);
  let projects = $state<ProjectEntry[]>([]);
  let projectsLoading = $state(false);
  let projectsError = $state('');
  /** The company the project list (and the remembered pick) belongs to. */
  let projectsCompany = $state<string | null | undefined>(undefined);
  /** Who is signed in — the project picker's "Mine" chip. Null until known. */
  let viewer = $state<ProjectViewer | null>(null);
  void liveSessionStore.hqSelf().then((who) => {
    viewer = who;
  });
  /** "Run /startwork on first message" — default on, remembered. */
  let startworkEnabled = $state(readStartworkEnabled());

  // --- a route-bound fresh chat (`new?company=…&project=…`) -------------------
  /** Applied once: the route's company wins over the remembered pill. */
  let routeApplied = $state(false);
  /** The route's project slug, resolved to a pill name once projects load. */
  let routeProjectPending = $state<string | null>(null);
  $effect(() => {
    if (routeApplied) return;
    routeApplied = true;
    if (initialCompany) {
      company = initialCompany;
      companySeeded = true;
    }
    routeProjectPending = initialCompany && initialProject ? initialProject : null;
  });
  $effect(() => {
    const slug = routeProjectPending;
    if (!slug || projectsLoading || projectsCompany !== company) return;
    routeProjectPending = null;
    // A project-channel route is authoritative even when its older PRD falls
    // outside the bounded project-picker feed. Keep the slug as the pill and
    // wire value instead of silently degrading the session to company-only.
    project = projectNameFor(projects, slug) ?? slug;
  });

  // --- the `/` picker's HQ catalog --------------------------------------------
  let catalog = $state<SkillCatalog | null>(null);
  let catalogLoading = $state(false);
  let skillCatalogError = $state('');
  let groupMetadataAvailable = $state(true);
  let catalogCompany = $state<string | null | undefined>(undefined);

  async function openRoutedSession(next: string) {
    if (routedId !== next) return;
    // Restore is open / openHistory only. Never start, send, or fork.

    // Project-channel links already carry the authoritative provider history
    // metadata. Open them immediately instead of blocking the transcript on
    // the slower global session catalogs, which briefly rendered a generic
    // blank session after every click or app restart.
    if (initialHistorySession?.id === next) {
      tool = initialHistorySession.tool;
      model = null;
      effort = null;
      company = initialHistorySession.company || null;
      remember(LAST_TOOL_KEY, tool);
      rememberModel(tool, null);
      rememberEffort(tool, null);
      await liveSessionStore.openHistory(initialHistorySession);
      return;
    }

    // Resolve the inexpensive in-memory registry first. A live session must
    // not wait for a scan of every provider transcript before replaying.
    if (restorePath !== 'openHistory') {
      await liveSessionStore.refreshList();
      if (routedId !== next) return;

      const appOwned = liveSessionStore.sessions.some((session) => session.sessionId === next);
      if (appOwned) {
        await liveSessionStore.open(next);
        return;
      }
    }
    await sessionsStore.refresh();
    if (routedId !== next) return;
    const providerHistory = sessionsStore.sessions.find((session) => session.id === next);
    if (providerHistory) {
      tool = providerHistory.tool;
      model = null;
      effort = null;
      company = providerHistory.company || null;
      remember(LAST_TOOL_KEY, tool);
      rememberModel(tool, null);
      rememberEffort(tool, null);
      await liveSessionStore.openHistory(providerHistory);
      return;
    }
    if (restorePath === 'open' || restorePath === 'openHistory') {
      sessionUnavailable = true;
      actionError = 'This session is no longer available.';
      return;
    }
    await liveSessionStore.open(next);
  }

  // Open the routed session. Background buffers stay resident while this view
  // unmounts so Back can restore without tearing the agent down.
  $effect(() => {
    const next = sessionId ?? null;
    if (next === routedId) return;
    routedId = next;
    openedId = next;
    sessionUnavailable = false;
    if (!next) return;
    if (liveSessionStore.isOpen(next)) {
      liveSessionStore.activate(next);
      return;
    }
    void openRoutedSession(next);
  });

  onDestroy(() => {
    routedId = null;
  });

  /** Preflight: wanted once per page, best-effort. */
  $effect(() => {
    if (preflightRequested) return;
    preflightRequested = true;
    preflightLoading = true;
    void liveSessionStore
      .preflight()
      .then((result) => {
        preflight = result;
      })
      .catch((err: unknown) => {
        actionError = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        preflightLoading = false;
      });
  });

  /**
   * The slash-command + model catalog, refetched whenever the tool pill moves:
   * Claude and Codex do not share a command list or a model list, and showing
   * one CLI's models while the other is selected would offer a model the
   * session could never start with.
   */
  $effect(() => {
    const wanted = tool;
    const refresh = catalogRefresh;
    const forceRefresh = refresh !== consumedCatalogRefresh;
    consumedCatalogRefresh = refresh;
    let cancelled = false;
    catalogTool = wanted;
    modelsLoading = true;
    catalogLoaded = false;
    catalogError = '';
    // Never leave the previous provider's selectable rows on screen while
    // the new CLI probe is pending (which can take several seconds).
    models = readSessionModels([], wanted);
    probeCommands = [];
    void liveSessionStore
      .slashCommands(wanted, forceRefresh)
      .then((catalog) => {
        // The pill may have moved again while this probe ran; a stale catalog
        // must not validate the new tool's model against the old tool's rows.
        if (cancelled) return;
        probeCommands = catalog.commands;
        const rows = readSessionModels(catalog.models, wanted);
        models = rows;
        const available = !isFallbackCatalog(rows, wanted);
        catalogLoaded = available;
        if (!available) catalogError = 'Live model list unavailable';
      })
      // A missing catalog costs autocomplete and a rich model list, never the
      // session — the composer falls back and still sends whatever was typed.
      // The backend's own words are kept: "In-app Codex sessions aren't
      // supported yet" is the useful half of this failure.
      .catch((err: unknown) => {
        if (cancelled) return;
        probeCommands = [];
        models = readSessionModels([], wanted);
        catalogLoaded = false;
        catalogError = err instanceof Error ? err.message : String(err);
      }).finally(() => {
        if (!cancelled) modelsLoading = false;
      });
    return () => { cancelled = true; };
  });

  /** The current tool's catalog is on screen and real. */
  const catalogReady = $derived(catalogTool === tool && catalogLoaded);
  /** The effort ladder the current tool takes — from its catalog when it says. */
  const effortOptions = $derived(effortOptionsFor(tool, catalogReady ? models : null));
  const toolLabel = $derived(
    TOOL_OPTIONS.find((option) => option.value === tool)?.label ?? 'Claude',
  );

  // Seed the company pill once the preflight names the choices: the remembered
  // one when it still exists, else the first offered.
  $effect(() => {
    if (companySeeded) return;
    const offered = preflight?.companies;
    if (!offered || offered.length === 0) return;
    companySeeded = true;
    const remembered = company;
    if (remembered && offered.some((option) => option.slug === remembered)) return;
    company = offered[0]?.slug ?? null;
  });

  /**
   * Drop the model pill's choice for one the current tool can run, and say so
   * in the footer when an actual choice was dropped (a seed from "nothing" to
   * the catalog's first row is not news). The dropped value is forgotten only
   * when it was the one remembered for this tool — a live session's own bad
   * model must not erase the operator's standing preference.
   */
  function resetModel(next: string | null) {
    const dropped = model;
    model = next;
    if (dropped === null) return;
    if (readRememberedModel(tool) === dropped) rememberModel(tool, next);
    const name = next === null ? 'Default' : modelPillLabel(models, next, null, tool);
    modelNote = `Model reset to ${name} for ${toolLabel}`;
  }

  /**
   * The model pill never holds a model the current tool cannot run.
   *
   * Before the tool's catalog lands, only the CLI's own aliases are trusted
   * (`opus`, `claude-*`; `gpt-*`). Once it has, the choice must be one of its
   * rows — the remembered one when still offered, else the catalog's first
   * (Default). A live session's own model is left alone as long as its CLI
   * could plausibly run it: the catalog is what the CLI *offers*, and an alias
   * like `opus` that a running session was launched with is not something to
   * reset out from under it.
   */
  $effect(() => {
    const current = model;
    const live = summary;
    const boundToLive =
      live !== null &&
      pillsBoundTo === live.sessionId &&
      live.tool === tool &&
      current === live.requestedModel;
    if (!catalogReady) {
      if (!plausibleModelForTool(current, tool)) resetModel(null);
      return;
    }
    if (models.length === 0) return;
    if (boundToLive && plausibleModelForTool(current, tool)) return;
    const picked = pickModel(models, current)?.value ?? null;
    if (picked !== current) resetModel(picked);
  });

  /** The effort pill only ever names a rung of the current ladder. */
  $effect(() => {
    const clamped = clampEffort(effort, effortOptions);
    if (clamped !== effort) effort = clamped;
  });

  /**
   * The synchronous form of the two effects above, run on the send path so a
   * send that lands between a tool switch and the effects' flush still
   * carries a valid model. Effects settle in a microtask; a click does not
   * wait for one.
   */
  function ensureModelValid(): void {
    const check = validateModel(model, tool, catalogReady ? models : null);
    if (check.reset) resetModel(null);
    const clamped = clampEffort(effort, effortOptions);
    if (clamped !== effort) effort = clamped;
  }

  /**
   * The mention directory follows the company pill. A failed load costs the
   * picker, never the session — the composer simply has nobody to offer.
   */
  $effect(() => {
    const wanted = company;
    if (mentionCompany === wanted) return;
    mentionCompany = wanted;
    mentionCandidates = [];
    if (!wanted) return;
    void loadMentionCandidates(wanted)
      .then((candidates) => {
        if (mentionCompany === wanted) mentionCandidates = candidates;
      })
      .catch((err: unknown) => {
        console.warn('sessions: mention candidates unavailable', err);
      });
  });

  /**
   * The project list follows the company pill, and so does the remembered
   * project: `hq.sessions.lastProject.<slug>` is restored the moment the
   * company lands, so a returning operator does not re-pick it. A failed load
   * costs the submenu, never the session.
   */
  $effect(() => {
    const wanted = company;
    if (projectsCompany === wanted) return;
    projectsCompany = wanted;
    projects = [];
    projectsError = '';
    project = readLastProject(wanted);
    if (!wanted) return;
    projectsLoading = true;
    void liveSessionStore
      .hqCompanyProjects(wanted)
      .then((rows) => {
        if (projectsCompany !== wanted) return;
        projects = rows;
        // A remembered project that no longer exists falls back to "No project".
        if (project && !rows.some((row) => row.name === project)) project = null;
      })
      .catch((err: unknown) => {
        if (projectsCompany !== wanted) return;
        projectsError = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        if (projectsCompany === wanted) projectsLoading = false;
      });
  });

  /** The HQ skill catalog, once per company (the store caches it). */
  $effect(() => {
    const wanted = company;
    const companyUid = preflight?.companies.find((entry) => entry.slug === wanted)?.cloudUid ?? null;
    const cacheKey = `${wanted ?? ''}:${companyUid ?? ''}`;
    if (catalogCompany === cacheKey) return;
    catalogCompany = cacheKey;
    skillCatalogError = '';
    groupMetadataAvailable = wanted === null || companyUid !== null;
    catalogLoading = true;
    void liveSessionStore
      .hqSkillCatalog(wanted)
      .then(async (result) => {
        if (catalogCompany !== cacheKey) return;
        catalog = result;
        if (!companyUid) return;
        try {
          const metadata = await liveSessionStore.hqSkillMetadata(companyUid);
          if (catalogCompany === cacheKey) {
            catalog = mergeSkillMetadata(result, metadata);
            groupMetadataAvailable = true;
          }
        } catch {
          if (catalogCompany === cacheKey) groupMetadataAvailable = false;
        }
      })
      .catch((err: unknown) => {
        if (catalogCompany !== cacheKey) return;
        catalog = null;
        skillCatalogError = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        if (catalogCompany === cacheKey) catalogLoading = false;
      });
  });

  /**
   * The store's fold guards every event and the store guards the fold; this
   * guards the READ, so nothing on the transcript path can throw through a
   * `$derived` into the shell's error boundary and blank the whole window.
   */
  const transcript = $derived.by((): TranscriptState => {
    try {
      return liveSessionStore.transcript;
    } catch (err) {
      console.error('[SessionsPage] transcript unavailable', err);
      return emptyTranscript();
    }
  });
  const phase = $derived(liveSessionStore.phase);
  const summary = $derived(liveSessionStore.summary);

  /** The live session's project link (channel + siblings), for the strip pill. */
  const projectLink = $derived(
    linkForSession(projectLinksStore.linksFor(summary?.company ?? company), summary?.sessionId, summary?.project ?? null, summary?.cliSessionId ?? summary?.resumedFrom),
  );

  /**
   * Opening an existing session binds the pills to THAT session once.
   *
   * Without this the pills would keep showing the remembered defaults, and the
   * composer would announce "next message starts a new session" on every
   * session the user merely opened — a warning about something they did not do.
   */
  let pillsBoundTo = $state<string | null>(null);
  /**
   * Set only when the user changes the COMPANY pill while a session is live.
   *
   * A company is what binds a session's context — its knowledge, its
   * credentials, its policies — so it is the one pill that cannot be rebound
   * on a running session, and the only one whose change forks the next send
   * into a new chat. Model, effort and permission mode all move in place:
   * Codex takes model and effort per `turn/start`, both CLIs take a
   * permission-mode change mid-session, and a user who picked a different
   * thinking mode asked for a different answer, not a different conversation.
   *
   * Comparing pill values against the live summary is still not a substitute
   * for the flag: the summary reports the model the CLI actually resolved
   * (e.g. "claude-opus-4-8") while the pill holds the catalog value
   * ("default"), so a value comparison reads every follow-up as a fork.
   */
  let pillsDirty = $state(false);
  $effect(() => {
    const live = summary;
    if (!live || live.sessionId !== sessionId || pillsBoundTo === live.sessionId) return;
    pillsBoundTo = live.sessionId;
    pillsDirty = false;
    companySeeded = true;
    company = live.company ?? null;
    permissionMode = live.permissionMode;
    tool = live.tool;
    // The pills describe the session on screen, not the last one started —
    // otherwise opening an old chat would report a model change the user never
    // made, and the very first follow-up would send an override for it.
    // `requestedModel` is the catalog value the operator chose; `model` is the
    // id the CLI resolved, and the strip is where that one belongs.
    model = live.requestedModel;
    effort = live.effort;
  });
  const commands = $derived(
    mergeSlashCommands(probeCommands, liveSessionStore.startedCommands),
  );

  /** The pills describe a different session than the live one — say so. */
  const newSessionPending = $derived(Boolean(sessionId) && pillsDirty);
  const orientationCommand = $derived(
    (!sessionId || newSessionPending) && startworkEnabled
      ? startworkCommand({ company, project })
      : null,
  );

  const companyLabel = $derived(
    preflight?.companies.find((option) => option.slug === company)?.displayName ??
      company ??
      'HQ',
  );

  const title = $derived(
    sessionId && summary
      ? summary.title || `${summary.company ?? 'No company'} · ${sessionModelName(summary)}`
      : sessionId
        ? 'Session'
        : 'New session',
  );

  const PHASE_LABEL: Record<string, string> = {
    starting: 'Starting',
    idle: 'Idle',
    working: 'Working',
    needsYou: 'Needs you',
    ended: 'Ended',
  };
  const phaseLabel = $derived(sessionId ? (PHASE_LABEL[phase] ?? '') : '');

  /**
   * The shimmering tail line. Chosen from what is already on screen: nothing
   * while text streams or a card waits (those ARE the activity), "Working…"
   * while a tool group is still running, "Starting session…" until the CLI has
   * announced itself, otherwise "Thinking…".
   */
  const workStatus = $derived.by((): '' | 'starting' | 'thinking' | 'tools' => {
    if (starting || (sessionId && phase === 'starting')) return 'starting';
    if (!sessionId || phase !== 'working') return '';
    const last = transcript.blocks[transcript.blocks.length - 1];
    if (!last) return 'thinking';
    if (last.type === 'assistantProse' && last.streaming) return '';
    if (last.type === 'toolGroup' && last.running) return 'tools';
    if (last.type === 'permissionCard' || last.type === 'questionCard') {
      return last.resolution === null ? '' : 'thinking';
    }
    return 'thinking';
  });

  const emptyHint = $derived(
    sessionId
      ? liveSessionStore.isHistorical
        ? 'This session ended before any visible messages were saved.'
        : ''
      : `Ask anything. Your first message starts a session in HQ for ${companyLabel}.`,
  );

  /**
   * The ONE blocking problem, with the exact fix. Each of these fails for a
   * different reason, so each gets its own remedy — a user told "run `claude
   * login` in a terminal" can act; one told "preflight failed" cannot.
   */
  const blocker = $derived.by(() => {
    if (preflightLoading || !preflight) return '';
    if (tool === 'codex' && !preflight.codexAvailable) {
      return 'Codex is not installed. Install it below — HQ sets up the CLI for you.';
    }
    if (tool === 'codex' && !preflight.codexLoggedIn) {
      return 'Codex is not signed in. Connect it below. If the browser does not open, run `codex login` in a terminal.';
    }
    if (tool === 'grok' && !preflight.grokAvailable) {
      return 'Grok is not installed. Install it below — HQ sets up the CLI for you.';
    }
    if (tool === 'grok' && !preflight.grokLoggedIn) {
      return 'Grok is not signed in. Connect it below. If the browser does not open, run `grok login` in a terminal.';
    }
    if (tool === 'claude' && !preflight.claudeAvailable) {
      return 'Claude Code is not installed. Install it below — HQ sets up the CLI for you.';
    }
    if (tool === 'claude' && !preflight.claudeLoggedIn) {
      return 'Claude Code is not signed in. Connect it below. If the browser does not open, run `claude login` in a terminal.';
    }
    if (!preflight.hooksReady) {
      return (
        preflight.hooksError ??
        'HQ session hooks are not ready, so a session would run unguarded.'
      );
    }
    return '';
  });

  const needsProvider = $derived(Boolean(preflight) && (
    tool === 'claude' ? !preflight?.claudeAvailable || !preflight?.claudeLoggedIn
    : tool === 'grok' ? !preflight?.grokAvailable || !preflight?.grokLoggedIn
    : !preflight?.codexAvailable || !preflight?.codexLoggedIn
  ));
  function providerConnected(provider: SessionToolId) {
    if (preflight) preflight = provider === 'claude'
      ? { ...preflight, claudeAvailable: true, claudeLoggedIn: true }
      : provider === 'grok'
        ? { ...preflight, grokAvailable: true, grokLoggedIn: true }
      : { ...preflight, codexAvailable: true, codexLoggedIn: true };
    liveSessionStore.invalidatePreflight();
    chooseTool(provider);
    catalogRefresh += 1;
  }
  const notice = $derived(needsProvider ? '' : blocker || actionError || liveSessionStore.error);
  const ended = $derived(phase === 'ended' || transcript.ended);
  const sendDisabled = $derived(!preflight || Boolean(blocker) || starting || ended);

  /**
   * "Hand off" is a `/handoff` turn the strip can send for you. It is offered
   * only on a live session that is idle — a handoff written mid-turn would
   * describe work that is still moving — and it shows as running from the
   * moment the turn is mirrored until the fold sees that turn end.
   */
  const handoffState = $derived.by((): HandoffState => {
    if (!sessionId || liveSessionStore.isHistorical) return 'hidden';
    if (transcript.handoff === 'running') return 'running';
    if (sendDisabled || phase !== 'idle') return 'disabled';
    return 'ready';
  });

  async function handleHandoff() {
    if (handoffState !== 'ready') return;
    actionError = '';
    try {
      await liveSessionStore.send(HANDOFF_COMMAND);
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * HQ's context-warning hook printed its AUTO-CHECKPOINT banner and no
   * `/checkpoint` has followed. Dismissal is keyed on the prompt COUNT, so a
   * later banner (the pre-compaction one) reopens the line after the first
   * was waved away.
   */
  let checkpointDismissedAt = $state(0);
  const checkpointDue = $derived(
    Boolean(sessionId) &&
      transcript.checkpointDue &&
      transcript.checkpointPrompts > checkpointDismissedAt,
  );

  async function handleCheckpoint() {
    if (sendDisabled) return;
    actionError = '';
    try {
      await liveSessionStore.send(CHECKPOINT_COMMAND);
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    }
  }

  function dismissCheckpoint() {
    checkpointDismissedAt = transcript.checkpointPrompts;
  }

  /**
   * The strip's "⋯" menu. "Open in …" and "End session" act at once (both
   * are local to this machine); "Share to channel…" only OPENS the dialog —
   * creating, inviting and posting wait for that dialog's own confirm.
   */
  let shareOpen = $state(false);
  let menuResult = $state('');
  let menuResultTimer: ReturnType<typeof setTimeout> | null = null;

  function flashMenuResult(text: string) {
    menuResult = text;
    if (menuResultTimer !== null) clearTimeout(menuResultTimer);
    menuResultTimer = setTimeout(() => {
      menuResult = '';
      menuResultTimer = null;
    }, 6000);
  }

  async function handleOpenInApp() {
    if (!sessionId) return;
    actionError = '';
    try {
      const outcome = await liveSessionStore.openInApp();
      flashMenuResult(outcome.opened === 'desktop' ? 'Opened in desktop app' : 'Opened in Terminal');
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    }
  }

  async function handleEndSession() {
    if (!sessionId) return;
    actionError = '';
    try {
      await liveSessionStore.end();
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    }
  }

  onDestroy(() => {
    if (menuResultTimer !== null) clearTimeout(menuResultTimer);
  });

  let pageEl = $state<HTMLDivElement | null>(null);
  /** The composer, so the transcript's "Choose a model" can open its menu. */
  let composer = $state<{ openModelMenu: () => void; reset: () => void } | null>(null);

  /**
   * ⌘⇧H hands off. The listener lives on the window only while this page is
   * mounted (the same pattern as the drawer's Escape), and a keystroke aimed at
   * some other surface — a palette, a dialog outside the page — is left alone.
   */
  function onPageKeydown(event: KeyboardEvent) {
    if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return;
    if (event.key.toLowerCase() !== 'h') return;
    const target = event.target;
    const insidePage =
      !(target instanceof Node) ||
      target === document.body ||
      (pageEl?.contains(target) ?? false);
    if (!insidePage) return;
    event.preventDefault();
    void handleHandoff();
  }

  const hqFolder = $derived(basename(preflight?.hqRoot ?? ''));
  // The session id, the token counts and the turn cost are deliberately NOT
  // rendered — the store still carries them (`transcript.lastUsage`), the
  // composer's footer just is not where telemetry belongs.

  /**
   * The model the live session is ACTUALLY running: what the CLI announced on
   * `started`, never what the pill asked for. The registry seeds its summary's
   * `model` from the spec until `started` lands, so before that the summary is
   * the pill in disguise — and a Claude CLI handed `gpt-5.6-sol` echoes it
   * back on `started` before rejecting it on every turn. A model the
   * session's own CLI could not run is therefore not "resolved" either; it is
   * null, and the strip names the tool instead.
   */
  const resolvedModel = $derived.by((): string | null => {
    const live = summary;
    if (!live) return null;
    const announced = liveSessionStore.startedModel ?? (live.phase === 'starting' ? null : live.model);
    if (!announced || !plausibleModelForTool(announced, live.tool)) return null;
    return announced;
  });

  function basename(path: string): string {
    if (!path) return '';
    const parts = path.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] ?? '';
  }

  /**
   * "claude-fable-5-1[1m]" is not a title. The strip names the session's model
   * exactly the way the composer's pill does — which for Codex means the
   * catalog's own display name ("GPT-5.6-Codex"), because its ids differ in
   * ways the friendly mapper flattens away.
   *
   * The catalog is only trusted when it belongs to the session's OWN CLI; a
   * Claude session read through Codex's model list would be named from a
   * table it is not in.
   */
  function sessionModelName(live: { tool: SessionToolId }): string {
    // `resolvedModel` is the `started` announcement, guarded against a model
    // the session's CLI could not run — never the pill.
    const resolved = resolvedModel;
    if (!resolved) {
      return TOOL_OPTIONS.find((option) => option.value === live.tool)?.label ?? 'default model';
    }
    const catalog = catalogTool === live.tool ? models : [];
    return (
      modelPillLabel(catalog, resolved, null, live.tool) ||
      friendlyModelName(resolved) ||
      'default model'
    );
  }

  const sharingChannelId = $derived(
    (company === initialCompany && projectSlugFor(projects, project) === initialProject ? initialChannelId : undefined)
      || linkForProject(projectLinksStore.linksFor(company), projectSlugFor(projects, project))?.channelId,
  );

  function specFrom(resume: string | null = null): SessionSpec {
    // A spec never carries a model the tool cannot run — validated here, on
    // the send path itself, not only by the effects that follow a pill move.
    ensureModelValid();
    return {
      // Empty id asks the backend to mint one; `cwd` is likewise the backend's
      // (it always runs from the HQ root) but the shape carries both.
      sessionId: '',
      title: null,
      tool,
      cwd: '',
      company,
      // The pill holds a prd NAME; the session binds to the directory slug.
      project: projectSlugFor(projects, project),
      // New project-bound drafts use that project's exact channel. Resuming
      // an old conversation never enrolls it retroactively.
      ...(!resume && sharingChannelId ? { projectChannelId: sharingChannelId } : {}),
      model,
      effort,
      resume,
      permissionMode,
    };
  }

  /**
   * The composer's model / effort pills, when they no longer match the live
   * session — the payload that moves them WITHOUT forking the chat. `null`
   * when nothing moved, so an ordinary follow-up sends no override at all.
   */
  const pendingOverrides = $derived.by((): TurnOverrides | null => {
    const live = summary;
    if (!live) return null;
    // `requestedModel` is what the operator asked for; `model` is what the CLI
    // resolved, and comparing against that would read every follow-up as a
    // change.
    if (model === live.requestedModel && effort === live.effort) return null;
    // Absolute, and never a model the live session's own CLI could not run.
    return {
      model: validateModel(model, live.tool, catalogReady && live.tool === tool ? models : null).model,
      effort: clampEffort(effort, effortOptionsFor(live.tool, live.tool === tool ? models : null)),
    };
  });

  /**
   * Claude runs one `--print` process per session and cannot be moved off the
   * model or the effort it was launched with, so its operator is told where
   * their choice actually lands. Codex takes both per turn, so it needs no
   * note.
   */
  const overridesDeferred = $derived(
    Boolean(sessionId) && summary?.tool === 'claude' && pendingOverrides !== null,
  );

  /**
   * Open / Share / Deploy on files a turn produced. Deploy is a user turn —
   * `/deploy <path>` — so the deploy skill does the work and prints the link.
   */
  const artifactActions = tauriArtifactActions((path) => void handleSend(deployCommandFor(path), []));

  /** What the mirrored bubble says rode along — the tags, never the block. */
  function contextTurnMeta(context: LoadedAttachment[]): UserTurnMeta {
    if (context.length === 0) return {};
    const root = preflight?.hqRoot ?? '';
    return {
      attachments: context.map(({ kind, title, path }) => ({
        kind,
        title,
        path: hqRelativePath(path, root),
      })),
    };
  }

  /**
   * The one send path. With no live session (or with a company pill that
   * describes a different one) the message STARTS the session it belongs to;
   * otherwise it joins the conversation already on screen, carrying whatever
   * the model and effort pills now say.
   *
   * Context chips ride the wire as `<hq-context>` blocks AFTER the words; the
   * mirrored turn carries only their tags. A first send is preceded by the
   * hidden `/startwork` orientation turn when the toggle allows it.
   */
  async function handleSend(
    text: string,
    images: ComposerImage[],
    mentions: Mention[] = [],
    context: LoadedAttachment[] = [],
  ) {
    if (sendDisabled) return;
    actionError = '';
    mentionStatus = null;
    const attachments = images.map(({ mediaType, base64 }) => ({ mediaType, base64 }));
    const wire = composeWithContext(text, context, preflight?.hqRoot ?? '');
    const meta = contextTurnMeta(context);

    if (sessionId && !newSessionPending && liveSessionStore.isHistorical) {
      starting = true;
      try {
        const started = await liveSessionStore.resumeAndSend(
          wire,
          attachments,
          permissionMode,
          meta,
        );
        openedId = started;
        onopensession?.(started);
        await onmentionsend(started, text, mentions);
      } catch (err) {
        actionError = err instanceof Error ? err.message : String(err);
      } finally {
        starting = false;
      }
      return;
    }

    if (sessionId && !newSessionPending) {
      // The pills are validated BEFORE the overrides are read off them.
      ensureModelValid();
      try {
        await liveSessionStore.send(wire, attachments, pendingOverrides, meta);
      } catch (err) {
        actionError = err instanceof Error ? err.message : String(err);
        return;
      }
      await onmentionsend(sessionId, text, mentions);
      return;
    }

    starting = true;
    let started: string | null = null;
    let messageAccepted = false;
    try {
      // Orientation, selected skill and natural-language prompt are one
      // atomic first message. The transcript splits context from the visible
      // prompt only as presentation; the CLI receives one send.
      const first = planFirstSend(wire, { company, project }, startworkEnabled)[0]!;
      const firstMeta: UserTurnMeta = first.label
        ? { ...meta, hidden: false, contextLabel: first.label, displayText: first.displayText }
        : meta;
      started = await liveSessionStore.startAndSend(
        specFrom(),
        first.text,
        attachments,
        firstMeta,
      );
      messageAccepted = true;
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      starting = false;
      // Once the backend creates a session, every retry belongs to it even if
      // orientation or the following send failed. Leaving the route as "new"
      // is what made a follow-up accidentally start another conversation.
      if (started) {
        openedId = started;
        onopensession?.(started, sessionId ? undefined : { replace: true });
      }
    }
    if (started && messageAccepted) await onmentionsend(started, text, mentions);
  }

  /**
   * The outward half of a mentioned send, run ONLY after the session accepted
   * the message: every recipient whose chip was still showing gets an HQ DM
   * with the text plus the session context line. A failed DM is reported in
   * the composer footer, per recipient; the session message already went.
   */
  async function onmentionsend(forSessionId: string, text: string, mentions: Mention[]) {
    if (mentions.length === 0 || !company) return;
    try {
      const deliveries = await notifyMentions({
        company,
        sessionId: forSessionId,
        recipients: mentions.map((mention) => mention.uid),
        text,
        tool: summary?.tool ?? tool,
      });
      mentionStatus = deliveryStatusLine(deliveries, mentions);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const names = mentions.map((mention) => mention.displayName).join(', ');
      mentionStatus = { text: `Couldn't DM ${names}: ${reason}`, error: true };
    }
  }

  async function handleOpenHistory(session: AgentSession) {
    if (starting) return false;
    actionError = '';
    try {
      // Selecting history is navigation, not execution. Hydrate the provider
      // transcript now and create a live resume process only on the first new
      // message the operator sends from it.
      const resumeCompany = session.company || null;
      tool = session.tool;
      model = null;
      effort = null;
      company = resumeCompany;
      remember(LAST_TOOL_KEY, tool);
      rememberModel(tool, null);
      rememberEffort(tool, null);
      await liveSessionStore.openHistory(session);
      openedId = session.id;
      onopensession?.(encodeHistorySessionParam(session));
      return true;
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  /** Run one decision, holding the card busy so it cannot double-fire. */
  async function decide(requestId: string, action: () => Promise<void>) {
    if (busyRequestId) return;
    busyRequestId = requestId;
    try {
      await action();
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      busyRequestId = null;
    }
  }

  /**
   * ONLY a company change forks the next send into a new session.
   *
   * A company binds the session's knowledge, credentials and policies, so it
   * cannot be rebound on a running child. Everything else — model, effort,
   * permission mode, and the tool that is implied by a company-less new chat —
   * moves in place. Selecting a new thinking mode must not start a new chat.
   */
  function markPillsDirty(changed: boolean) {
    if (changed && sessionId) pillsDirty = true;
  }

  function chooseCompany(slug: string | null) {
    markPillsDirty(slug !== company);
    company = slug;
    remember(LAST_COMPANY_KEY, slug);
  }

  /** The project only shapes the first send's orientation — it never forks. */
  function chooseProject(name: string | null) {
    project = name;
    rememberLastProject(company, name);
  }

  function toggleStartwork(enabled: boolean) {
    startworkEnabled = enabled;
    rememberStartworkEnabled(enabled);
  }

  function chooseModel(value: string | null) {
    modelNote = '';
    model = value;
    rememberModel(tool, value);
  }

  function chooseEffort(value: string | null) {
    effort = clampEffort(value, effortOptions);
    rememberEffort(tool, effort);
  }

  /**
   * The tool cannot change under a running child either — but unlike a
   * company, a tool change on a live session is a new chat by construction, so
   * it forks for the same reason — for the NEXT send, not by itself.
   *
   * The model and effort pills move WITH the tool, synchronously, before any
   * send can read them: each CLI has its own memory, and the other CLI's
   * choice is never carried across. Whatever this tool remembers is then
   * validated (aliases now, its catalog once that lands).
   */
  function chooseTool(next: SessionToolId) {
    markPillsDirty(next !== tool);
    if (next === tool) return;
    tool = next;
    remember(LAST_TOOL_KEY, next);
    modelNote = '';
    model = readRememberedModel(next);
    effort = readRememberedEffort(next);
    ensureModelValid();
  }

  /** The permission pill moves on the LIVE session; it never forks. */
  function choosePermission(mode: PermissionMode) {
    const changed = mode !== permissionMode;
    permissionMode = mode;
    if (!changed || !sessionId || liveSessionStore.isHistorical) return;
    void liveSessionStore.setPermissionMode(mode).catch((err: unknown) => {
      actionError = err instanceof Error ? err.message : String(err);
    });
  }
</script>

<svelte:window onkeydown={onPageKeydown} />

<div class="sessions" data-testid="sessions-page" bind:this={pageEl}>
  <SessionsStrip
    {title}
    startedBy={liveSessionStore.context?.startedBy}
    sourceTitle={liveSessionStore.context?.sourceTitle}
    sourceSessionId={liveSessionStore.context?.sourceSessionId}
    onopensource={() => {
      const sourceId = liveSessionStore.context?.sourceSessionId;
      const source = sessionsStore.sessions.find(item => item.id === sourceId);
      if (source) void handleOpenHistory(source);
      else if (sourceId) onopensession?.(sourceId);
    }}
    {phase}
    {phaseLabel}
    drawerOpen={drawerOpen}
    policies={sessionId ? transcript.policies : null}
    handoff={handoffState}
    ontoggledrawer={() => (drawerOpen = !drawerOpen)}
    onhandoff={() => void handleHandoff()}
    tool={summary?.tool ?? tool}
    menuEnabled={Boolean(sessionId) && !ended}
    {menuResult}
    projectLabel={sessionId ? (summary?.project ?? null) : null}
    projectLinked={Boolean(projectLink?.channelId)}
    onopenproject={() => {
      const channelId = projectLink?.channelId;
      if (channelId) onopenchannel?.(channelId);
    }}
    onopeninapp={() => void handleOpenInApp()}
    onshare={() => (shareOpen = true)}
    onend={() => void handleEndSession()}
  />

  {#if drawerOpen}
    <SessionListPanel
      activeSessionId={sessionId}
      onselect={(id) => onopensession?.(id)}
      onopen={handleOpenHistory}
      onclose={() => (drawerOpen = false)}
    />
  {/if}

  {#if shareOpen && sessionId}
    <ShareToChannelDialog
      {sessionId}
      company={summary?.company ?? company}
      onclose={() => (shareOpen = false)}
      onopenchannel={(channelId) => {
        shareOpen = false;
        onopenchannel?.(channelId);
      }}
    />
  {/if}

  {#if sessionUnavailable}
    <div
      class="session-note"
      data-testid="session-unavailable"
      role="alert"
    >
      This session is no longer available.
    </div>
  {/if}

  {#if liveSessionStore.truncated}
    <p class="session-note" data-testid="session-truncated">
      Older messages were dropped from this session's buffer.
    </p>
  {/if}

  {#if needsProvider && preflight}
    <div class="provider-connect-scroll">
      <ProviderConnect selected={tool}
        claudeAvailable={preflight.claudeAvailable} codexAvailable={preflight.codexAvailable} grokAvailable={preflight.grokAvailable}
        claudeConnected={preflight.claudeLoggedIn} codexConnected={preflight.codexLoggedIn} grokConnected={preflight.grokLoggedIn}
        onconnected={providerConnected} onchoose={chooseTool}
        onrefresh={async () => { liveSessionStore.invalidatePreflight(); preflight = await liveSessionStore.preflight(); }} />
    </div>
  {/if}
  <SessionTranscript
    restoreScroll={restoreScroll}
    blocks={transcript.blocks}
    status={workStatus}
    loading={Boolean(sessionId) && liveSessionStore.loading}
    hasEarlier={liveSessionStore.hasEarlier}
    loadingEarlier={liveSessionStore.loadingEarlier}
    onloadearlier={() => liveSessionStore.loadEarlier()}
    emptyHint={needsProvider ? '' : emptyHint}
    {busyRequestId}
    {artifactActions}
    onallowonce={(requestId) =>
      void decide(requestId, () =>
        liveSessionStore.respondPermission(requestId, { kind: 'allowOnce' }),
      )}
    onallowsession={(requestId) =>
      void decide(requestId, () =>
        liveSessionStore.respondPermission(requestId, { kind: 'allowSession' }),
      )}
    ondenypermission={(requestId, message) =>
      void decide(requestId, () =>
        liveSessionStore.respondPermission(requestId, { kind: 'deny', message }),
      )}
    onanswerquestion={(requestId, answers) =>
      void decide(requestId, () => liveSessionStore.answerQuestion(requestId, answers))}
    onchoosemodel={() => composer?.openModelMenu()}
  />

  {#if checkpointDue}
    <div class="checkpoint-notice" role="status" data-testid="session-checkpoint-notice">
      <span class="checkpoint-text">Context is filling up —</span>
      <button
        type="button"
        class="checkpoint-now"
        data-testid="session-checkpoint-now"
        disabled={sendDisabled}
        onclick={() => void handleCheckpoint()}
      >
        Checkpoint now
      </button>
      <button
        type="button"
        class="checkpoint-dismiss"
        aria-label="Dismiss"
        data-testid="session-checkpoint-dismiss"
        onclick={dismissCheckpoint}
      >
        ×
      </button>
    </div>
  {/if}

  <ProjectCreatedCard
    sessionId={sessionId ?? null}
    onopenchannel={(channelId) => onopenchannel?.(channelId)}
  />

  <div class="composer-dock">
    {#if liveSessionStore.sharingNotice}
      <div class="sharing-notice" role="status">{liveSessionStore.sharingNotice}</div>
    {:else if !sessionId && sharingChannelId}
      <div class="sharing-notice">New sessions here are shared read only with project chat members.</div>
    {/if}
    <SessionComposer
      bind:this={composer}
      autofocus
      {commands}
      {notice}
      working={phase === 'working'}
      disabled={sendDisabled}
      companies={preflight?.companies ?? []}
      {company}
      {project}
      {projects}
      {projectsLoading}
      {projectsError}
      {viewer}
      {startworkEnabled}
      {orientationCommand}
      {catalog}
      {catalogLoading}
      catalogError={skillCatalogError}
      {groupMetadataAvailable}
      context={liveSessionStore.contextLoaders}
      {models}
      {modelsLoading}
      modelsError={catalogError}
      onrefreshmodels={() => catalogRefresh += 1}
      {model}
      {resolvedModel}
      {effort}
      {effortOptions}
      {permissionMode}
      {tool}
      codexAvailable={preflight?.codexAvailable ?? false}
      grokAvailable={preflight?.grokAvailable ?? false}
      {newSessionPending}
      {modelNote}
      {hqFolder}
      {mentionCandidates}
      {mentionStatus}
      {draftKey}
      onsend={(text, images, mentions, context) => void handleSend(text, images, mentions, context)}
      onstop={() => void liveSessionStore.interrupt()}
      oncompany={chooseCompany}
      onproject={chooseProject}
      onstartworktoggle={toggleStartwork}
      onmodel={chooseModel}
      oneffort={chooseEffort}
      ontool={chooseTool}
      {overridesDeferred}
      onpermission={choosePermission}
    />
  </div>
</div>

<style>
  .provider-connect-scroll { min-height: 0; overflow-y: auto; flex: 0 1 auto; }
  .sessions {
    --session-column-width: 760px;
    --session-gutter: clamp(12px, 2vw, 24px);
    container-type: inline-size;
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
    height: 100%;
    font-family: var(--font-sans);
  }

  .composer-dock {
    flex: none;
    min-width: 0;
    padding: var(--v4-space-2) var(--session-gutter) var(--v4-space-3);
  }

  .session-note {
    flex: none;
    margin: 0;
    padding: var(--v4-space-2) var(--v4-space-4) 0;
    font-size: var(--type-metadata);
    color: var(--v4-text-3);
  }

  /* One quiet line above the composer, aligned to its column. */
  .sharing-notice { padding: 8px 12px; font-size: 13px; color: var(--session-muted, #999); }
  .checkpoint-notice {
    display: flex;
    align-items: center;
    gap: var(--v4-space-2);
    flex: none;
    box-sizing: border-box;
    width: 100%;
    max-width: calc(var(--session-column-width) + 2 * var(--session-gutter));
    margin: 0 auto;
    padding: var(--v4-space-2) var(--v4-space-4) 0;
    font-size: var(--type-metadata);
    color: var(--v4-text-2);
  }

  .checkpoint-now {
    height: 22px;
    padding: 0 8px;
    border: 1px solid var(--v4-hairline);
    border-radius: var(--v4-radius-pill, 999px);
    background: transparent;
    color: var(--v4-text-1);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .checkpoint-now:hover:not(:disabled) {
    background: var(--v4-active-row);
  }

  .checkpoint-now:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .checkpoint-dismiss {
    margin-left: auto;
    width: 22px;
    height: 22px;
    border: 0;
    border-radius: var(--v4-radius-button);
    background: transparent;
    color: var(--v4-text-3);
    font-family: inherit;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }

  .checkpoint-dismiss:hover {
    color: var(--v4-text-1);
    background: var(--v4-active-row);
  }
</style>

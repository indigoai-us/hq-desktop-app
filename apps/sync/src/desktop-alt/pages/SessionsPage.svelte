<script lang="ts">
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
   *   3. `agent_session_send` delivers the text,
   *   4. `onopensession(id)` moves the route.
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
  import { mergeSlashCommands } from '../../components/sessions/slash-commands';
  import {
    deployCommandFor,
    tauriArtifactActions,
  } from '../../components/sessions/session-artifacts';
  import type { SessionCommand } from '../../components/sessions/session-events';
  import {
    EFFORT_OPTIONS,
    LAST_COMPANY_KEY,
    LAST_EFFORT_KEY,
    LAST_MODEL_KEY,
    LAST_TOOL_KEY,
    friendlyModelName,
    modelPillLabel,
    pickModel,
    readRemembered,
    readRememberedTool,
    readSessionModels,
    remember,
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
  import '../../components/sessions/sessions-tokens.css';

  interface Props {
    /** Route-selected session. Absent → a fresh chat that starts on first send. */
    sessionId?: string;
    /** Navigate to `sessions:<id>` (the page never touches the router itself). */
    onopensession?: (sessionId: string) => void;
  }

  let { sessionId, onopensession }: Props = $props();

  let preflight = $state<Preflight | null>(null);
  let preflightLoading = $state(false);
  let actionError = $state('');
  let starting = $state(false);
  let busyRequestId = $state<string | null>(null);
  let probeCommands = $state<SessionCommand[]>([]);
  let models = $state<SessionModel[]>([]);
  let drawerOpen = $state(false);
  /** Guards the once-per-page preflight. */
  let preflightRequested = $state(false);
  /** The tool the loaded catalog belongs to — the catalog is per CLI. */
  let catalogTool = $state<SessionToolId | null>(null);
  /** The catalog probe's own complaint, e.g. Codex not being wired up yet. */
  let catalogError = $state('');
  let openedId = $state<string | null>(null);

  // --- @mentions ------------------------------------------------------------
  /** Who the composer's `@` can offer: the company pill's people + agents. */
  let mentionCandidates = $state<MentionCandidate[]>([]);
  /** The company the candidate list belongs to. */
  let mentionCompany = $state<string | null>(null);
  /** What the composer footer says about the last mention DMs. */
  let mentionStatus = $state<{ text: string; error: boolean } | null>(null);

  // --- the composer's pills, remembered across restarts --------------------
  let company = $state<string | null>(readRemembered(LAST_COMPANY_KEY));
  let model = $state<string | null>(readRemembered(LAST_MODEL_KEY));
  let effort = $state<string | null>(readRemembered(LAST_EFFORT_KEY));
  let permissionMode = $state<PermissionMode>('prompt');
  let tool = $state<SessionToolId>(readRememberedTool());
  let companySeeded = $state(false);
  let modelSeeded = $state(false);

  // Open / close the routed session. Runs on mount and whenever the route's id
  // changes; the previous session's buffer is dropped so a long transcript does
  // not sit in memory behind a session the user left.
  $effect(() => {
    const next = sessionId ?? null;
    if (next === openedId) return;
    const previous = openedId;
    openedId = next;
    if (previous) liveSessionStore.close(previous);
    if (next) void liveSessionStore.open(next);
  });

  onDestroy(() => {
    if (openedId) liveSessionStore.close(openedId);
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
    if (catalogTool === wanted) return;
    catalogTool = wanted;
    catalogError = '';
    void liveSessionStore
      .slashCommands(wanted)
      .then((catalog) => {
        probeCommands = catalog.commands;
        models = readSessionModels(catalog.models);
        modelSeeded = false;
      })
      // A missing catalog costs autocomplete and a rich model list, never the
      // session — the composer falls back and still sends whatever was typed.
      // The backend's own words are kept: "In-app Codex sessions aren't
      // supported yet" is the useful half of this failure.
      .catch((err: unknown) => {
        probeCommands = [];
        models = readSessionModels([]);
        modelSeeded = false;
        catalogError = err instanceof Error ? err.message : String(err);
      });
  });

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

  // Same for the model pill, once the catalog has landed.
  $effect(() => {
    if (modelSeeded) return;
    if (models.length === 0) return;
    modelSeeded = true;
    model = pickModel(models, model)?.value ?? null;
  });

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

  const transcript = $derived(liveSessionStore.transcript);
  const phase = $derived(liveSessionStore.phase);
  const summary = $derived(liveSessionStore.summary);

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
    if (!live || pillsBoundTo === live.sessionId) return;
    pillsBoundTo = live.sessionId;
    pillsDirty = false;
    companySeeded = true;
    modelSeeded = true;
    company = live.company ?? null;
    permissionMode = live.permissionMode;
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

  const companyLabel = $derived(
    preflight?.companies.find((option) => option.slug === company)?.displayName ??
      company ??
      'HQ',
  );

  const title = $derived(
    sessionId && summary
      ? `${summary.company ?? 'No company'} · ${sessionModelName(summary)}`
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
      ? ''
      : `Ask anything. Your first message starts a session in HQ for ${companyLabel}.`,
  );

  /**
   * The ONE blocking problem, with the exact fix. Each of these fails for a
   * different reason, so each gets its own remedy — a user told "run `claude
   * login` in a terminal" can act; one told "preflight failed" cannot.
   */
  const blocker = $derived.by(() => {
    if (preflightLoading || !preflight) return '';
    if (!preflight.claudeAvailable) {
      return 'Claude Code is not installed on this machine. Install it, then reopen Sessions.';
    }
    if (!preflight.claudeLoggedIn) {
      return 'Claude Code is not signed in. Run `claude login` in a terminal, then reopen Sessions.';
    }
    if (!preflight.hooksReady) {
      return (
        preflight.hooksError ??
        'HQ session hooks are not ready, so a session would run unguarded.'
      );
    }
    return '';
  });

  const notice = $derived(blocker || actionError || catalogError || liveSessionStore.error);
  const ended = $derived(phase === 'ended' || transcript.ended);
  const sendDisabled = $derived(Boolean(blocker) || starting || ended);

  const hqFolder = $derived(basename(preflight?.hqRoot ?? ''));
  // The session id, the token counts and the turn cost are deliberately NOT
  // rendered — the store still carries them (`transcript.lastUsage`), the
  // composer's footer just is not where telemetry belongs.
  const resolvedModel = $derived(summary?.model ?? null);

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
  function sessionModelName(live: { model: string | null; tool: SessionToolId }): string {
    if (!live.model) return 'default model';
    const catalog = catalogTool === live.tool ? models : [];
    return (
      modelPillLabel(catalog, live.model, null, live.tool) ||
      friendlyModelName(live.model) ||
      'default model'
    );
  }

  function specFrom(resume: string | null = null): SessionSpec {
    return {
      // Empty id asks the backend to mint one; `cwd` is likewise the backend's
      // (it always runs from the HQ root) but the shape carries both.
      sessionId: '',
      tool,
      cwd: '',
      company,
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
    return { model, effort };
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

  /**
   * The one send path. With no live session (or with a company pill that
   * describes a different one) the message STARTS the session it belongs to;
   * otherwise it joins the conversation already on screen, carrying whatever
   * the model and effort pills now say.
   */
  async function handleSend(text: string, images: ComposerImage[], mentions: Mention[] = []) {
    if (sendDisabled) return;
    actionError = '';
    mentionStatus = null;
    const attachments = images.map(({ mediaType, base64 }) => ({ mediaType, base64 }));

    if (sessionId && !newSessionPending) {
      try {
        await liveSessionStore.send(text, attachments, pendingOverrides);
      } catch (err) {
        actionError = err instanceof Error ? err.message : String(err);
        return;
      }
      await onmentionsend(sessionId, text, mentions);
      return;
    }

    starting = true;
    let started: string | null = null;
    try {
      started = await liveSessionStore.startAndSend(specFrom(), text, attachments);
      openedId = started;
      onopensession?.(started);
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      starting = false;
    }
    if (started) await onmentionsend(started, text, mentions);
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

  async function handleResume(session: AgentSession) {
    if (starting) return;
    starting = true;
    actionError = '';
    try {
      const started = await liveSessionStore.start({
        ...specFrom(session.id),
        company: session.company || company,
      });
      openedId = started;
      onopensession?.(started);
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      starting = false;
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

  function chooseModel(value: string | null) {
    model = value;
    remember(LAST_MODEL_KEY, value);
  }

  function chooseEffort(value: string | null) {
    effort = EFFORT_OPTIONS.some((option) => option.value === value) ? value : null;
    remember(LAST_EFFORT_KEY, effort);
  }

  /**
   * The tool cannot change under a running child either — but unlike a
   * company, a tool change on a live session is a new chat by construction, so
   * it forks for the same reason.
   */
  function chooseTool(next: SessionToolId) {
    markPillsDirty(next !== tool);
    tool = next;
    remember(LAST_TOOL_KEY, next);
  }

  /** The permission pill moves on the LIVE session; it never forks. */
  function choosePermission(mode: PermissionMode) {
    const changed = mode !== permissionMode;
    permissionMode = mode;
    if (!changed || !sessionId) return;
    void liveSessionStore.setPermissionMode(mode).catch((err: unknown) => {
      actionError = err instanceof Error ? err.message : String(err);
    });
  }
</script>

<div class="sessions" data-testid="sessions-page">
  <SessionsStrip
    {title}
    {phase}
    {phaseLabel}
    drawerOpen={drawerOpen}
    ontoggledrawer={() => (drawerOpen = !drawerOpen)}
    onnew={() => {
      drawerOpen = false;
      onopensession?.('');
    }}
  />

  {#if drawerOpen}
    <SessionListPanel
      activeSessionId={sessionId}
      onselect={(id) => onopensession?.(id)}
      onresume={handleResume}
      onclose={() => (drawerOpen = false)}
    />
  {/if}

  {#if liveSessionStore.truncated}
    <p class="session-note" data-testid="session-truncated">
      Older messages were dropped from this session's buffer.
    </p>
  {/if}

  <SessionTranscript
    blocks={transcript.blocks}
    status={workStatus}
    loading={Boolean(sessionId) && liveSessionStore.loading}
    {emptyHint}
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
  />

  <div class="composer-dock">
    <SessionComposer
      autofocus
      {commands}
      {notice}
      working={phase === 'working'}
      disabled={sendDisabled}
      companies={preflight?.companies ?? []}
      {company}
      {models}
      {model}
      {resolvedModel}
      {effort}
      {permissionMode}
      {tool}
      codexAvailable={preflight?.codexAvailable ?? false}
      {newSessionPending}
      {hqFolder}
      {mentionCandidates}
      {mentionStatus}
      onsend={(text, images, mentions) => void handleSend(text, images, mentions)}
      onstop={() => void liveSessionStore.interrupt()}
      oncompany={chooseCompany}
      onmodel={chooseModel}
      oneffort={chooseEffort}
      ontool={chooseTool}
      {overridesDeferred}
      onpermission={choosePermission}
    />
  </div>
</div>

<style>
  .sessions {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    height: 100%;
    font-family: var(--font-sans);
  }

  .composer-dock {
    flex: none;
    padding: var(--v4-space-2) var(--v4-space-4) var(--v4-space-3);
  }

  .session-note {
    flex: none;
    margin: 0;
    padding: var(--v4-space-2) var(--v4-space-4) 0;
    font-size: var(--type-metadata);
    color: var(--v4-text-3);
  }
</style>

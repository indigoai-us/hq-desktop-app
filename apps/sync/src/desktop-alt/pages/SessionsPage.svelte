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
  import { mergeSlashCommands } from '../../components/sessions/slash-commands';
  import type { SessionCommand } from '../../components/sessions/session-events';
  import {
    EFFORT_OPTIONS,
    LAST_COMPANY_KEY,
    LAST_EFFORT_KEY,
    LAST_MODEL_KEY,
    pickModel,
    readRemembered,
    readSessionModels,
    remember,
    type ComposerImage,
    type SessionModel,
  } from '../../components/sessions/session-models';
  import {
    liveSessionStore,
    type PermissionMode,
    type Preflight,
    type SessionSpec,
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
  /** Guards the once-per-page catalog fetch. */
  let catalogRequested = $state(false);
  let openedId = $state<string | null>(null);

  // --- the composer's pills, remembered across restarts --------------------
  let company = $state<string | null>(readRemembered(LAST_COMPANY_KEY));
  let model = $state<string | null>(readRemembered(LAST_MODEL_KEY));
  let effort = $state<string | null>(readRemembered(LAST_EFFORT_KEY));
  let permissionMode = $state<PermissionMode>('prompt');
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

  /** Preflight + the CLI catalog: both wanted once per page, both best-effort. */
  $effect(() => {
    if (catalogRequested) return;
    catalogRequested = true;
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
    void liveSessionStore
      .slashCommands('claude')
      .then((catalog) => {
        probeCommands = catalog.commands;
        models = readSessionModels(catalog.models);
      })
      // A missing catalog costs autocomplete and a rich model list, never the
      // session — the composer falls back and still sends whatever was typed.
      .catch(() => {
        models = readSessionModels([]);
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
   * Set only when the user CHANGES a pill while a session is live. Comparing
   * pill values against the live summary is not a substitute: the summary
   * reports the model the CLI actually resolved (e.g. "claude-opus-4-8") while
   * the pill holds the catalog value ("default"), so a value comparison reads
   * every follow-up as "a different session" and forks the chat on each send.
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
    // The model pill keeps the user's catalog choice; the strip title shows
    // the model the session actually resolved.
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
      ? `${summary.company ?? 'No company'} · ${shortModel(summary.model)}`
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

  const notice = $derived(blocker || actionError || liveSessionStore.error);
  const ended = $derived(phase === 'ended' || transcript.ended);
  const sendDisabled = $derived(Boolean(blocker) || starting || ended);

  const hqFolder = $derived(basename(preflight?.hqRoot ?? ''));
  const sessionShort = $derived(sessionId ? sessionId.slice(0, 8) : '');
  const usageLabel = $derived(transcript.lastUsage?.label ?? '');

  function basename(path: string): string {
    if (!path) return '';
    const parts = path.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] ?? '';
  }

  /** "claude-fable-5-1[1m]" is not a title. Prefer the catalog's own label. */
  function shortModel(value: string | null): string {
    if (!value) return 'default model';
    return models.find((entry) => entry.value === value)?.label ?? value;
  }

  function specFrom(resume: string | null = null): SessionSpec {
    return {
      // Empty id asks the backend to mint one; `cwd` is likewise the backend's
      // (it always runs from the HQ root) but the shape carries both.
      sessionId: '',
      tool: 'claude',
      cwd: '',
      company,
      model,
      effort,
      resume,
      permissionMode,
    };
  }

  /**
   * The one send path. With no live session (or with pills that describe a
   * different one) the message STARTS the session it belongs to; otherwise it
   * joins the conversation already on screen.
   */
  async function handleSend(text: string, images: ComposerImage[]) {
    if (sendDisabled) return;
    actionError = '';
    const attachments = images.map(({ mediaType, base64 }) => ({ mediaType, base64 }));

    if (sessionId && !newSessionPending) {
      try {
        await liveSessionStore.send(text, attachments);
      } catch (err) {
        actionError = err instanceof Error ? err.message : String(err);
      }
      return;
    }

    starting = true;
    try {
      const started = await liveSessionStore.startAndSend(specFrom(), text, attachments);
      openedId = started;
      onopensession?.(started);
    } catch (err) {
      actionError = err instanceof Error ? err.message : String(err);
    } finally {
      starting = false;
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

  /** A pill changed by the user while a session is live forks the next send. */
  function markPillsDirty(changed: boolean) {
    if (changed && sessionId) pillsDirty = true;
  }

  function chooseCompany(slug: string | null) {
    markPillsDirty(slug !== company);
    company = slug;
    remember(LAST_COMPANY_KEY, slug);
  }

  function chooseModel(value: string | null) {
    markPillsDirty(value !== model);
    model = value;
    remember(LAST_MODEL_KEY, value);
  }

  function chooseEffort(value: string | null) {
    const next = EFFORT_OPTIONS.some((option) => option.value === value) ? value : null;
    markPillsDirty(next !== effort);
    effort = next;
    remember(LAST_EFFORT_KEY, effort);
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
      {effort}
      {permissionMode}
      {newSessionPending}
      {hqFolder}
      {sessionShort}
      {usageLabel}
      onsend={(text, images) => void handleSend(text, images)}
      onstop={() => void liveSessionStore.interrupt()}
      oncompany={chooseCompany}
      onmodel={chooseModel}
      oneffort={chooseEffort}
      onpermission={(mode) => {
        markPillsDirty(mode !== permissionMode);
        permissionMode = mode;
      }}
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

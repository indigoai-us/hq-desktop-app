<script lang="ts">
  /**
   * Sessions — drive a Claude Code session inside the app.
   *
   * Three panes:
   *   left   `SessionListPanel`  live in-app sessions + observed history
   *   centre `SessionTranscript` the folded stream + the cards it is blocked on
   *   bottom `SessionComposer`   the prompt box, Stop, and `/` autocomplete
   * With no session selected the centre shows `NewSessionPanel` (preflight +
   * company / permission / model) instead — the empty state IS the start form,
   * because "no session" and "start one" are the same moment.
   *
   * This page is the ONLY place the live-session store is driven from: the
   * panels read it, the cards call back into it, and every `agent_session_*`
   * invoke lives inside it.
   */
  import { onDestroy } from 'svelte';
  import SessionListPanel from '../panels/SessionListPanel.svelte';
  import NewSessionPanel from '../../components/sessions/NewSessionPanel.svelte';
  import SessionComposer from '../../components/sessions/SessionComposer.svelte';
  import SessionTranscript from '../../components/sessions/SessionTranscript.svelte';
  import { mergeSlashCommands } from '../../components/sessions/slash-commands';
  import type { SessionCommand } from '../../components/sessions/session-events';
  import {
    liveSessionStore,
    type Preflight,
    type SessionSpec,
  } from '../lib/live-session-store.svelte';
  import type { AgentSession } from '../lib/sessions';
  import '../../components/sessions/sessions-tokens.css';

  interface Props {
    /** Route-selected session. Absent → the new-session surface. */
    sessionId?: string;
    /** Navigate to `sessions:<id>` (the page never touches the router itself). */
    onopensession?: (sessionId: string) => void;
  }

  let { sessionId, onopensession }: Props = $props();

  let preflight = $state<Preflight | null>(null);
  let preflightLoading = $state(false);
  let startError = $state('');
  let starting = $state(false);
  let busyRequestId = $state<string | null>(null);
  let probeCommands = $state<SessionCommand[]>([]);
  let models = $state<string[]>([]);
  /** Guards the once-per-page catalog fetch. */
  let catalogRequested = $state(false);
  let openedId = $state<string | null>(null);

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
        startError = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        preflightLoading = false;
      });
    void liveSessionStore
      .slashCommands('claude')
      .then((catalog) => {
        probeCommands = catalog.commands;
        models = readModelIds(catalog.models);
      })
      // A missing catalog costs autocomplete, never the session — the composer
      // still sends whatever the user typed.
      .catch(() => undefined);
  });

  /**
   * The CLI's model list is free-form JSON. Take the string id off whatever
   * shape it arrives in, and drop anything unrecognisable rather than
   * rendering `[object Object]` into a picker.
   */
  function readModelIds(raw: unknown[]): string[] {
    const ids: string[] = [];
    for (const entry of raw) {
      if (typeof entry === 'string') {
        ids.push(entry);
        continue;
      }
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        for (const key of ['id', 'model', 'name', 'value']) {
          const value = record[key];
          if (typeof value === 'string' && value.length > 0) {
            ids.push(value);
            break;
          }
        }
      }
    }
    return [...new Set(ids)];
  }

  const transcript = $derived(liveSessionStore.transcript);
  const phase = $derived(liveSessionStore.phase);
  const summary = $derived(liveSessionStore.summary);
  const commands = $derived(
    mergeSlashCommands(probeCommands, liveSessionStore.startedCommands),
  );
  const title = $derived(
    summary
      ? `${summary.company ?? 'No company'} · ${summary.model ?? 'default model'}`
      : 'Session',
  );
  const subtitle = $derived(summary?.cwd ?? preflight?.hqRoot ?? '');
  const screenState = $derived(
    liveSessionStore.loading
      ? ('skeleton' as const)
      : transcript.messages.length === 0 && transcript.activity.length === 0
        ? ('empty' as const)
        : ('loaded' as const),
  );

  function specFor(choice: {
    company: string | null;
    model: string | null;
    permissionMode: 'prompt' | 'bypassAll';
    resume?: string | null;
  }): SessionSpec {
    return {
      // Empty id asks the backend to mint one; `cwd` is likewise the backend's
      // (it always runs from the HQ root) but the shape carries both.
      sessionId: '',
      tool: 'claude',
      cwd: '',
      company: choice.company,
      model: choice.model,
      effort: null,
      resume: choice.resume ?? null,
      permissionMode: choice.permissionMode,
    };
  }

  async function startSession(spec: SessionSpec) {
    if (starting) return;
    starting = true;
    startError = '';
    try {
      const started = await liveSessionStore.start(spec);
      openedId = started;
      onopensession?.(started);
    } catch (err) {
      startError = err instanceof Error ? err.message : String(err);
    } finally {
      starting = false;
    }
  }

  function handleResume(session: AgentSession) {
    void startSession(
      specFor({
        company: session.company || null,
        model: session.model || null,
        permissionMode: 'prompt',
        resume: session.id,
      }),
    );
  }

  /** Run one decision, holding the card busy so it cannot double-fire. */
  async function decide(requestId: string, action: () => Promise<void>) {
    if (busyRequestId) return;
    busyRequestId = requestId;
    try {
      await action();
    } catch (err) {
      startError = err instanceof Error ? err.message : String(err);
    } finally {
      busyRequestId = null;
    }
  }
</script>

<div class="sessions" data-testid="sessions-page">
  <SessionListPanel
    activeSessionId={sessionId}
    onselect={(id) => onopensession?.(id)}
    onnew={() => onopensession?.('')}
    onresume={handleResume}
  />

  <div class="sessions-main">
    {#if !sessionId}
      <div class="sessions-empty" data-testid="sessions-empty">
        <NewSessionPanel
          {preflight}
          loading={preflightLoading}
          error={startError}
          {models}
          {starting}
          onstart={(choice) => void startSession(specFor(choice))}
        />
      </div>
    {:else}
      {#if liveSessionStore.error}
        <p class="session-error" role="alert" data-testid="session-error">
          {liveSessionStore.error}
        </p>
      {/if}
      {#if liveSessionStore.truncated}
        <p class="session-note" data-testid="session-truncated">
          Older events were dropped from this session's buffer — the transcript
          above starts partway through.
        </p>
      {/if}

      <SessionTranscript
        sessionTitle={title}
        sessionSubtitle={subtitle}
        messages={transcript.messages}
        activity={transcript.activity}
        pending={transcript.pending}
        state={screenState}
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
          void decide(requestId, () =>
            liveSessionStore.answerQuestion(requestId, answers),
          )}
      />

      <div class="sessions-composer">
        <SessionComposer
          {commands}
          working={phase === 'working'}
          disabled={phase === 'ended'}
          onsend={(text) => void liveSessionStore.send(text)}
          onstop={() => void liveSessionStore.interrupt()}
        />
      </div>
    {/if}
  </div>
</div>

<style>
  .sessions {
    display: grid;
    grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
    flex: 1;
    min-height: 0;
    height: 100%;
    font-family: var(--font-sans);
  }

  .sessions-main {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .sessions-empty {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .sessions-composer {
    flex: none;
    padding: var(--v4-space-2) var(--v4-space-4) var(--v4-space-3);
  }

  .session-error,
  .session-note {
    flex: none;
    margin: 0;
    padding: var(--v4-space-2) var(--v4-space-4);
    font-size: var(--type-metadata);
    color: var(--v4-text-3);
  }

  .session-error {
    color: var(--v4-error, var(--v4-text-2));
  }
</style>

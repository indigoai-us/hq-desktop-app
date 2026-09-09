// The host half of #welcome's native setup run.
//
// `packages/ui` draws the stepper and the question cards; this module gives it
// the engine. It is a thin adapter over `liveSessionStore`: the same
// preflight the Sessions page gates on, the same `agent_session_start` +
// `agent_session_send` a "Run Setup" draft would have done, the same
// `answerQuestion` / `respondPermission` / `send` the transcript's cards call.
// Nothing here speaks to Tauri directly.
//
// One session at a time is watched, by id — never "the active session" — so
// a person who opens "Show details" and then browses another session on the
// Sessions page does not have the card start narrating that one instead.

import type { SetupProviderStatus, SetupRunAnswer, SetupRunApi, SetupRunPermissionDecision, SetupRunReadiness, SetupRunSnapshot, SetupSecretCard } from '@hq/ui';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import { CLAUDE_INSTALL_URL, CODEX_INSTALL_URL } from '../../lib/onboarding-summary';
import { invoke } from '@tauri-apps/api/core';
import {
  liveSessionStore,
  type Preflight,
  type SessionSpec,
  type SessionTool,
} from './live-session-store.svelte';

/** The slash command the run sends; must be in the CLI's catalog to be runnable. */
const SETUP_COMMAND = 'setup';

/**
 * Which CLI can run setup here, or null when the Sessions page's Connect /
 * self-heal UI must go first. Claude is preferred (the /setup skill is a
 * Claude project skill first); Codex is the fallback when only it is signed in.
 */
export function setupRunTool(preflight: Preflight): SessionTool | null {
  const hqReady = preflight.hqSetup ? preflight.hqSetup === 'ready' : preflight.hooksReady;
  if (!hqReady) return null;
  if (preflight.claudeAvailable && preflight.claudeLoggedIn) return 'claude';
  if (preflight.codexAvailable && preflight.codexLoggedIn) return 'codex';
  return null;
}

export interface SetupRunHostOptions {
  /** Injected for tests; defaults to the singleton store. */
  store?: typeof liveSessionStore;
  /** Injected for tests; defaults to Tauri's invoke. */
  invoke?: typeof invoke;
}

export function createSetupRunApi(options: SetupRunHostOptions = {}): SetupRunApi {
  const store = options.store ?? liveSessionStore;
  let tool: SessionTool = 'claude';

  async function preflight(): Promise<SetupRunReadiness> {
    let result: Preflight;
    try {
      result = await store.preflight();
    } catch {
      return 'needs-sessions-page';
    }
    const candidate = setupRunTool(result);
    if (!candidate) return 'needs-sessions-page';
    // `/setup` missing from the CLI's own catalog means HQ's skills are not
    // where the CLI reads them — the Sessions page's repair offer handles it.
    // A probe that fails or times out proves nothing about the skills, and
    // preflight already vouched for the HQ layer: run natively rather than
    // bouncing the person to a page where the same probe would fail again.
    try {
      const catalog = await store.slashCommands(candidate);
      if (!catalog.commands.some((command) => command.name === SETUP_COMMAND)) return 'needs-sessions-page';
    } catch (err) {
      console.warn('[setup-run] command probe failed; starting natively on preflight alone', err);
    }
    tool = candidate;
    return 'ready';
  }

  async function start(prompt: string, pick?: SessionTool): Promise<string> {
    const spec: SessionSpec = {
      sessionId: '',
      title: null,
      tool: pick ?? tool,
      cwd: '',
      company: null,
      project: null,
      model: null,
      effort: null,
      resume: null,
      permissionMode: 'prompt',
    };
    return store.startAndSend(spec, prompt);
  }

  async function attach(sessionId: string): Promise<boolean> {
    await store.refreshList();
    if (!store.sessions.some((session) => session.sessionId === sessionId)) return false;
    await store.open(sessionId);
    return true;
  }

  /** Every send goes to the watched session, whichever one the page has active. */
  async function focus(sessionId: string): Promise<void> {
    if (store.activeSessionId !== sessionId || !store.hasOpen(sessionId)) await store.open(sessionId);
  }

  function snapshotOf(sessionId: string): SetupRunSnapshot {
    return {
      sessionId,
      events: $state.snapshot(store.eventsOf(sessionId)),
      phase: store.phaseOf(sessionId),
      resolvedRequestIds: store.resolvedRequestIdsOf(sessionId),
    };
  }

  function subscribe(sessionId: string, cb: (snapshot: SetupRunSnapshot) => void): () => void {
    // The first snapshot goes out synchronously — a root effect's first run is
    // scheduled, and the card must not paint an empty frame in between.
    cb(snapshotOf(sessionId));
    return $effect.root(() => {
      $effect(() => {
        cb(snapshotOf(sessionId));
      });
    });
  }

  async function answerQuestion(sessionId: string, requestId: string, answers: SetupRunAnswer[]): Promise<void> {
    await focus(sessionId);
    await store.answerQuestion(requestId, answers);
  }

  async function respondPermission(
    sessionId: string,
    requestId: string,
    decision: SetupRunPermissionDecision,
  ): Promise<void> {
    await focus(sessionId);
    await store.respondPermission(
      requestId,
      decision === 'deny' ? { kind: 'deny', message: 'Not now' } : { kind: decision },
    );
  }

  async function send(sessionId: string, text: string): Promise<void> {
    await focus(sessionId);
    await store.send(text);
  }

  /**
   * The secret card's value goes straight to `hq secrets set --from-stdin`
   * via the Rust side. It is never sent to the session or logged.
   */
  async function storeSecret(card: SetupSecretCard, value: string): Promise<void> {
    await (options.invoke ?? invoke)('setup_store_secret', {
      name: card.name,
      scope: card.scope ?? 'personal',
      company: card.scope === 'company' ? (card.company ?? null) : null,
      value,
    });
  }

  async function providers(refresh = false): Promise<SetupProviderStatus> {
    if (refresh) store.invalidatePreflight();
    const result = await store.preflight();
    return {
      hqReady: result.hqSetup ? result.hqSetup === 'ready' : result.hooksReady,
      claudeAvailable: result.claudeAvailable,
      claudeLoggedIn: result.claudeLoggedIn,
      codexAvailable: result.codexAvailable,
      codexLoggedIn: result.codexLoggedIn,
    };
  }

  return {
    preflight,
    start,
    attach,
    subscribe,
    answerQuestion,
    respondPermission,
    send,
    storeSecret,
    providers,
    providerLoginStart: (tool) => store.providerLoginStart(tool),
    providerLoginStatus: (tool) => store.providerLoginStatus(tool),
    providerLoginCancel: (tool) => store.providerLoginCancel(tool),
    providerInstallUrl: (tool) => (tool === 'claude' ? CLAUDE_INSTALL_URL : CODEX_INSTALL_URL),
    openExternal: (url) => openExternal(url),
  };
}

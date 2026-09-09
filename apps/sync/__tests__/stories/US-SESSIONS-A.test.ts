/**
 * US-SESSIONS-A — the Sessions page is wired, not orphaned.
 *
 * The sync suite runs in a node environment, so Svelte components cannot be
 * mounted here. Everything that CAN be executed is executed for real — the
 * route resolver is imported and called, not string-matched — and the wiring
 * that only exists as markup (the mount branch, the palette entry, the panel
 * composition) is pinned at the source level. That combination is what stops a
 * page from shipping that nothing renders and nothing can reach.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  getDesktopHotkeyRoute,
  getDesktopRouteKey,
  resolvePendingDesktopRoute,
} from '../../src/desktop-alt/route';
import { SESSION_EVENT_KINDS } from '../../src/components/sessions/session-events';
import { foldSessionEvents } from '../../src/components/sessions/transcript-adapter';
import { parsePolicyDigest } from '../../src/components/sessions/policy-digest';

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');

const ROUTE = read('src/desktop-alt/route.ts');
const APP = read('src/desktop-alt/DesktopApp.svelte');
const WORK_HOST = read('src/desktop-alt/HqWorkWorkShell.svelte');
const SHARED_APP = read('../../packages/ui/src/shell/DesktopApp.svelte');
const PAGE = read('src/desktop-alt/pages/SessionsPage.svelte');
const STORE = read('src/desktop-alt/lib/live-session-store.svelte.ts');
const ADAPTER = read('src/components/sessions/transcript-adapter.ts');
const TRANSCRIPT = read('src/components/sessions/SessionTranscript.svelte');
const COMPOSER = read('src/components/sessions/SessionComposer.svelte');
const STRIP = read('src/components/sessions/SessionsStrip.svelte');
const CHIP = read('src/components/sessions/PoliciesChip.svelte');
const EVENTS = read('src/components/sessions/session-events.ts');
const MENTIONS = read('src/components/sessions/mentions.ts');
const MAIN_RS = read('src-tauri/src/main.rs');
const MENTIONS_RS = read('src-tauri/src/commands/session_mentions.rs');

describe('US-SESSIONS-A — the route', () => {
  it('DesktopRoute carries a sessions kind with an optional id', () => {
    expect(ROUTE).toContain("kind: 'sessions'; id?: string");
  });

  it('resolves `sessions` and `sessions:<id>` for real', () => {
    expect(resolvePendingDesktopRoute('sessions')).toEqual({ kind: 'sessions' });
    expect(resolvePendingDesktopRoute('sessions:abc')).toEqual({ kind: 'sessions', id: 'abc' });
    // The slash form the pending-route normaliser also accepts.
    expect(resolvePendingDesktopRoute('sessions/abc')).toEqual({ kind: 'sessions', id: 'abc' });
  });

  it('keys the remount on the selected session so switching sessions remounts', () => {
    expect(getDesktopRouteKey({ kind: 'sessions' })).toBe('sessions');
    expect(getDesktopRouteKey({ kind: 'sessions', id: 'abc' })).toBe('sessions:abc');
    expect(getDesktopRouteKey({ kind: 'sessions', id: 'abc' })).not.toBe(
      getDesktopRouteKey({ kind: 'sessions', id: 'xyz' }),
    );
  });

  it('stays palette-only: no ⌘ hotkey and no V4 sidebar mapping', () => {
    // Exactly like Mission Control. Every ⌘1–⌘9 slot must still resolve to what
    // it resolved to before, and never to Sessions.
    const companies = [
      { kind: 'company', slug: 'indigo', displayName: 'Indigo' },
      { kind: 'company', slug: 'ridge', displayName: 'Ridge' },
    ] as unknown as Parameters<typeof getDesktopHotkeyRoute>[1];
    for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      const hit = getDesktopHotkeyRoute({ key, metaKey: true, ctrlKey: false }, companies);
      expect(hit?.kind).not.toBe('sessions');
    }
    const fromV4 = ROUTE.slice(ROUTE.indexOf('export function fromV4Route'));
    expect(fromV4).not.toContain("'sessions'");
  });
});

describe('US-SESSIONS-A — DesktopApp wiring', () => {
  it('imports the page and mounts it on the sessions route', () => {
    expect(APP).toContain("import SessionsPage from './pages/SessionsPage.svelte'");
    expect(APP).toContain("route.kind === 'sessions'");
    expect(APP).toContain('<SessionsPage');
  });

  it('mounts sessions BEFORE the activeCompany fallback', () => {
    const sessionsAt = APP.indexOf("route.kind === 'sessions'");
    const fallbackAt = APP.indexOf('{:else if activeCompany}');
    expect(sessionsAt).toBeGreaterThan(-1);
    expect(fallbackAt).toBeGreaterThan(-1);
    expect(sessionsAt).toBeLessThan(fallbackAt);
  });

  it('exposes the palette entry on production builds without a machine opt-in', () => {
    expect(WORK_HOST).not.toContain('inAppSessions');
    expect(WORK_HOST).not.toContain('sessionsEnabled');
    expect(WORK_HOST).toContain("sessions: {");
    expect(WORK_HOST).toContain('{extraPages}');
    expect(SHARED_APP).toContain('id: `command-go-${id}`');
    expect(SHARED_APP).toContain('for (const [id, page] of Object.entries(extraPages ?? {}))');
  });

  it('navigates to a started session by id', () => {
    expect(APP).toContain("navigate({ kind: 'sessions', id: id || undefined })");
  });
});

describe('US-SESSIONS-A — the page composes the chat surface', () => {
  it('imports the strip, the drawer, the transcript, and the composer', () => {
    expect(PAGE).toContain("import SessionsStrip from '../../components/sessions/SessionsStrip.svelte'");
    expect(PAGE).toContain("import SessionListPanel from '../panels/SessionListPanel.svelte'");
    expect(PAGE).toContain(
      "import SessionTranscript from '../../components/sessions/SessionTranscript.svelte'",
    );
    expect(PAGE).toContain(
      "import SessionComposer from '../../components/sessions/SessionComposer.svelte'",
    );
  });

  it('renders the transcript above the composer', () => {
    const transcriptAt = PAGE.indexOf('<SessionTranscript');
    const composerAt = PAGE.indexOf('<SessionComposer');
    expect(transcriptAt).toBeGreaterThan(-1);
    expect(composerAt).toBeGreaterThan(transcriptAt);
  });

  it('renders decision cards INLINE in the transcript, at their position', () => {
    expect(TRANSCRIPT).toContain('<PermissionCard');
    expect(TRANSCRIPT).toContain('<QuestionCard');
    // Not a tray pinned above the composer: the card is a block in the stream,
    // so it appears where the agent actually asked.
    expect(TRANSCRIPT).toContain("block.type === 'permissionCard'");
    expect(TRANSCRIPT).toContain("block.type === 'questionCard'");
    expect(PAGE).not.toContain('<PermissionCard');
  });

  it('drives every session action through the store, never a raw invoke', () => {
    expect(PAGE).not.toContain("invoke(");
    expect(PAGE).toContain('liveSessionStore.respondPermission');
    expect(PAGE).toContain('liveSessionStore.answerQuestion');
    expect(PAGE).toContain('liveSessionStore.interrupt');
    expect(PAGE).toContain('liveSessionStore.send');
  });
});

describe('US-SESSIONS-A — chat-first: no setup screen anywhere', () => {
  it('has no start-a-session panel left to mount', () => {
    // The owner's verdict was explicit: no extra screens, no model-selection
    // step. The panel is gone, not merely unrouted.
    expect(() => read('src/components/sessions/NewSessionPanel.svelte')).toThrow();
    expect(PAGE).not.toContain('NewSessionPanel');
    expect(read('src/components/sessions/index.ts')).not.toContain('NewSessionPanel');
  });

  it('starts the session from the FIRST MESSAGE rather than a form', () => {
    expect(PAGE).toContain('liveSessionStore.startAndSend');
    expect(STORE).toContain('async function startAndSend');
    // start → send → navigate, in that order, inside the store.
    const fn = STORE.slice(STORE.indexOf('async function startAndSend'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body.indexOf('await start(spec)')).toBeLessThan(body.indexOf("'agent_session_send'"));
    expect(PAGE).toContain('onopensession?.(started)');
  });

  it('keeps tool / company / model / effort / permission as composer pills', () => {
    for (const testid of [
      'session-pill-tool',
      'session-pill-company',
      'session-pill-model',
      'session-pill-effort',
      'session-pill-permission',
    ]) {
      expect(COMPOSER, `composer is missing the ${testid} pill`).toContain(testid);
    }
    expect(COMPOSER).toContain("placeholder = 'Do anything…'");
  });

  it('parks every control on its own row BELOW the text, Claude-style', () => {
    // The owner's verdict on the one-row bar: "move the controls to the bottom
    // like how Claude Code has them". The mounted proof is in
    // src/components/sessions/SessionComposer.test.ts; this pins the ordering
    // in the markup so the row cannot drift back up beside the caret.
    const textAt = COMPOSER.indexOf('data-testid="session-composer-input"');
    const controlsAt = COMPOSER.indexOf('data-testid="session-composer-controls"');
    expect(textAt).toBeGreaterThan(-1);
    expect(controlsAt).toBeGreaterThan(textAt);
    // Both live inside the same rounded box.
    expect(COMPOSER).toContain('class="box"');
  });

  it('leaves nothing under the box but the HQ folder', () => {
    // "remove all the text below the text box except hq (thread id, in/out,
    // money etc)". The store still carries the usage — the footer just is not
    // where it belongs.
    expect(COMPOSER).toContain('session-foot-folder');
    expect(COMPOSER).not.toContain('session-foot-id');
    expect(COMPOSER).not.toContain('session-foot-usage');
    expect(COMPOSER).not.toContain('usageLabel');
    expect(PAGE).not.toContain('sessionShort');
    expect(PAGE).not.toContain('usageLabel');
  });

  it('picks a model by friendly name, never by raw id or the word "Default"', () => {
    const MODELS = read('src/components/sessions/session-models.ts');
    expect(MODELS).toContain('export function friendlyModelName');
    expect(MODELS).toContain('export function selectableModels');
    expect(MODELS).toContain('export function modelMenuRows');
    expect(COMPOSER).toContain('modelPillLabel');
    expect(COMPOSER).toContain('session-menu-model');
    // The pill's own <select> overlay is gone: menus are anchored popovers so
    // they cannot be clipped by the transcript's scroll container.
    expect(COMPOSER).not.toContain('<select');
    expect(COMPOSER).toContain('bottom: calc(100% + 6px)');
    // The strip names the model the same way the pill does — which for Codex
    // means the catalog's own display name, not the friendly mapper's version.
    expect(PAGE).toContain('modelPillLabel');
    expect(PAGE).toContain('friendlyModelName');
  });

  it('carries the tool choice into the spec and refetches that CLI’s catalog', () => {
    expect(PAGE).toContain('LAST_TOOL_KEY');
    expect(PAGE).toContain('.slashCommands(wanted, forceRefresh)');
    expect(PAGE).toContain('function chooseTool');
    expect(PAGE).toContain('codexAvailable');
    // `tool` is the page's state, not a hard-coded literal in the spec.
    const spec = PAGE.slice(PAGE.indexOf('function specFrom'));
    expect(spec.slice(0, spec.indexOf('\n  }'))).not.toContain("tool: 'claude'");
    // Catalog failures stay in the retryable picker, not the chat banner.
    expect(PAGE).toContain('catalogError');
    expect(PAGE).toContain('modelsError={catalogError}');
    expect(PAGE).not.toContain('blocker || actionError || catalogError');
  });

  it('remembers the last company under the agreed localStorage key', () => {
    expect(read('src/components/sessions/session-models.ts')).toContain(
      "'hq.sessions.lastCompany'",
    );
    expect(PAGE).toContain('LAST_COMPANY_KEY');
  });

  it('names a plain next step for each preflight blocker, never a command to type', () => {
    // Every blocker still has its own remedy, but the remedy is something on
    // the page (the Connect buttons, the setup Retry) — a brand-new user is
    // never told to run `claude login`, `codex login` or `hq rescue`.
    expect(PAGE).toContain('claudeAvailable');
    expect(PAGE).toContain('claudeLoggedIn');
    expect(PAGE).toContain('codexLoggedIn');
    expect(PAGE).toContain('Use Connect Claude below to sign in.');
    expect(PAGE).toContain('Use Connect Codex below to sign in.');
    expect(PAGE).not.toContain('claude login');
    expect(PAGE).not.toContain('codex login');
    expect(PAGE).not.toContain('hq rescue');
    expect(PAGE).not.toContain('settings.json');
    // The technical `hooksError` is for the support log, not the screen.
    expect(PAGE).not.toContain('{preflight.hooksError}');
    expect(PAGE).not.toContain('preflight.hooksError ??');
    // One inline notice above the composer — not a screen that replaces it.
    expect(PAGE).toContain('{notice}');
    expect(COMPOSER).toContain('session-composer-notice');
  });

  it('finishes HQ setup itself instead of asking for a terminal', () => {
    expect(PAGE).toContain('hqSetup');
    expect(PAGE).toContain('repairHqSetup');
    expect(PAGE).toContain('Finishing HQ setup on this Mac…');
    expect(PAGE).toContain("Couldn't finish HQ setup.");
    expect(PAGE).toContain('session-setup-retry');
    // One automatic attempt per visit; Retry is by hand.
    expect(PAGE).toContain('setupAutoAttempted');
  });
});

describe('US-SESSIONS-A — the transcript reads as a chat', () => {
  it('renders the operator right and the agent as plain prose', () => {
    expect(TRANSCRIPT).toContain('session-user-bubble');
    expect(TRANSCRIPT).toContain('session-assistant-prose');
    expect(TRANSCRIPT).toContain('renderMessageBodyMarkdown');
    // No avatar, no author header, no per-row timestamp gutter.
    expect(TRANSCRIPT).not.toContain('<Avatar');
    expect(TRANSCRIPT).not.toContain('formatTime(');
    expect(TRANSCRIPT).not.toContain('<MessageTimeline');
  });

  it('folds each run of tool work into one expandable row', () => {
    expect(TRANSCRIPT).toContain('<ToolGroupRow');
    const row = read('src/components/sessions/ToolGroupRow.svelte');
    expect(row).toContain('aria-expanded');
    expect(row).toContain('session-tool-group');
    expect(ADAPTER).toContain('export function toolGroupSummary');
  });

  it('keeps the reader in charge of the viewport', () => {
    expect(TRANSCRIPT).toContain('session-jump-to-latest');
    expect(TRANSCRIPT).toContain('pinned');
  });
});

describe('US-SESSIONS-A — timestamps are observed, never invented', () => {
  it('the store takes its stamps from the backend rather than its own clock', () => {
    // The backend stamps every buffered event with `receivedAtMs` and reports
    // the same instant live and on replay, so a reopened transcript is dated
    // by when things happened. `Date.now()` survives only as the fallback for
    // a payload that carries no stamp at all.
    expect(STORE).toContain('entry.receivedAt.push(receivedAtMs ?? Date.now())');
    expect(STORE).toContain('entry.receivedAtMs');
    expect(STORE).toContain('receivedAtMs: number');
  });

  it('the adapter synthesizes no clock of its own', () => {
    // The bug this replaces: `startedAt + index * stepMs` produced a real-looking
    // "Thursday, January 1 12:00 AM" divider on every replayed transcript.
    expect(ADAPTER).not.toContain('DEFAULT_STARTED_AT');
    expect(ADAPTER).not.toContain('stepMs');
    expect(ADAPTER).toContain('receivedAt');
  });
});

describe('US-SESSIONS-A — the event contract is fully handled', () => {
  it('the adapter folds every SessionEvent kind', () => {
    const handled = new Set(
      [...ADAPTER.matchAll(/case '([a-zA-Z]+)':/g)].map((match) => match[1]),
    );
    const unhandled = SESSION_EVENT_KINDS.filter((kind) => !handled.has(kind));
    expect(unhandled, `event kinds the adapter drops: ${unhandled.join(', ') || 'none'}`).toEqual(
      [],
    );
  });

  it('the store speaks all three agent-session events, needs-you included', () => {
    expect(STORE).toContain("'agent-session:event'");
    expect(STORE).toContain("'agent-session:phase'");
    expect(STORE).toContain("'agent-session:needs-you'");
    expect(STORE).toContain('NeedsYouNotice');
    expect(STORE).toContain('needsYou = payload');
  });

  it('the store covers the whole agent_session command surface', () => {
    for (const command of [
      'agent_session_preflight',
      'agent_session_start',
      'agent_session_send',
      'agent_session_respond_permission',
      'agent_session_answer_question',
      'agent_session_interrupt',
      'agent_session_set_permission_mode',
      'agent_session_end',
      'agent_session_list',
      'agent_session_replay',
      'agent_session_slash_commands',
      'agent_session_open_in_app',
      'agent_session_cli_session_id',
    ]) {
      expect(STORE, `store never invokes ${command}`).toContain(`'${command}'`);
    }
  });
});

describe('follow-ups stay in the live session', () => {
  it('forks a new session only when the user changed a pill, never by comparing values', () => {
    // The live summary reports the CLI's resolved model id while the pill holds
    // the catalog value; comparing them forked the chat on every follow-up.
    expect(PAGE).toContain('const newSessionPending = $derived(Boolean(sessionId) && pillsDirty);');
    expect(PAGE).not.toMatch(/summary\.model \?\? null\) !== model/);
    expect(PAGE).toContain('function markPillsDirty(changed: boolean)');
    expect(PAGE).toContain('pillsDirty = false;');
  });

  it('ONLY a company (or tool) change forks — never model, effort, or permission', () => {
    // "Selecting a new thinking mode started a new chat, which it should not."
    // A company binds the session's context and cannot be rebound on a running
    // child; everything else moves in place.
    const dirtying = [...PAGE.matchAll(/markPillsDirty\(([^)]*)\)/g)]
      .map((match) => match[1]!.trim())
      .filter((argument) => argument !== 'changed: boolean');
    expect(dirtying.sort()).toEqual(['next !== tool', 'slug !== company']);

    // The moved pills ride the next send instead.
    expect(PAGE).toContain('pendingOverrides');
    expect(PAGE).toContain('liveSessionStore.send(wire, attachments, pendingOverrides, meta)');
    expect(PAGE).toContain('liveSessionStore.setPermissionMode(mode)');
    expect(STORE).toContain('overrides: TurnOverrides | null = null');
  });

  it('tells a Claude operator where a model/effort change actually lands', () => {
    // Claude runs one `--print` process per session and cannot be moved off the
    // model it was launched with; Codex takes both per `turn/start`.
    expect(PAGE).toContain("summary?.tool === 'claude'");
    expect(PAGE).toContain('overridesDeferred');
    expect(COMPOSER).toContain('Model/effort apply to your next session');
    expect(COMPOSER).toContain('session-overrides-deferred-hint');
  });
});

describe('the model pill belongs to one tool at a time', () => {
  const MODELS = read('src/components/sessions/session-models.ts');

  it('remembers model and effort per tool, migrating the shared key once', () => {
    expect(MODELS).toContain("return `${LAST_MODEL_KEY}.${tool}`;");
    expect(MODELS).toContain("return `${LAST_EFFORT_KEY}.${tool}`;");
    expect(MODELS).toContain('export function readRememberedModel');
    expect(MODELS).toContain('export function readRememberedEffort');
    expect(PAGE).toContain('readRememberedModel(initialTool)');
    expect(PAGE).toContain('readRememberedEffort(initialTool)');
    // The page no longer reads or writes the shared keys directly.
    expect(PAGE).not.toContain('readRemembered(LAST_MODEL_KEY)');
    expect(PAGE).not.toContain('remember(LAST_MODEL_KEY');
    expect(PAGE).not.toContain('remember(LAST_EFFORT_KEY');
  });

  it('moves model and effort WITH the tool pill, before any send', () => {
    const chooser = PAGE.slice(PAGE.indexOf('function chooseTool'));
    const body = chooser.slice(0, chooser.indexOf('\n  }'));
    expect(body).toContain('model = readRememberedModel(next);');
    expect(body).toContain('effort = readRememberedEffort(next);');
    expect(body).toContain('ensureModelValid();');
    // A tool switch is still a fork for the NEXT send only — never by itself.
    expect(body).toContain('markPillsDirty(next !== tool);');
    expect(body).not.toContain('startAndSend');
    expect(body).not.toContain('onopensession');
  });

  it('validates the model on the send path, not only in an effect', () => {
    expect(MODELS).toContain('export function validateModel');
    expect(MODELS).toContain('export function plausibleModelForTool');
    const spec = PAGE.slice(PAGE.indexOf('function specFrom'));
    expect(spec.slice(0, spec.indexOf('\n  }'))).toContain('ensureModelValid();');
    const overrides = PAGE.slice(PAGE.indexOf('const pendingOverrides'));
    expect(overrides.slice(0, overrides.indexOf('\n  });'))).toContain('validateModel(');
    expect(PAGE).toContain('Model reset to ${name} for ${toolLabel}');
    expect(COMPOSER).toContain('session-model-reset-note');
  });

  it('clamps the effort pill to the current tool’s ladder', () => {
    expect(MODELS).toContain('export const CODEX_EFFORT_OPTIONS');
    expect(MODELS).toContain('export function effortOptionsFor');
    expect(MODELS).toContain('export function clampEffort');
    expect(PAGE).toContain('effortOptionsFor(tool, catalogReady ? models : null)');
    expect(COMPOSER).toContain('{#each effortOptions as option');
  });

  it('renders model_not_found once, with the recovery inline', () => {
    expect(ADAPTER).toContain("export const MODEL_NOT_FOUND_CODE = 'model_not_found';");
    expect(ADAPTER).toContain('export function isModelNotFoundText');
    expect(ADAPTER).toContain("action: 'chooseModel'");
    expect(TRANSCRIPT).toContain('session-choose-model');
    expect(TRANSCRIPT).toContain('onchoosemodel');
    expect(PAGE).toContain('onchoosemodel={() => composer?.openModelMenu()}');
    expect(COMPOSER).toContain('export function openModelMenu()');

    // Executed: the three copies the owner saw fold to one line.
    const narration = "There's an issue with the selected model (gpt-5.6-sol) (model_not_found)";
    const { blocks } = foldSessionEvents([
      { kind: 'userMessage', text: 'hi', imageCount: 0 },
      { kind: 'assistantMessage', text: narration },
      { kind: 'error', message: "The selected model isn't available.", code: 'model_not_found' },
      { kind: 'turnDone', status: 'error', error: narration },
    ]);
    expect(blocks.map((block) => block.type)).toEqual(['userBubble', 'error']);
  });

  it('titles the strip from the announced model, never the pill', () => {
    // The registry seeds `summary.model` from the spec until `started` lands.
    expect(PAGE).toContain('liveSessionStore.startedModel');
    expect(PAGE).toContain('plausibleModelForTool(announced, live.tool)');
    expect(PAGE).not.toContain('const resolvedModel = $derived(summary?.model ?? null);');
  });
});

describe('the status tail is honest about a slow first turn', () => {
  it('a handshake announcement never retires a session that is already working', () => {
    const registry = readFileSync(
      new URL(
        '../../../../crates/hq-desktop-core/src/agent_session/registry.rs',
        import.meta.url,
      ),
      'utf8',
    );
    // Codex's first turn is 30-50s of hooks and bookkeeping, and its `Started`
    // is recorded by the driver task AFTER the operator can have pressed Enter.
    // Letting it set Idle unconditionally parked the strip at "Idle" — and
    // dropped the status tail — for the whole turn.
    expect(registry).toContain('if self.phase == SessionPhase::Starting {');
  });
});

describe('the agent is never silently busy', () => {
  it('renders a shimmering status tail while starting, thinking, or running tools', () => {
    const page = readFileSync(
      new URL('../../src/desktop-alt/pages/SessionsPage.svelte', import.meta.url),
      'utf8',
    );
    const transcript = readFileSync(
      new URL('../../src/components/sessions/SessionTranscript.svelte', import.meta.url),
      'utf8',
    );
    expect(page).toContain('status={workStatus}');
    expect(page).toMatch(/if \(starting \|\| \(sessionId && phase === 'starting'\)\) return 'starting'/);
    expect(page).toContain("if (last.type === 'toolGroup' && last.running) return 'tools';");
    // Streaming prose is the activity — no second indicator under it.
    expect(page).toContain("if (last.type === 'assistantProse' && last.streaming) return '';");
    expect(transcript).toContain('data-testid="session-working"');
    expect(transcript).toContain("starting: 'Starting session…'");
    expect(transcript).toContain("thinking: 'Thinking…'");
    expect(transcript).toContain("tools: 'Working…'");
    // Elapsed seconds only after a grace period, so quick turns stay quiet.
    expect(transcript).toMatch(/statusElapsed >= 4/);
  });
});

describe('US-SESSIONS-A — @mentions: teammates and fleet agents from the composer', () => {
  it('the composer owns the @ popover and the chips, over the same slot as the slash menu', () => {
    expect(COMPOSER).toContain("import MentionPicker from './MentionPicker.svelte'");
    expect(COMPOSER).toContain('<MentionPicker');
    expect(COMPOSER).toContain('data-testid="session-mention-chips"');
    expect(COMPOSER).toContain('data-testid="session-mention-remove"');
    // Mention precedence: the slash picker yields to an @ token under the caret.
    expect(COMPOSER).toContain('const pickerOpen = $derived(!mentionOpen && slashQuery !== null)');
    // The chips are the DM list — the send carries exactly what is visible.
    expect(COMPOSER).toContain('onsend?.(text, attached, chips, attachments)');
  });

  it('the page loads the directory per company and DMs only AFTER the session send', () => {
    expect(PAGE).toContain(
      "from '../../components/sessions/mentions'",
    );
    expect(PAGE).toContain('loadMentionCandidates(wanted)');
    expect(PAGE).toContain('{mentionCandidates}');
    expect(PAGE).toContain('async function onmentionsend(');
    const fn = PAGE.slice(PAGE.indexOf('async function handleSend('));
    const body = fn.slice(0, fn.indexOf('\n  }\n'));
    expect(body.indexOf('await liveSessionStore.send(')).toBeLessThan(
      body.indexOf('await onmentionsend(sessionId, text, mentions)'),
    );
    expect(body.indexOf('await liveSessionStore.startAndSend(')).toBeLessThan(
      body.indexOf('if (started && messageAccepted) await onmentionsend(started, text, mentions)'),
    );
    expect(body).toContain('let messageAccepted = false;');
    // A failed session send returns before any DM goes out.
    expect(body).toContain("actionError = err instanceof Error ? err.message : String(err);\n        return;");
  });

  it('routes both Tauri calls through mentions.ts, never a raw invoke on the page', () => {
    expect(PAGE).not.toContain('invoke(');
    expect(MENTIONS).toContain("invoke<MentionCandidate[]>('session_mention_candidates'");
    expect(MENTIONS).toContain("invoke<MentionDelivery[]>('session_mention_notify'");
  });

  it('registers the two commands and composes the existing directory + DM paths', () => {
    expect(MAIN_RS).toContain('commands::session_mentions::session_mention_candidates');
    expect(MAIN_RS).toContain('commands::session_mentions::session_mention_notify');
    expect(MENTIONS_RS).toContain('messages::list_company_members(company_uid)');
    expect(MENTIONS_RS).toContain('dm_notify::post_dm_payload(&payload, "SESSION_MENTION_DM")');
    // No new HTTP endpoints, no transcript in the payload.
    expect(MENTIONS_RS).not.toContain('/v1/agents');
    expect(MENTIONS_RS).not.toContain('replay');
    expect(MENTIONS_RS).toContain('"details": details');
  });
});

describe('US-SESSIONS-A — Open / Share / Deploy on files the agent produced', () => {
  const ROW = read('src/components/sessions/ToolGroupRow.svelte');
  const ARTIFACT_ROW = read('src/components/sessions/ArtifactRow.svelte');
  const ARTIFACTS = read('src/components/sessions/session-artifacts.ts');

  it('derives artifacts in the adapter, purely, from the file tools only', () => {
    expect(ADAPTER).toContain('export function toolArtifactPaths');
    expect(ADAPTER).toContain('artifactPath?: string');
    expect(ADAPTER).toContain('artifacts: ToolArtifact[]');
    // A Bash command that happens to create a file is deliberately not parsed.
    const fileTools = ADAPTER.slice(ADAPTER.indexOf('const FILE_TOOLS'));
    expect(fileTools.slice(0, fileTools.indexOf('\n'))).not.toContain('Bash');
  });

  it('renders the action row inside the EXPANDED tool group only', () => {
    expect(TRANSCRIPT).toContain('artifacts={block.artifacts}');
    expect(TRANSCRIPT).toContain('{artifactActions}');
    expect(ROW).toContain('<ArtifactRow');
    // The artifact list sits inside the `{#if open}` branch, after the calls.
    const openAt = ROW.indexOf('{#if open}');
    const artifactsAt = ROW.indexOf('session-tool-artifacts');
    expect(openAt).toBeGreaterThan(-1);
    expect(artifactsAt).toBeGreaterThan(openAt);
    for (const id of ['session-artifact-open', 'session-artifact-share', 'session-artifact-deploy']) {
      expect(ARTIFACT_ROW).toContain(id);
    }
  });

  it('shares only vault files, shows the link once, and never logs it', () => {
    expect(ARTIFACTS).toContain("'Only company vault files can be shared'");
    expect(ARTIFACT_ROW).toContain('session-artifact-share-card');
    expect(ARTIFACT_ROW).toContain('session-artifact-copy');
    expect(ARTIFACT_ROW).toContain('session-artifact-share-dismiss');
    expect(ARTIFACT_ROW).not.toContain('console.');
    expect(ARTIFACT_ROW).not.toContain('localStorage');
    expect(ARTIFACTS).not.toContain('console.');
  });

  it('deploys by sending /deploy <path> as a user turn, through the store', () => {
    expect(ARTIFACTS).toContain('export function deployCommandFor');
    expect(PAGE).toContain('tauriArtifactActions(');
    expect(PAGE).toContain('handleSend(deployCommandFor(path), [])');
    expect(PAGE).toContain('{artifactActions}');
    expect(PAGE).not.toContain('invoke(');
  });
});

describe('the "Policies applied" chip — HQ hooks are visible in the strip', () => {
  it('the event contract carries hook notices, camelCase like the Rust enum', () => {
    expect(SESSION_EVENT_KINDS).toContain('hookNotice');
    expect(EVENTS).toContain("kind: 'hookNotice'");
    expect(EVENTS).toContain('hookEvent: string');
    expect(EVENTS).toContain('hookName: string');
    // The Rust side names the same variant and the same fields.
    const types = readFileSync(
      new URL('../../../../crates/hq-desktop-core/src/agent_session/types.rs', import.meta.url),
      'utf8',
    );
    expect(types).toContain('HookNotice {');
    expect(types).toContain('hook_event: String');
    expect(types).toContain('hook_name: String');
    expect(types).toContain('pub const HOOK_NOTICE_TEXT_CAP: usize = 8 * 1024;');
  });

  it('both normalizers emit the notice; the Claude one no longer drops hook_response', () => {
    const claude = readFileSync(
      new URL(
        '../../../../crates/hq-desktop-core/src/agent_session/claude_normalize.rs',
        import.meta.url,
      ),
      'utf8',
    );
    const codex = readFileSync(
      new URL(
        '../../../../crates/hq-desktop-core/src/agent_session/codex_normalize.rs',
        import.meta.url,
      ),
      'utf8',
    );
    expect(claude).toContain('if subtype == "hook_response"');
    expect(claude).toContain('SessionEvent::HookNotice {');
    expect(codex).toContain('"hook/completed" => hook_notice(&params)');
    expect(codex).toContain('SessionEvent::HookNotice {');
  });

  it('a hook notice is folded into state, never drawn as a row', () => {
    // Executed for real: the fold produces no block and fills `policies`.
    const state = foldSessionEvents([
      {
        kind: 'hookNotice',
        hookEvent: 'SessionStart',
        hookName: 'SessionStart:startup',
        text: '> Policy `hq-git-discipline` (HARD — binding rule from `x.md`):\n> Anchor it.\n<company-policy-digest co="indigo">\n</company-policy-digest>',
      },
    ]);
    expect(state.blocks).toEqual([]);
    expect(state.policies.company).toBe('indigo');
    expect(state.policies.entries).toEqual([
      { slug: 'hq-git-discipline', hard: true, excerpt: 'Anchor it.' },
    ]);
    // And the adapter's case is there by name, so the exhaustiveness test
    // above keeps covering it.
    expect(ADAPTER).toContain("case 'hookNotice':");
    // The notice's text is read through `contentToText` first — a hook notice
    // whose `text` is not a string is an empty digest, never a crash.
    expect(ADAPTER).toContain('const text = contentToText(event.text);');
    expect(ADAPTER).toContain('mergePolicyDigest(policies, parsePolicyDigest(text))');
  });

  it('the Rust and TS parsers are pinned on ONE shared fixture', () => {
    const fixture = 'src/components/sessions/__fixtures__/hook-policy-reminder.txt';
    const text = read(fixture);
    const digest = parsePolicyDigest(text);
    // The exact shape the Rust test `the_shared_fixture_parses_to_the_pinned_shape` asserts.
    expect(digest.company).toBe('indigo');
    expect(digest.entries).toHaveLength(6);
    expect(digest.entries.filter((entry) => entry.hard)).toHaveLength(4);
    const rust = readFileSync(
      new URL(
        '../../../../crates/hq-desktop-core/src/agent_session/policy_digest.rs',
        import.meta.url,
      ),
      'utf8',
    );
    expect(rust).toContain('__fixtures__/hook-policy-reminder.txt');
    expect(rust).toContain('assert_eq!(digest.entries.iter().filter(|e| e.hard).count(), 4);');
    expect(read('src/components/sessions/policy-digest.test.ts')).toContain(
      '__fixtures__/hook-policy-reminder.txt',
    );
  });

  it('the strip mounts the chip beside the phase dot and the page feeds it the fold', () => {
    expect(STRIP).toContain("import PoliciesChip from './PoliciesChip.svelte'");
    expect(STRIP).toContain('<PoliciesChip digest={policies} />');
    const chipAt = STRIP.indexOf('<PoliciesChip');
    const phaseAt = STRIP.indexOf('data-testid="sessions-phase"');
    expect(chipAt).toBeGreaterThan(-1);
    expect(phaseAt).toBeGreaterThan(chipAt);
    expect(PAGE).toContain('policies={sessionId ? transcript.policies : null}');
  });

  it('the chip is quiet: hidden until a policy lands, counts hard, groups Hard / Advisory, names the company', () => {
    expect(CHIP).toContain('data-testid="session-policies-chip"');
    expect(CHIP).toContain('Policies · {label}');
    expect(CHIP).toContain('digest.entries.length > 0 || digest.company !== null');
    expect(CHIP).toContain('data-testid="session-policies-company"');
    expect(CHIP).toContain('Bound to');
    expect(CHIP).toContain('data-testid="session-policies-hard"');
    expect(CHIP).toContain('data-testid="session-policies-advisory"');
    expect(read('src/components/sessions/policy-digest.ts')).toContain(
      'export function policyCountLabel',
    );
    // The mounted proof lives in PoliciesChip.test.ts.
    expect(read('src/components/sessions/PoliciesChip.test.ts')).toContain(
      "'Policies · 3 (1 hard)'",
    );
  });
});

describe('the "Hand off" button and the checkpoint prompt', () => {
  it('the strip offers a handoff button that is live only on an idle session', () => {
    expect(STRIP).toContain('data-testid="session-handoff"');
    expect(STRIP).toContain("disabled={handoff !== 'ready'}");
    expect(STRIP).toContain("{#if handoff === 'running'}");
    expect(STRIP).toContain('class="spinner"');
    expect(STRIP).toContain('Hand off');
    // Icon + label-on-hover, not a wide always-on label.
    expect(STRIP).toContain('.handoff:hover .handoff-label');
    expect(PAGE).toContain("if (transcript.handoff === 'running') return 'running';");
    expect(PAGE).toContain("if (sendDisabled || phase !== 'idle') return 'disabled';");
    expect(PAGE).toContain('handoff={handoffState}');
  });

  it('a click sends /handoff as a user turn through the store’s own send', () => {
    expect(read('src/components/sessions/hook-notices.ts')).toContain(
      "export const HANDOFF_COMMAND = '/handoff';",
    );
    expect(PAGE).toContain('await liveSessionStore.send(HANDOFF_COMMAND);');
    expect(PAGE).toContain('onhandoff={() => void handleHandoff()}');
    expect(PAGE).not.toContain("invoke(");
  });

  it('the fold marks the handoff running from the mirrored turn and done at turnDone, with a divider', () => {
    const state = foldSessionEvents(
      [
        { kind: 'assistantMessage', text: 'Handoff written.' },
        { kind: 'turnDone', status: 'success' },
      ],
      { userTurns: [{ id: 't1', text: '/handoff', atIndex: 0, at: null }] },
    );
    expect(state.handoff).toBe('done');
    const last = state.blocks[state.blocks.length - 1];
    expect(last?.type).toBe('divider');
    expect(last && 'label' in last ? last.label : '').toBe('Session handed off');
    // The transcript already renders dividers, so no new row type was needed.
    expect(TRANSCRIPT).toContain('data-testid="session-divider"');
  });

  it('⌘⇧H hands off while the Sessions page is mounted and focused', () => {
    expect(PAGE).toContain('<svelte:window onkeydown={onPageKeydown} />');
    expect(PAGE).toContain("if (event.key.toLowerCase() !== 'h') return;");
    expect(PAGE).toContain('if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return;');
    expect(PAGE).toContain('pageEl?.contains(target)');
    expect(STRIP).toContain('⌘⇧H');
  });

  it('the checkpoint prompt reads the real banner wording and offers one-click /checkpoint', () => {
    const hooks = read('src/components/sessions/hook-notices.ts');
    expect(hooks).toContain("const CHECKPOINT_BANNER = 'AUTO-CHECKPOINT REQUIRED';");
    expect(hooks).toContain("export const CHECKPOINT_COMMAND = '/checkpoint';");
    expect(PAGE).toContain('data-testid="session-checkpoint-notice"');
    expect(PAGE).toContain('Context is filling up —');
    expect(PAGE).toContain('data-testid="session-checkpoint-now"');
    expect(PAGE).toContain('Checkpoint now');
    expect(PAGE).toContain('await liveSessionStore.send(CHECKPOINT_COMMAND);');
    // Dismissable, and a later banner reopens it.
    expect(PAGE).toContain('data-testid="session-checkpoint-dismiss"');
    expect(PAGE).toContain('checkpointDismissedAt = transcript.checkpointPrompts;');
    expect(PAGE).toContain('transcript.checkpointPrompts > checkpointDismissedAt');
    // Rendered ABOVE the composer, inside the page — not inside the composer.
    const noticeAt = PAGE.indexOf('data-testid="session-checkpoint-notice"');
    const composerAt = PAGE.indexOf('<SessionComposer');
    expect(noticeAt).toBeGreaterThan(-1);
    expect(noticeAt).toBeLessThan(composerAt);

    // Executed for real: the banner raises the prompt, /checkpoint clears it.
    const raised = foldSessionEvents([
      {
        kind: 'hookNotice',
        hookEvent: 'Stop',
        hookName: 'Stop',
        text: '║  AUTO-CHECKPOINT REQUIRED — context ~50%                     ║',
      },
    ]);
    expect(raised.blocks).toEqual([]);
    expect(raised.checkpointDue).toBe(true);
    const cleared = foldSessionEvents(
      [{ kind: 'hookNotice', hookEvent: 'Stop', hookName: 'Stop', text: 'AUTO-CHECKPOINT REQUIRED' }],
      { userTurns: [{ id: 't1', text: '/checkpoint', atIndex: 1, at: null }] },
    );
    expect(cleared.checkpointDue).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Composer-level HQ features: start-work, the `/` picker, context attachments
// ---------------------------------------------------------------------------

import { planFirstSend } from '../../src/components/sessions/startwork';
import {
  composeWithContext,
  splitContextBlocks,
} from '../../src/components/sessions/context-attachments';

describe('company / project start-work — the first send orients the session', () => {
  const STARTWORK = read('src/components/sessions/startwork.ts');
  const PICKER = read('src/components/sessions/ProjectPicker.svelte');
  const HQ_CONTEXT_RS = read('src-tauri/src/commands/hq_context.rs');
  const PROJECTS_RS = read('../../crates/hq-desktop-core/src/hq_context/projects.rs');

  it('the company pill has a Project second level with "No project" first and done/total counts', () => {
    expect(COMPOSER).toContain("import ProjectPicker from './ProjectPicker.svelte'");
    expect(COMPOSER).toContain('<ProjectPicker');
    expect(COMPOSER).toContain("data-pane={companyPane}");
    expect(COMPOSER).toContain('data-testid="session-menu-project-open"');
    expect(PICKER).toContain('data-testid="session-project-none"');
    expect(PICKER).toContain('No project');
    expect(PICKER).toContain('storyProgress(project)');
    expect(STARTWORK).toContain('return `${entry.storyCounts.done}/${entry.storyCounts.total}`;');
    // Picking a company opens the project pane rather than closing the menu.
    expect(COMPOSER).toContain("oncompany?.(option.slug);\n                        companyPane = 'projects';");
  });

  it('the project picker is searchable, recency-sorted, and filterable by person and status', () => {
    expect(PICKER).toContain('data-testid="session-project-search"');
    expect(PICKER).toContain('data-testid="session-project-status-active"');
    expect(PICKER).toContain('data-testid="session-project-status-all"');
    expect(PICKER).toContain('data-testid="session-project-person"');
    expect(PICKER).toContain('data-testid="session-project-avatar"');
    expect(PICKER).toContain('data-testid="session-project-updated"');
    expect(PICKER).toContain('data-testid="session-project-progress"');
    expect(PICKER).toContain('filterProjects(projects, { query, owner, status })');
    expect(STARTWORK).toContain('export function sortProjectsByActivity(');
    expect(STARTWORK).toContain('export function ownerChips(');
    // The row never repeats its description as a tooltip; the one-line clip
    // carries a title only when it actually cut the text.
    expect(PICKER).not.toContain('title={project.description}');
    expect(PICKER).toContain('use:clipTitle={project.description}');
    expect(PICKER).toContain('if (node.scrollWidth > node.clientWidth) node.title = value;');
    // "Mine" comes from the signed-in email, read through the store.
    expect(PAGE).toContain('liveSessionStore.hqSelf()');
    expect(STORE).toContain("invoke<{ authenticated?: boolean; email?: string | null }>('get_auth_state')");
    expect(COMPOSER).toContain('{viewer}');
    // The Rust row carries what the filters need.
    expect(PROJECTS_RS).toContain('pub owner: Option<String>,');
    expect(PROJECTS_RS).toContain('pub last_activity_at: Option<String>,');
    expect(PROJECTS_RS).toContain('pub status: ProjectStatus,');
    expect(PROJECTS_RS).toContain('pub const MAX_PROJECTS: usize = 200;');
    expect(STARTWORK).toContain("export type ProjectStatus = 'active' | 'done' | 'archived';");
  });

  it('remembers the last project per company under hq.sessions.lastProject.<slug>', () => {
    expect(STARTWORK).toContain("export const LAST_PROJECT_KEY_PREFIX = 'hq.sessions.lastProject.';");
    expect(PAGE).toContain('project = readLastProject(wanted);');
    expect(PAGE).toContain('rememberLastProject(company, name);');
  });

  it('a new session clears the project (and the draft) but keeps the company', () => {
    // The strip's "+" resets in place — the route may not change.
    expect(STRIP).toContain('data-testid="sessions-new"');
    expect(PAGE).toContain('onnew={startFreshDraft}');
    const fn = PAGE.slice(PAGE.indexOf('function startFreshDraft()'));
    const body = fn.slice(0, fn.indexOf('\n  }\n'));
    expect(body).toContain('project = null;');
    expect(body).toContain('forgetLastProject(company);');
    expect(body).toContain('composer?.reset();');
    expect(body).toContain("onopensession?.('');");
    expect(body).not.toContain('company =');
    // The id-less `sessions` route is the new-session route: a mount without
    // an id forgets the remembered project before the effect reads it.
    expect(PAGE).toContain('if (!sessionId) forgetLastProject(company);');
    expect(STARTWORK).toContain('export function forgetLastProject(company: string | null): void {');
    // The composer's reset empties text, images and every chip row.
    expect(COMPOSER).toContain('export function reset(): void {');
    const reset = COMPOSER.slice(COMPOSER.indexOf('export function reset(): void {'));
    const resetBody = reset.slice(0, reset.indexOf('\n  }\n'));
    for (const line of ["draft = '';", 'attached = [];', 'mentions = [];', 'contextChips = [];', 'commandToken = null;']) {
      expect(resetBody).toContain(line);
    }
  });

  it('the page loads projects and the skill catalog through the store, never a raw invoke', () => {
    expect(PAGE).not.toContain('invoke(');
    expect(PAGE).toContain('.hqCompanyProjects(wanted)');
    expect(PAGE).toContain('.hqSkillCatalog(wanted)');
    expect(STORE).toContain("invoke<ProjectEntry[]>('hq_company_projects'");
    expect(STORE).toContain("invoke<SkillCatalog>('hq_skill_catalog'");
    expect(MAIN_RS).toContain('commands::hq_context::hq_company_projects');
    expect(MAIN_RS).toContain('commands::hq_context::hq_skill_catalog');
    expect(HQ_CONTEXT_RS).toContain('pub async fn hq_company_projects(company: String)');
    expect(HQ_CONTEXT_RS).toContain('spawn_blocking');
  });

  it('the project pane is viewport-bounded and long descriptions cannot widen it', () => {
    expect(COMPOSER).toContain('width: clamp(320px, 68vw, 560px);');
    expect(COMPOSER).toContain('max-width: calc(100vw - 48px);');
    expect(PICKER).toContain('overflow: hidden;');
    expect(PICKER).toContain('text-overflow: ellipsis;');
  });

  it('the FIRST send atomically includes /startwork and the user text', () => {
    expect(planFirstSend('fix it', { company: 'indigo', project: null }, true)).toEqual([
      {
        text: '/startwork indigo\n\nfix it',
        hidden: false,
        label: '/startwork indigo',
        displayText: 'fix it',
      },
    ]);
    expect(planFirstSend('fix it', { company: 'indigo', project: 'x' }, true)[0]?.text).toBe(
      '/startwork indigo x\n\nfix it',
    );
    const fn = PAGE.slice(PAGE.indexOf('async function handleSend('));
    const body = fn.slice(0, fn.indexOf('\n  }\n'));
    // A setup chat is never oriented, so the page passes the effective flag.
    expect(body).toContain('planFirstSend(wire, { company, project }, startworkEnabled && !setupChat)');
    const planAt = body.indexOf('const first = planFirstSend(');
    const wordsAt = body.indexOf('started = await liveSessionStore.startAndSend(');
    const routeAt = body.indexOf('onopensession?.(started);', wordsAt);
    expect(planAt).toBeGreaterThan(-1);
    expect(wordsAt).toBeGreaterThan(planAt);
    expect(routeAt).toBeGreaterThan(wordsAt);
    expect(body).not.toContain('waitForTurnDone');
    expect(body).toContain('contextLabel: first.label');
    expect(COMPOSER).toContain('data-testid="session-orientation-preview"');
  });

  it('never double-sends and honours the opt-out toggle', () => {
    expect(planFirstSend('/startwork ridge', { company: 'indigo', project: null }, true)).toHaveLength(1);
    expect(planFirstSend('go', { company: 'indigo', project: null }, false)).toHaveLength(1);
    expect(COMPOSER).toContain('data-testid="session-menu-startwork-toggle"');
    expect(COMPOSER).toContain('Run /startwork on first message');
    expect(STARTWORK).toContain("export const STARTWORK_ENABLED_KEY = 'hq.sessions.startworkOnFirstMessage';");
    expect(PAGE).toContain('rememberStartworkEnabled(enabled);');
  });

  it('a hidden turn is a quiet system divider, live and after the backend echo', () => {
    expect(ADAPTER).toContain('const hidden = meta.hidden ?? (envelope ? false : isStartworkTurn(text));');
    expect(ADAPTER).toContain('const contextLabel = meta.contextLabel ?? envelope?.command;');
    expect(ADAPTER).toContain("type: 'divider',\n        id: `sys-${id}`,");
    expect(STORE).toContain('turnMeta: turnMetaById[entry.sessionId]');
    expect(STORE).toContain('function keepTurnMeta(');
    const state = foldSessionEvents(
      [{ kind: 'userMessage', text: '/startwork indigo', imageCount: 0 }],
      { turnMeta: { '/startwork indigo': { hidden: true, label: 'Starting work in indigo · project x' } } },
    );
    expect(state.blocks).toEqual([
      { type: 'divider', id: 'sys-ev-0', label: 'Starting work in indigo · project x', at: null },
    ]);
  });
});

describe('the `/` discovery picker replaces the flat list', () => {
  const SLASH = read('src/components/sessions/slash-commands.ts');
  const PICKER = read('src/components/sessions/SlashPicker.svelte');

  it('the composer mounts SlashPicker on a `/` draft and the flat popover is gone', () => {
    expect(COMPOSER).toContain("import SlashPicker from './SlashPicker.svelte'");
    expect(COMPOSER).toContain('<SlashPicker');
    expect(COMPOSER).toContain('const slashQuery = $derived(suppressed ? null : slashQueryAt(draft, caret));');
    expect(COMPOSER).not.toContain('class="slash-menu"');
    expect(COMPOSER).not.toContain('filterSlashCommands');
    // Keyboard drives the picker from the textarea.
    expect(COMPOSER).toContain('if (pickerOpen && slashPicker?.handleKey(event))');
    expect(PICKER).toContain('export function handleKey(event: KeyboardEvent): boolean');
  });

  it('shows only searchable Skills and Workers, defaulting to Skills with group and tag selectors', () => {
    expect(PICKER).toContain("type Tab = 'skills' | 'workers';");
    expect(PICKER).toContain("let tab = $state<Tab>('skills');");
    expect(PICKER).toContain('data-testid="session-slash-tab-skills"');
    expect(PICKER).toContain('data-testid="session-slash-tab-workers"');
    expect(PICKER).not.toContain('session-slash-tab-recent');
    expect(PICKER).not.toContain('session-slash-tab-cli');
    expect(PICKER).toContain('data-testid="session-slash-group"');
    expect(PICKER).toContain('data-testid="session-slash-tag-filter"');
    expect(PICKER).toContain('data-testid="session-slash-clear"');
    expect(SLASH).toContain('export function filterSkillRows(');
    expect(PICKER).toContain('data-testid="session-slash-more"');
    expect(SLASH).toContain('export const PICKER_PAGE = 8;');
  });

  it('a worker selects directly and its natural prompt serializes through /run', () => {
    expect(PICKER).not.toContain('session-slash-back');
    expect(SLASH).toContain("route: { kind: 'worker', workerId: worker.id, label: worker.name || worker.id }");
    expect(SLASH).toContain('return `/run ${route.workerId} -- ${text}`;');
    expect(COMPOSER).toContain("if (commandToken?.route.kind === 'worker' && !prompt) return;");
  });

  it('skill and worker rows leave distinct route pills while the draft stays natural language', () => {
    expect(PICKER).toContain("tab === 'skills' ? 'skill' : 'worker'");
    expect(PICKER).toContain("tab === 'skills' ? 'Skill' : 'Worker'");
    expect(COMPOSER).toContain('data-testid="session-command-chip"');
    expect(COMPOSER).toContain('data-testid="session-command-remove"');
    expect(COMPOSER).toContain('commandToken = { route: row.route, kind, label: row.route.label };');
    expect(COMPOSER).toContain("const text = commandToken ? serializeComposerRoute(commandToken.route, prompt) : prompt;");
    expect(COMPOSER).toContain('onsend?.(text, attached, chips, attachments);');
  });

  it('keeps manually typed slash commands without listing standalone CLI commands', () => {
    expect(COMPOSER).toContain('const slashQuery = $derived(suppressed ? null : slashQueryAt(draft, caret));');
    expect(COMPOSER).not.toContain('cliCommands={commands}');
    expect(COMPOSER).toContain('const text = commandToken ? serializeComposerRoute(commandToken.route, prompt) : prompt;');
  });

  it('the catalog is loaded once per company through the store', () => {
    expect(STORE).toContain('let skillCatalogCache: Map<string, Promise<SkillCatalog>> = new Map();');
    expect(PAGE).toContain('{catalog}');
  });
});

describe('context attachments — the `+` menu', () => {
  const MENU = read('src/components/sessions/ContextAttachMenu.svelte');
  const CONTEXT = read('src/components/sessions/context-attachments.ts');

  it('the + button opens the menu with Image, Meeting, Signal, Vault file and Paste path', () => {
    expect(COMPOSER).toContain("import ContextAttachMenu from './ContextAttachMenu.svelte'");
    expect(COMPOSER).toContain("toggleMenu('attach', event)");
    for (const id of [
      'session-attach-image',
      'session-attach-meeting',
      'session-attach-signal',
      'session-attach-vault',
      'session-attach-path',
    ]) {
      expect(MENU).toContain(id);
    }
    // Vault browsing has breadcrumbs and a search; signals group by kind.
    expect(MENU).toContain('data-testid="session-attach-crumb"');
    expect(MENU).toContain('data-testid="session-attach-search"');
    expect(MENU).toContain('data-testid="session-attach-signal-kind"');
    // Loaders come from the store — the menu and the composer never invoke.
    expect(MENU).not.toContain('invoke(');
    expect(COMPOSER).not.toContain('invoke(');
    expect(PAGE).toContain('context={liveSessionStore.contextLoaders}');
    expect(STORE).toContain("invoke<MeetingEntry[]>('hq_recent_meetings'");
    expect(STORE).toContain("invoke<SignalEntry[]>('hq_signals'");
    expect(STORE).toContain("invoke<VaultEntry[]>('hq_vault_files'");
    expect(STORE).toContain("invoke<ReferenceText>('hq_reference_text'");
  });

  it('chips share the mention row, are removable, and show the running size against the caps', () => {
    expect(COMPOSER).toContain('data-testid="session-context-chips"');
    expect(COMPOSER).toContain('data-testid="session-context-remove"');
    expect(COMPOSER).toContain('data-testid="session-context-size"');
    expect(COMPOSER).toContain('class="mention-chips" data-testid="session-context-chips"');
    expect(CONTEXT).toContain('export const MAX_ATTACHMENTS = 4;');
    expect(CONTEXT).toContain('export const MAX_CONTEXT_CHARS = 24_000;');
    expect(CONTEXT).toContain('export const ATTACHMENT_CHARS = 6_000;');
    expect(COMPOSER).toContain('readers.referenceText(attachment.path, ATTACHMENT_CHARS)');
  });

  it('the wire carries each chip as an hq-context block AFTER the text, and the bubble shows tags', () => {
    const wire = composeWithContext(
      'Summarise this',
      [
        {
          kind: 'meeting',
          title: 'Weekly sync',
          path: '/Users/x/HQ/companies/indigo/sources/meetings/x.md',
          text: 'notes',
          truncated: true,
        },
      ],
      '/Users/x/HQ',
    );
    expect(wire).toBe(
      'Summarise this\n\n<hq-context source="meeting" path="companies/indigo/sources/meetings/x.md" title="Weekly sync">\nnotes\n(truncated)\n</hq-context>',
    );
    expect(splitContextBlocks(wire)).toEqual({
      text: 'Summarise this',
      attachments: [{ kind: 'meeting', title: 'Weekly sync', path: 'companies/indigo/sources/meetings/x.md' }],
    });
    expect(PAGE).toContain("composeWithContext(text, context, preflight?.hqRoot ?? '')");
    expect(TRANSCRIPT).toContain('data-testid="session-user-attachment"');
    expect(TRANSCRIPT).toContain('Attached: {attachmentLabel(attachment)}');
    expect(ADAPTER).toContain('const split = splitContextBlocks(meta.displayText ?? envelope?.prompt ?? text);');
  });
});

describe('the "⋯" session menu — open in Claude Code / Codex, share to channel, end', () => {
  const MENU = read('src/components/sessions/SessionMenu.svelte');
  const DIALOG = read('src/components/sessions/ShareToChannelDialog.svelte');
  const SHARE = read('src/components/sessions/share-channel.ts');
  const EXTRA = read('src/desktop-alt/pages/SessionsExtraPage.svelte');

  it('the strip hosts the menu before "+", inert without a live session', () => {
    expect(STRIP).toContain("import SessionMenu from './SessionMenu.svelte';");
    expect(STRIP).toContain('disabled={!menuEnabled}');
    expect(STRIP.indexOf('<SessionMenu')).toBeLessThan(STRIP.indexOf('data-testid="sessions-new"'));
    expect(STRIP).toContain('data-testid="session-menu-result"');
    expect(PAGE).toContain('menuEnabled={Boolean(sessionId) && !ended}');
    expect(PAGE).toContain('tool={summary?.tool ?? tool}');
  });

  it('the menu is labelled by the session tool and offers exactly the three actions', () => {
    expect(MENU).toContain("tool === 'codex' ? 'Open in Codex' : 'Open in Claude Code'");
    expect(MENU).toContain('data-testid="session-menu-open-in-app"');
    expect(MENU).toContain('data-testid="session-menu-share"');
    expect(MENU).toContain('data-testid="session-menu-end"');
    expect(MENU).toContain('Share to channel…');
    expect(MENU).toContain('End session');
    expect(MENU).not.toContain('invoke(');
  });

  it('"Open in …" resumes through the store, which resolves the CLI-side id (Codex thread id) itself', () => {
    expect(STORE).toContain("'agent_session_open_in_app'");
    expect(STORE).toContain("'agent_session_cli_session_id'");
    // The started event's sessionId IS the CLI id (Claude init / Codex thread).
    expect(STORE).toContain("if (event.kind === 'started' && event.sessionId) return event.sessionId;");
    expect(STORE).toContain("if (tool === 'claude') return sessionId;");
    expect(PAGE).toContain('await liveSessionStore.openInApp()');
    expect(PAGE).toContain("'Opened in Terminal'");
    expect(PAGE).toContain('await liveSessionStore.end();');
  });

  it('the Rust side exposes the latched CLI id and Codex announces its thread id as Started.session_id', () => {
    const commands = read('src-tauri/src/commands/agent_session.rs');
    expect(commands).toContain('pub async fn agent_session_cli_session_id(session_id: String)');
    expect(commands).toContain('.map(|session| session.cli_session_id.clone())');
    expect(read('src-tauri/src/main.rs')).toContain(
      'commands::agent_session::agent_session_cli_session_id,',
    );
    expect(read('src-tauri/src/commands/agent_session/codex.rs')).toContain(
      'session_id: handshake.thread_id.clone(),',
    );
  });

  it('sharing is outward ONLY on the dialog’s confirm click; opening runs read-only loads', () => {
    expect(STORE).toContain("'session_share_to_channel'");
    expect(SHARE).toContain("'hq_share_to_channel_preflight'");
    expect(SHARE).toContain("'hq_company_projects'");
    // The mutating call lives in the confirm handler, never in an effect.
    expect(DIALOG).toContain('result = await liveSessionStore.shareToChannel(payload);');
    expect(DIALOG).toContain('onclick={() => void share()}');
    // Exactly one call site, and it is inside `share()`, not in any effect.
    expect(DIALOG.match(/liveSessionStore\.shareToChannel\(/g)).toHaveLength(1);
    const shareFn = DIALOG.slice(
      DIALOG.indexOf('async function share()'),
      DIALOG.indexOf('</script>'),
    );
    expect(shareFn).toContain('liveSessionStore.shareToChannel(payload)');
    expect(shareFn).not.toContain('$effect');
    expect(DIALOG).toContain('data-testid="share-confirm"');
    expect(DIALOG).toContain('data-testid="share-cancel"');
    expect(DIALOG).toContain('disabled={Boolean(blocker) || sharing || loading}');
    expect(PAGE).toContain('onshare={() => (shareOpen = true)}');
    expect(PAGE).toContain('{#if shareOpen && sessionId}');
  });

  it('the payload matches session_share_to_channel exactly', () => {
    expect(SHARE).toContain("| { kind: 'existing'; channelId: string }");
    expect(SHARE).toContain("| { kind: 'new'; name: string; projectPath?: string };");
    for (const field of ['sessionId: string', 'company: string', 'target: ShareTarget', 'inviteUids: string[]', 'includeTranscript: boolean', 'note?: string']) {
      expect(SHARE).toContain(field);
    }
    for (const field of ['channelId: string', 'channelName: string', 'created: boolean', 'invited: InviteOutcome[]', 'postedEventId?: string', 'digestChars: number']) {
      expect(SHARE).toContain(field);
    }
  });

  it('"open channel" after a share uses the shell’s own channel target', () => {
    expect(DIALOG).toContain('data-testid="share-open-channel"');
    expect(DIALOG).toContain('onopenchannel?.(result!.channelId)');
    expect(PAGE).toContain('onopenchannel?: (channelId: string) => void;');
    // HQ Work shell: the same `{ kind: 'channel' }` an hqwork://open?channel=
    // deep link resolves to in hq-work-host's routeTarget.
    expect(EXTRA).toContain("import { dispatchEmbeddedNavigation } from '@hq/ui';");
    expect(EXTRA).toContain("dispatchEmbeddedNavigation({ kind: 'channel', channelId })");
    expect(read('src/desktop-alt/hq-work-host.ts')).toContain("kind: 'channel',");
    // Classic shell: Messages, whose native shell has no open-by-id.
    expect(APP).toContain("onopenchannel={() => navigate({ kind: 'messages' })}");
  });
});

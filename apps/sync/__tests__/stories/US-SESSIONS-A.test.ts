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

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8');

const ROUTE = read('src/desktop-alt/route.ts');
const APP = read('src/desktop-alt/DesktopApp.svelte');
const PAGE = read('src/desktop-alt/pages/SessionsPage.svelte');
const STORE = read('src/desktop-alt/lib/live-session-store.svelte.ts');
const ADAPTER = read('src/components/sessions/transcript-adapter.ts');
const TRANSCRIPT = read('src/components/sessions/SessionTranscript.svelte');
const COMPOSER = read('src/components/sessions/SessionComposer.svelte');

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

  it('gates the palette entry on the inAppSessions flag (dev builds included)', () => {
    expect(APP).toContain('command-go-sessions');
    expect(APP).toContain('inAppSessions');
    expect(APP).toContain('inAppSessionsOn || import.meta.env.DEV');
    expect(APP).toContain('sessionsEnabled');
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

  it('keeps company / model / effort / permission as composer pills', () => {
    for (const testid of [
      'session-pill-company',
      'session-pill-model',
      'session-pill-effort',
      'session-pill-permission',
    ]) {
      expect(COMPOSER, `composer is missing the ${testid} pill`).toContain(testid);
    }
    expect(COMPOSER).toContain("placeholder = 'Do anything…'");
  });

  it('remembers the last company under the agreed localStorage key', () => {
    expect(read('src/components/sessions/session-models.ts')).toContain(
      "'hq.sessions.lastCompany'",
    );
    expect(PAGE).toContain('LAST_COMPANY_KEY');
  });

  it('names the exact remedy for each preflight blocker', () => {
    expect(PAGE).toContain('claude login');
    expect(PAGE).toContain('claudeAvailable');
    expect(PAGE).toContain('claudeLoggedIn');
    expect(PAGE).toContain('hooksReady');
    // One inline notice above the composer — not a screen that replaces it.
    expect(PAGE).toContain('{notice}');
    expect(COMPOSER).toContain('session-composer-notice');
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
      'agent_session_end',
      'agent_session_list',
      'agent_session_replay',
      'agent_session_slash_commands',
    ]) {
      expect(STORE, `store never invokes ${command}`).toContain(`'${command}'`);
    }
  });
});

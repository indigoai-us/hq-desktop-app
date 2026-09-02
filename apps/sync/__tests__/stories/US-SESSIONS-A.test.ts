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

describe('US-SESSIONS-A — the page composes its three panes', () => {
  it('imports the list panel, the transcript, and the composer', () => {
    expect(PAGE).toContain("import SessionListPanel from '../panels/SessionListPanel.svelte'");
    expect(PAGE).toContain(
      "import SessionTranscript from '../../components/sessions/SessionTranscript.svelte'",
    );
    expect(PAGE).toContain(
      "import SessionComposer from '../../components/sessions/SessionComposer.svelte'",
    );
    expect(PAGE).toContain(
      "import NewSessionPanel from '../../components/sessions/NewSessionPanel.svelte'",
    );
  });

  it('renders the pending cards through the transcript, above the composer', () => {
    const transcriptAt = PAGE.indexOf('<SessionTranscript');
    const composerAt = PAGE.indexOf('<SessionComposer');
    expect(transcriptAt).toBeGreaterThan(-1);
    expect(composerAt).toBeGreaterThan(transcriptAt);
    expect(read('src/components/sessions/SessionTranscript.svelte')).toContain('<PermissionCard');
    expect(read('src/components/sessions/SessionTranscript.svelte')).toContain('<QuestionCard');
  });

  it('drives every session action through the store, never a raw invoke', () => {
    expect(PAGE).not.toContain("invoke(");
    expect(PAGE).toContain('liveSessionStore.respondPermission');
    expect(PAGE).toContain('liveSessionStore.answerQuestion');
    expect(PAGE).toContain('liveSessionStore.interrupt');
    expect(PAGE).toContain('liveSessionStore.send');
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

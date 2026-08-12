// @vitest-environment happy-dom
//
// US-012 / US-018 — Mission Control retirement + Live Sessions panel truth.
//
// US-018 deleted MissionControlPage. Deep links remap to Home. Live session
// truth still lives in LiveSessionsPanel (mounted from remaining surfaces /
// tests). This file:
//   (a) locks the retirement + deep-link remap contracts, and
//   (b) mounts the REAL LiveSessionsPanel with a session fixture and asserts
//       poll-driven refresh via `sessions:updated` — no source-contract stub.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type {
  AgentSession,
  MissionControlSnapshot,
} from '../../src/desktop-alt/lib/sessions';
import { SESSIONS_UPDATED_EVENT } from '../../src/desktop-alt/lib/sessions';
import {
  fromV4Route,
  resolvePendingDesktopRoute,
} from '../../src/desktop-alt/route';

// ── Tauri bridge mocks ──────────────────────────────────────────────────────

let nextSnapshot: MissionControlSnapshot = { sessions: [], history: [] };
let updatedHandler: ((event: { payload: MissionControlSnapshot }) => void) | null = null;

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === 'list_agent_sessions') return nextSnapshot;
    return undefined;
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (event: string, handler: (e: { payload: MissionControlSnapshot }) => void) => {
      if (event === SESSIONS_UPDATED_EVENT) updatedHandler = handler;
      return () => {
        updatedHandler = null;
      };
    },
  ),
}));

// ── Fixtures ────────────────────────────────────────────────────────────────

const NOW = Date.parse('2026-06-15T18:00:00.000Z');
const root = process.cwd();

function session(overrides: Partial<AgentSession>): AgentSession {
  return {
    id: 'sess-default',
    tool: 'claude',
    origin: 'local',
    cwd: '/Users/dev/HQ/repos/public/hq-sync',
    project: 'hq-sync',
    company: 'indigo',
    model: 'claude-opus-4-8',
    status: 'running',
    startedAt: new Date(NOW - 60_000).toISOString(),
    lastActivityAt: new Date(NOW - 5_000).toISOString(),
    source: 'claude-jsonl',
    ...overrides,
  };
}

/** Two live LOCAL sessions — what the panel should list when it first opens. */
const INITIAL_SNAPSHOT: MissionControlSnapshot = {
  sessions: [
    session({
      id: 'sess-mission-control',
      project: 'mission-control',
      company: 'indigo',
      status: 'running',
      lastActivityAt: new Date(NOW - 2_000).toISOString(),
    }),
    session({
      id: 'sess-indigo-docs',
      project: 'indigo-docs',
      company: 'indigo',
      tool: 'codex',
      model: 'gpt-5-codex',
      status: 'awaiting_input',
      source: 'codex-rollout',
      lastActivityAt: new Date(NOW - 9_000).toISOString(),
    }),
  ],
  history: [],
};

/** A later poll snapshot that ADDS a third local session (a discover run). */
const POLLED_SNAPSHOT: MissionControlSnapshot = {
  sessions: [
    ...INITIAL_SNAPSHOT.sessions,
    session({
      id: 'sess-discover-liverecover',
      project: 'discover-liverecover',
      company: 'liverecover',
      status: 'running',
      source: 'claude-jsonl',
      lastActivityAt: new Date(NOW - 1_000).toISOString(),
    }),
  ],
  history: [],
};

// ── Harness ─────────────────────────────────────────────────────────────────

let host: HTMLElement;
let component: Record<string, unknown> | null = null;

/**
 * Mount the REAL Live Sessions panel into the live DOM and let the store's
 * async boot settle. Returns the mount host so tests can query the markup.
 */
async function mountLiveSessions(): Promise<HTMLElement> {
  const { default: LiveSessionsPanel } = await import(
    '../../src/desktop-alt/panels/LiveSessionsPanel.svelte'
  );
  const { stopSessionsStore } = await import(
    '../../src/desktop-alt/lib/sessions-store.svelte'
  );
  stopSessionsStore();

  component = mount(LiveSessionsPanel, { target: host });
  flushSync();
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
  return host;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  updatedHandler = null;
  nextSnapshot = { sessions: [], history: [] };
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  host?.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('US-018 — Mission Control page retired', () => {
  it('MissionControlPage no longer exists on disk', () => {
    expect(
      existsSync(join(root, 'src/desktop-alt/pages/MissionControlPage.svelte')),
    ).toBe(false);
  });

  it('mission-control deep links remap to home (never a dead route)', () => {
    expect(resolvePendingDesktopRoute('mission-control')).toEqual({ kind: 'home' });
    expect(resolvePendingDesktopRoute('  mission-control  ')).toEqual({ kind: 'home' });
    expect(fromV4Route({ kind: 'mission-control' })).toEqual({ kind: 'home' });
  });
});

describe('US-012 — Live Sessions panel E2E (real panel render + poll refresh)', () => {
  it('lists the live local sessions from the fixture when the panel opens', async () => {
    nextSnapshot = INITIAL_SNAPSHOT;
    const dom = await mountLiveSessions();

    // Panel chrome rendered (not a stub).
    expect(dom.querySelector('.ls-eyebrow')?.textContent).toMatch(/LIVE SESSIONS/i);

    // Dense rows from the fixture.
    const rowNames = Array.from(dom.querySelectorAll('.ls-name')).map((el) =>
      el.textContent?.trim(),
    );
    expect(rowNames).toContain('mission-control');
    expect(rowNames).toContain('indigo-docs');

    // Header count reflects the two local sessions.
    expect(dom.querySelector('.ls-count')?.textContent).toMatch(/2 across/);
  });

  it('adds a session on a poll tick — it appears with no manual refresh', async () => {
    nextSnapshot = INITIAL_SNAPSHOT;
    const dom = await mountLiveSessions();

    const namesBefore = Array.from(dom.querySelectorAll('.ls-name')).map((el) =>
      el.textContent?.trim(),
    );
    expect(namesBefore).not.toContain('discover-liverecover');
    expect(namesBefore).toHaveLength(2);

    // Backend polling loop emits `sessions:updated` with a fresh snapshot.
    expect(updatedHandler).toBeTypeOf('function');
    updatedHandler!({ payload: POLLED_SNAPSHOT });
    flushSync();

    const namesAfter = Array.from(dom.querySelectorAll('.ls-name')).map((el) =>
      el.textContent?.trim(),
    );
    expect(namesAfter).toContain('discover-liverecover');
    expect(namesAfter).toContain('mission-control');
    expect(namesAfter).toContain('indigo-docs');
    expect(namesAfter).toHaveLength(3);
    expect(dom.querySelector('.ls-count')?.textContent).toMatch(/3 across/);
  });
});

// @vitest-environment happy-dom
/**
 * The Sessions page, mounted for real, against the owner's bug.
 *
 * Switching the tool pill from Codex to Claude used to leave the model pill
 * holding the Codex model (`gpt-5.6-sol`), so the next session started with a
 * model Claude does not have and every turn failed with `model_not_found`.
 * The fix is per-tool memory plus validation on the send path itself; both
 * are asserted here through the rendered pills, localStorage and the spec the
 * page actually hands `agent_session_start`.
 *
 * The Tauri bridge is mocked at `invoke` / `listen`; everything else — the
 * store, the page, the composer, the strip, the transcript — is product code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

const invoke = vi.hoisted(() => vi.fn());
const handlers = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return Promise.resolve(() => handlers.delete(name));
  }),
}));

import { flushSync, mount, unmount } from 'svelte';
import SessionsPage from './SessionsPage.svelte';
import {
  resetLiveSessionStore,
  resetProbeCaches,
  type SessionSpec,
  type SessionSummary,
} from '../lib/live-session-store.svelte';
import type { SessionEvent } from '../../components/sessions/session-events';
import {
  LAST_EFFORT_KEY,
  LAST_MODEL_KEY,
  LAST_TOOL_KEY,
  lastEffortKey,
  lastModelKey,
  readRemembered,
  remember,
} from '../../components/sessions/session-models';
import {
  MODEL_NOT_FOUND_CODE,
  MODEL_NOT_FOUND_TEXT,
} from '../../components/sessions/transcript-adapter';

/** The real Claude handshake shape. */
const CLAUDE_CATALOG = [
  {
    value: 'default',
    displayName: 'Default (recommended)',
    description: 'Use the default model (currently Opus 5 (1M context))',
  },
  { value: 'opus[1m]', displayName: 'Opus (1M context)' },
  { value: 'claude-fable-5-1[1m]', displayName: 'Fable' },
  { value: 'sonnet', displayName: 'Sonnet' },
];

/** Codex's `model/list`, with the efforts its rows declare. */
const CODEX_CATALOG = [
  {
    value: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low' },
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
      { reasoningEffort: 'xhigh' },
    ],
  },
  { value: 'gpt-5.6-codex', displayName: 'GPT-5.6-Codex' },
];

const PREFLIGHT = {
  hqRoot: '/Users/x/HQ',
  hooksReady: true,
  hooksError: null,
  claudeAvailable: true,
  claudeLoggedIn: true,
  codexAvailable: true,
  codexLoggedIn: true,
  companies: [{ slug: 'indigo', displayName: 'indigo' }],
};

/** A promise the test resolves by hand — the Claude probe takes seconds. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

interface Backend {
  /** Every spec handed to `agent_session_start`. */
  starts: SessionSpec[];
  sends: { sessionId: string; text: string; overrides: unknown }[];
  list: SessionSummary[];
  replay: SessionEvent[];
  /** Hold the Claude catalog until the test releases it. */
  claudeCatalog: ReturnType<typeof deferred<{ commands: never[]; models: unknown[] }>> | null;
}

let backend: Backend;

function mockBackend() {
  backend = { starts: [], sends: [], list: [], replay: [], claudeCatalog: null };
  invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case 'agent_session_preflight':
        return Promise.resolve(PREFLIGHT);
      case 'agent_session_slash_commands': {
        if (args?.tool === 'codex') return Promise.resolve({ commands: [], models: CODEX_CATALOG });
        if (backend.claudeCatalog) return backend.claudeCatalog.promise;
        return Promise.resolve({ commands: [], models: CLAUDE_CATALOG });
      }
      case 'agent_session_list':
        return Promise.resolve(backend.list);
      case 'agent_session_replay':
        return Promise.resolve({
          events: backend.replay.map((event, seq) => ({ seq, receivedAtMs: 1_000 + seq, event })),
          nextSeq: backend.replay.length,
          truncated: false,
        });
      case 'agent_session_start': {
        const spec = args?.spec as SessionSpec;
        backend.starts.push(spec);
        return Promise.resolve({ sessionId: 'sess-1' });
      }
      case 'agent_session_send':
        backend.sends.push(args as Backend['sends'][number]);
        return Promise.resolve(undefined);
      case 'hq_skill_catalog':
        return Promise.resolve({ workers: [], skills: [] });
      case 'hq_company_projects':
      case 'session_mention_candidates':
        return Promise.resolve([]);
      default:
        return Promise.resolve(undefined);
    }
  });
}

let host: HTMLElement;
let component: Record<string, unknown> | null = null;

function render(props: Record<string, unknown> = {}) {
  component = mount(SessionsPage, { target: host, props }) as Record<string, unknown>;
  flushSync();
}

const at = (testid: string): HTMLElement | null =>
  host.querySelector(`[data-testid="${testid}"]`);
const must = (testid: string): HTMLElement => {
  const found = at(testid);
  if (!found) throw new Error(`missing [data-testid="${testid}"]`);
  return found;
};
const click = (element: HTMLElement) => {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  flushSync();
};
const text = (testid: string) => must(testid).textContent?.replace(/\s+/g, ' ').trim() ?? '';
/** A pill's face — the words, without the chevron glyph beside them. */
const pill = (testid: string) =>
  must(testid).querySelector('.pill-face')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

/** Pick a row of an open pill menu by its label. */
function pickMenuRow(menu: string, label: string) {
  const rows = [...must(menu).querySelectorAll<HTMLElement>('.menu-item')];
  const hit = rows.find((row) => row.textContent?.includes(label));
  if (!hit) throw new Error(`no "${label}" row in ${menu}`);
  click(hit);
}

function chooseTool(label: 'Claude' | 'Codex') {
  click(must('session-pill-tool'));
  pickMenuRow('session-menu-tool', label);
}

async function settle() {
  // Preflight, catalog, projects and skill catalog all land on microtasks;
  // effects settle after them.
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
  flushSync();
}

function send(message: string) {
  const input = must('session-composer-input') as HTMLTextAreaElement;
  input.value = message;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  click(must('session-composer-send'));
}

beforeEach(() => {
  localStorage.clear();
  handlers.clear();
  invoke.mockReset();
  resetLiveSessionStore();
  resetProbeCaches();
  mockBackend();
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host.remove();
  resetLiveSessionStore();
  resetProbeCaches();
});

describe('the model pill is per tool', () => {
  it('switching Codex → Claude drops the Codex model — and the spec sent is Default', async () => {
    remember(LAST_TOOL_KEY, 'codex');
    remember(lastModelKey('codex'), 'gpt-5.6-sol');
    remember(lastEffortKey('codex'), 'xhigh');
    // The Claude catalog probe is SLOW: the send below beats it.
    backend.claudeCatalog = deferred();

    render();
    await settle();
    expect(pill('session-pill-tool')).toContain('Codex');
    expect(pill('session-pill-model')).toBe('GPT-5.6-Sol');
    expect(pill('session-pill-effort')).toBe('Extra high');

    chooseTool('Claude');
    // Synchronously — before any catalog lands, before any send can read it.
    expect(pill('session-pill-tool')).toContain('Claude');
    expect(pill('session-pill-model')).not.toContain('GPT');
    expect(pill('session-pill-effort')).toBe('Auto');

    send('hello');
    await vi.waitFor(() => expect(backend.starts).toHaveLength(1));
    expect(backend.starts[0]).toMatchObject({ tool: 'claude', model: null, effort: null });

    // Codex's own memory is untouched; Claude simply has none.
    expect(readRemembered(lastModelKey('codex'))).toBe('gpt-5.6-sol');
    expect(readRemembered(lastModelKey('claude'))).toBeNull();
  });

  it('remembers each tool’s pick under its own key and restores it on the way back', async () => {
    remember(LAST_TOOL_KEY, 'codex');
    render();
    await settle();

    click(must('session-pill-model'));
    pickMenuRow('session-menu-model', 'GPT-5.6-Codex');
    expect(pill('session-pill-model')).toBe('GPT-5.6-Codex');
    expect(readRemembered(lastModelKey('codex'))).toBe('gpt-5.6-codex');
    expect(readRemembered(LAST_MODEL_KEY)).toBeNull();

    chooseTool('Claude');
    await settle();
    expect(pill('session-pill-model')).not.toContain('GPT');
    click(must('session-pill-model'));
    pickMenuRow('session-menu-model', 'Fable');
    expect(readRemembered(lastModelKey('claude'))).toBe('claude-fable-5-1[1m]');

    chooseTool('Codex');
    await settle();
    expect(pill('session-pill-model')).toBe('GPT-5.6-Codex');
    chooseTool('Claude');
    await settle();
    expect(pill('session-pill-model')).toBe('Fable 5.1');
  });

  it('migrates the old shared key once and resets it when it belongs to the other CLI', async () => {
    // A user upgrading from the shared key with a Codex model in it, on Claude.
    remember(LAST_TOOL_KEY, 'claude');
    remember(LAST_MODEL_KEY, 'gpt-5.6-sol');
    remember(LAST_EFFORT_KEY, 'xhigh');
    backend.claudeCatalog = deferred();

    render();
    await settle();
    expect(readRemembered(LAST_MODEL_KEY)).toBeNull();
    expect(readRemembered(LAST_EFFORT_KEY)).toBeNull();
    // Even before the catalog lands, `gpt-*` is not a Claude alias.
    expect(pill('session-pill-model')).not.toContain('GPT');
    expect(text('session-model-reset-note')).toBe('Model reset to Default for Claude');
    expect(readRemembered(lastModelKey('claude'))).toBeNull();
    expect(pill('session-pill-effort')).toBe('Auto');

    send('hello');
    await vi.waitFor(() => expect(backend.starts).toHaveLength(1));
    expect(backend.starts[0]).toMatchObject({ tool: 'claude', model: null, effort: null });
  });

  it('resets a remembered Claude model the catalog no longer offers, and says so', async () => {
    remember(LAST_TOOL_KEY, 'claude');
    remember(lastModelKey('claude'), 'claude-retired-3-0');

    render();
    await settle();
    expect(text('session-model-reset-note')).toBe('Model reset to Default for Claude');
    expect(readRemembered(lastModelKey('claude'))).toBeNull();

    // The next pick clears the note.
    click(must('session-pill-model'));
    pickMenuRow('session-menu-model', 'Sonnet');
    expect(at('session-model-reset-note')).toBeNull();
  });

  it('offers Codex the effort ladder its catalog declares', async () => {
    remember(LAST_TOOL_KEY, 'codex');
    render();
    await settle();
    click(must('session-pill-effort'));
    const labels = [...must('session-menu-effort').querySelectorAll('.menu-label')].map(
      (row) => row.textContent?.trim(),
    );
    expect(labels).toEqual(['Auto', 'Low', 'Medium', 'High', 'Extra high']);
  });
});

describe('a live session', () => {
  const failedTurn: SessionEvent[] = [
    {
      kind: 'started',
      sessionId: 'cli-1',
      tool: 'claude',
      model: 'gpt-5.6-sol',
      cwd: '/Users/x/HQ',
      tools: [],
      commands: [],
    },
    { kind: 'userMessage', text: 'hello', imageCount: 0 },
    {
      kind: 'assistantMessage',
      text: "There's an issue with the selected model (gpt-5.6-sol). Please check the model name and try again. (model_not_found)",
    },
    { kind: 'error', message: MODEL_NOT_FOUND_TEXT, code: MODEL_NOT_FOUND_CODE },
    {
      kind: 'turnDone',
      status: 'error',
      error: "There's an issue with the selected model (gpt-5.6-sol). Please check the model name and try again. (model_not_found)",
    },
  ];

  function liveClaude(model: string, phase: SessionSummary['phase'] = 'idle'): SessionSummary {
    return {
      sessionId: 'sess-1',
      tool: 'claude',
      phase,
      company: 'indigo',
      model,
      requestedModel: model,
      effort: null,
      permissionMode: 'prompt',
      cwd: '/Users/x/HQ',
      startedAt: '2026-09-02T00:00:00.000Z',
      lastActivityAt: '2026-09-02T00:00:00.000Z',
      lastSeq: 0,
      pendingCount: 0,
    };
  }

  it('renders model_not_found as ONE line whose button opens the model menu', async () => {
    backend.list = [liveClaude('gpt-5.6-sol')];
    backend.replay = failedTurn;
    render({ sessionId: 'sess-1' });
    await vi.waitFor(() => expect(at('session-inline-error')).not.toBeNull());

    expect(host.querySelectorAll('[data-testid="session-inline-error"]')).toHaveLength(1);
    expect(host.querySelectorAll('[data-testid="session-assistant-prose"]')).toHaveLength(0);
    expect(text('session-inline-error')).toContain(MODEL_NOT_FOUND_TEXT);
    expect(text('session-inline-error')).not.toContain('Turn failed');

    expect(at('session-menu-model')).toBeNull();
    click(must('session-choose-model'));
    expect(at('session-menu-model')).not.toBeNull();
  });

  it('never titles a Claude session with a GPT name, and drops the bad model from the pill', async () => {
    backend.list = [liveClaude('gpt-5.6-sol')];
    backend.replay = failedTurn;
    render({ sessionId: 'sess-1' });
    await vi.waitFor(() => expect(text('sessions-strip-title')).toContain('indigo'));
    await settle();

    expect(text('sessions-strip-title')).toBe('indigo · Claude');
    expect(pill('session-pill-model')).not.toContain('GPT');
    expect(text('session-model-reset-note')).toBe('Model reset to Default for Claude');
  });

  it('titles the session by the model the CLI announced, never the pill', async () => {
    backend.list = [liveClaude('sonnet')];
    backend.replay = [{ ...(failedTurn[0] as Extract<SessionEvent, { kind: 'started' }>), model: 'claude-opus-4-8' }];
    render({ sessionId: 'sess-1' });
    await vi.waitFor(() => expect(text('sessions-strip-title')).toBe('indigo · Opus 4.8'));
  });

  it('names only the tool until the CLI has announced a model', async () => {
    // The registry seeds `model` from the spec — the pill in disguise.
    backend.list = [liveClaude('gpt-5.6-sol', 'starting')];
    backend.replay = [];
    render({ sessionId: 'sess-1' });
    await vi.waitFor(() => expect(text('sessions-strip-title')).toBe('indigo · Claude'));
  });
});

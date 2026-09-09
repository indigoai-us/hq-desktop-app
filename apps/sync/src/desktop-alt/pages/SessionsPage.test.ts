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
  AGENT_SESSION_EVENT,
  resetLiveSessionStore,
  resetProbeCaches,
  type SessionSpec,
  type SessionSummary,
} from '../lib/live-session-store.svelte';
import type { SessionEvent } from '../../components/sessions/session-events';
import type { AgentSession } from '../lib/sessions';
import { stopSessionsStore } from '../lib/sessions-store.svelte';
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
import { liveSessionStore } from '../lib/live-session-store.svelte';

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

const GROK_CATALOG = [
  {
    value: 'grok-4.6',
    displayName: 'Grok 4.6',
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'],
  },
  { value: 'grok-4.5', displayName: 'Grok 4.5' },
];

const PREFLIGHT = {
  hqRoot: '/Users/x/HQ',
  hooksReady: true,
  hooksError: null,
  claudeAvailable: true,
  claudeLoggedIn: true,
  codexAvailable: true,
  codexLoggedIn: true,
  grokAvailable: true,
  grokLoggedIn: true,
  companies: [{ slug: 'indigo', displayName: 'indigo' }],
};

/** A promise the test resolves by hand — the Claude probe takes seconds. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

interface Backend {
  preflight: typeof PREFLIGHT;
  /** Every spec handed to `agent_session_start`. */
  starts: SessionSpec[];
  sends: { sessionId: string; text: string; overrides: unknown }[];
  list: SessionSummary[];
  replay: SessionEvent[];
  observed: AgentSession[];
  historyPage: { events: { receivedAtMs: number; event: SessionEvent }[]; before: number | null };
  /** Hold the Claude catalog until the test releases it. */
  claudeCatalog: ReturnType<typeof deferred<{ commands: never[]; models: unknown[] }>> | null;
  /** Hold the provider session catalog to expose routed-history loading races. */
  providerCatalog: ReturnType<typeof deferred<{
    sessions: AgentSession[];
    history: never[];
    outpost: null;
  }>> | null;
}

let backend: Backend;

function mockBackend() {
  backend = {
    preflight: { ...PREFLIGHT },
    starts: [], sends: [], list: [], replay: [], observed: [], claudeCatalog: null,
    providerCatalog: null,
    historyPage: { events: [], before: null },
  };
  invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case 'agent_session_preflight':
        return Promise.resolve(backend.preflight);
      case 'agent_session_slash_commands': {
        if (args?.tool === 'codex') return Promise.resolve({ commands: [], models: CODEX_CATALOG });
        if (args?.tool === 'grok') return Promise.resolve({ commands: [], models: GROK_CATALOG });
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
      case 'list_agent_sessions':
        if (backend.providerCatalog) return backend.providerCatalog.promise;
        return Promise.resolve({ sessions: backend.observed, history: [], outpost: null });
      case 'agent_session_history_page':
        return Promise.resolve(backend.historyPage);
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

function chooseTool(label: 'Claude' | 'Codex' | 'Grok') {
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
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({ matches: query.includes('prefers-reduced-motion'), media: query, addEventListener() {}, removeEventListener() {} } as unknown as MediaQueryList));
  localStorage.clear();
  handlers.clear();
  invoke.mockReset();
  resetLiveSessionStore();
  resetProbeCaches();
  stopSessionsStore();
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
  stopSessionsStore();
});

describe('provider readiness', () => {
  it('connects the selected provider and preserves the draft through verified sign-in', async () => {
    backend.preflight.codexLoggedIn = false;
    remember(LAST_TOOL_KEY, 'codex');
    const normalInvoke = invoke.getMockImplementation()!;
    invoke.mockImplementation((command, args) => command === 'agent_provider_login_start'
      ? Promise.resolve({ state: 'connected' }) : normalInvoke(command, args));
    render();
    await settle();
    const input = must('session-composer-input') as HTMLTextAreaElement;
    input.value = 'Keep this draft through login';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect((must('session-composer-send') as HTMLButtonElement).disabled).toBe(true);
    const connect = [...host.querySelectorAll('button')].find(button => button.textContent === 'Connect Codex')!;
    click(connect);
    await settle();
    expect(invoke).toHaveBeenCalledWith('agent_provider_login_start', { tool: 'codex' });
    expect(host.querySelector('[data-testid="provider-connect"]')).toBeNull();
    expect(input.value).toBe('Keep this draft through login');
    expect((must('session-composer-send') as HTMLButtonElement).disabled).toBe(false);
    click(must('session-composer-send'));
    await settle();
    expect(backend.starts).toHaveLength(1);
    expect(backend.starts[0].tool).toBe('codex');
  });
  it('starts Codex without Claude and updates the blocker on provider switch', async () => {
    backend.preflight.claudeAvailable = false;
    backend.preflight.claudeLoggedIn = false;
    remember(LAST_TOOL_KEY, 'codex');
    render();
    await settle();
    expect(host.textContent).not.toContain('Claude Code is not installed');
    chooseTool('Claude');
    await settle();
    expect(host.textContent).toContain('Install Claude');
    expect((must('session-composer-send') as HTMLButtonElement).disabled).toBe(true);
    chooseTool('Codex');
    await settle();
    send('provider readiness test');
    await settle();
    expect(backend.starts).toHaveLength(1);
    expect(backend.starts[0].tool).toBe('codex');
  });

  it('starts Grok without Claude and sends the Grok model id', async () => {
    backend.preflight.claudeAvailable = false;
    backend.preflight.claudeLoggedIn = false;
    remember(LAST_TOOL_KEY, 'grok');
    remember(lastModelKey('grok'), 'grok-4.6');
    render();
    await settle();
    expect(pill('session-pill-tool')).toBe('Grok');
    send('start grok');
    await settle();
    expect(backend.starts).toHaveLength(1);
    expect(backend.starts[0]).toMatchObject({ tool: 'grok', model: 'grok-4.6' });
  });

  it.each([
    ['grokAvailable', 'Install Grok'],
    ['grokLoggedIn', 'Connect Grok'],
  ] as const)('blocks Grok when %s is false', async (field, message) => {
    backend.preflight[field] = false;
    remember(LAST_TOOL_KEY, 'grok');
    render();
    await settle();
    expect(host.textContent).toContain(message);
    expect((must('session-composer-send') as HTMLButtonElement).disabled).toBe(true);
    expect(backend.starts).toHaveLength(0);
  });

  it.each([
    ['codexAvailable', 'Install Codex'],
    ['codexLoggedIn', 'Connect Codex'],
    ['hooksReady', 'HQ session hooks are not ready'],
  ] as const)('blocks Codex when %s is false', async (field, message) => {
    backend.preflight[field] = false;
    remember(LAST_TOOL_KEY, 'codex');
    render();
    await settle();
    expect(host.textContent).toContain(message);
    expect((must('session-composer-send') as HTMLButtonElement).disabled).toBe(true);
    expect(backend.starts).toHaveLength(0);
  });
});

describe('the model pill is per tool', () => {
  it('keeps catalog diagnostics out of the chat notice and offers a picker retry', async () => {
    remember(LAST_TOOL_KEY, 'claude');
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command, args) => command === 'agent_session_slash_commands'
      ? Promise.reject(new Error('Claude did not answer the command probe: Hard timeout exceeded'))
      : original(command, args));
    render();
    await settle();
    expect(at('session-composer-notice')).toBeNull();
    click(must('session-pill-model'));
    expect(text('session-menu-model')).toContain('Could not load models. Please retry.');
    expect(text('session-menu-model')).toContain('Refresh models');
    expect(host.textContent).not.toContain('Hard timeout');
  });
  it('reuses fresh provider catalogs after an explicit refresh', async () => {
    remember(LAST_TOOL_KEY, 'claude');
    render();
    await settle();
    click(must('session-pill-model'));
    click([...must('session-menu-model').querySelectorAll('button')].find(button => button.textContent?.includes('Refresh models'))!);
    await settle();
    click(must('session-pill-model'));
    chooseTool('Codex');
    await settle();
    chooseTool('Claude');
    await settle();
    expect(invoke.mock.calls.filter(([command, args]) => command === 'agent_session_slash_commands' && args?.tool === 'claude')).toHaveLength(2);
  });
  it('labels a pending catalog and exposes a live refresh without reopening the session', async () => {
    remember(LAST_TOOL_KEY, 'claude');
    backend.claudeCatalog = deferred();
    render();
    await settle();
    click(must('session-pill-model'));
    expect(text('session-menu-model')).toContain('Loading available models');
    backend.claudeCatalog.resolve({ commands: [], models: CLAUDE_CATALOG });
    await settle();
    expect(text('session-menu-model')).toContain('Fable');
    const before = invoke.mock.calls.filter(([cmd]) => cmd === 'agent_session_slash_commands').length;
    const refresh = [...must('session-menu-model').querySelectorAll('button')].find((button) => button.textContent?.includes('Refresh models'))!;
    click(refresh);
    await settle();
    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'agent_session_slash_commands')).toHaveLength(before + 1);
  });
  it.each(['codex', 'claude'] as const)('restores %s when last used provider differs, without forking the follow-up', async (tool) => {
    remember(LAST_TOOL_KEY, tool === 'codex' ? 'claude' : 'codex');
    const model = tool === 'codex' ? 'gpt-5.6-sol' : 'sonnet';
    backend.list = [{
      sessionId: 'restore-1', tool, phase: 'idle', company: 'indigo',
      model, requestedModel: model, effort: null, permissionMode: 'prompt',
      cwd: '/Users/x/HQ', startedAt: '2026-09-04T00:00:00Z',
      lastActivityAt: '2026-09-04T00:00:00Z', lastSeq: 0, pendingCount: 0,
    }];
    render({ sessionId: 'restore-1' });
    await vi.waitFor(() => expect(liveSessionStore.summary?.sessionId).toBe('restore-1'));
    await settle();
    expect(pill('session-pill-tool')).toBe(tool === 'codex' ? 'Codex' : 'Claude');
    send('Continue the same conversation');
    await settle();
    expect(backend.starts).toHaveLength(0);
    expect(backend.sends).toEqual([{sessionId: 'restore-1', text: 'Continue the same conversation', overrides: null, images: []}]);
  });

  it('ignores a slow catalog after switching back, then uses it for its own provider', async () => {
    remember(LAST_TOOL_KEY, 'codex');
    backend.claudeCatalog = deferred();
    render();
    await settle();
    chooseTool('Claude');
    chooseTool('Codex');
    await settle();
    backend.claudeCatalog.resolve({ commands: [], models: CLAUDE_CATALOG });
    await settle();
    click(must('session-pill-model'));
    expect(text('session-menu-model')).toContain('GPT');
    expect(text('session-menu-model')).not.toContain('Fable');
    click(must('session-pill-model'));
    chooseTool('Claude');
    await settle();
    click(must('session-pill-model'));
    expect(text('session-menu-model')).toContain('Fable');
    expect(text('session-menu-model')).not.toContain('GPT');
  });

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

    // The menu, not just the selected pill, must change while Claude is slow.
    click(must('session-pill-model'));
    expect(text('session-menu-model')).not.toContain('GPT');
    expect(text('session-menu-model')).toContain('Loading available models');
    expect(host.querySelector('[data-testid="session-menu-model-item"]')).toBeNull();
    click(must('session-pill-model'));

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

describe('first-message orientation', () => {
  it('sends orientation and user text atomically, presents them separately, and binds the route', async () => {
    remember(LAST_TOOL_KEY, 'codex');
    const onopensession = vi.fn();
    render({ onopensession });
    await settle();

    send('Show me the launch plan');
    await vi.waitFor(() => expect(backend.sends).toHaveLength(1));
    expect(backend.sends[0]).toMatchObject({
      sessionId: 'sess-1',
      text: '/startwork indigo\n\nShow me the launch plan',
    });
    await vi.waitFor(() => expect(host.textContent).toContain('/startwork indigo'));
    expect(host.textContent).toContain('Show me the launch plan');
    expect(backend.sends).toHaveLength(1);
    expect(onopensession).toHaveBeenCalledWith('sess-1');
    expect(at('session-composer-notice')).toBeNull();
  });

  it('keeps a project-channel route bound when the project is outside the picker feed', async () => {
    remember(LAST_TOOL_KEY, 'codex');
    render({ initialCompany: 'indigo', initialProject: 'hq-agent-workspace', initialChannelId: 'chn_workspace' });
    await settle();

    send('hi');

    await vi.waitFor(() => expect(backend.sends).toHaveLength(1));
    expect(backend.starts[0]).toMatchObject({
      company: 'indigo',
      project: 'hq-agent-workspace',
      projectChannelId: 'chn_workspace',
    });
    expect(invoke).toHaveBeenCalledWith('agent_session_start', expect.objectContaining({ projectChannelId: 'chn_workspace' }));
    expect(backend.sends[0]).toMatchObject({
      sessionId: 'sess-1',
      text: '/startwork indigo hq-agent-workspace\n\nhi',
    });
  });
});

describe('resuming history', () => {
  it('opens live replay without waiting for the global provider history scan', async () => {
    backend.providerCatalog = deferred();
    backend.list = [{
      sessionId: 'live-fast', tool: 'codex', company: 'indigo', title: 'Speed check',
      phase: 'idle', startedAt: '2026-09-04T21:55:44Z',
      model: 'gpt-5.6-sol', requestedModel: 'gpt-5.6-sol',
      permissionMode: 'prompt', pendingCount: 0,
      effort: null, cwd: '/hq', lastActivityAt: '2026-09-04T21:55:44Z', lastSeq: 0,
    }];
    backend.replay = [{ kind: 'assistantMessage', text: 'Startup verified.' }];
    render({ sessionId: 'live-fast' });
    await vi.waitFor(() => expect(host.textContent).toContain('Startup verified.'));
    expect(invoke).not.toHaveBeenCalledWith('agent_session_history_page', expect.anything());
  });

  it('hydrates a project-linked history route even when the provider catalog has not caught up', async () => {
    const nativeId = '01a069c3-31f3-74a0-ac6d-37d8f941b9d4';
    const linkedHistory = {
      id: nativeId,
      tool: 'codex' as const,
      origin: 'local' as const,
      title: 'hi',
      cwd: '',
      project: 'hq-agent-workspace',
      company: 'indigo',
      model: null,
      status: 'ended' as const,
      startedAt: '2026-09-03T20:13:15.000Z',
      lastActivityAt: '2026-09-03T20:13:15.000Z',
      source: 'project-session-link',
    };
    backend.observed = [];
    backend.providerCatalog = deferred();
    backend.historyPage = {
      events: [{ receivedAtMs: 1, event: { kind: 'assistantMessage', text: 'Durable linked history' } }],
      before: null,
    };

    render({ sessionId: nativeId, initialHistorySession: linkedHistory });

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('agent_session_history_page', {
      sessionId: nativeId,
      before: null,
      tool: 'codex',
    }));
    expect(invoke).not.toHaveBeenCalledWith('agent_session_replay', expect.anything());
    await vi.waitFor(() => expect(host.textContent).toContain('Durable linked history'));
    expect(host.textContent).toContain('hi');
  });

  it('explains when an ended provider session has no visible dialogue', async () => {
    const nativeId = '01a069c3-31f3-74a0-ac6d-37d8f941b9d4';
    backend.observed = [];
    backend.historyPage = { events: [], before: null };

    render({
      sessionId: nativeId,
      initialHistorySession: {
        id: nativeId,
        tool: 'codex',
        origin: 'local',
        title: 'test test',
        cwd: '',
        project: 'hq-agent-workspace',
        company: 'indigo',
        model: null,
        status: 'ended',
        startedAt: '2026-09-03T20:13:15.000Z',
        lastActivityAt: '2026-09-03T20:13:15.000Z',
        source: 'project-session-link',
      },
    });

    await vi.waitFor(() => expect(host.textContent).toContain(
      'This session ended before any visible messages were saved.',
    ));
  });

  it('hydrates a provider-history route instead of replaying it as an app-owned session', async () => {
    const nativeId = '01a06438-29a6-7481-91b0-98e16fbffe94';
    backend.observed = [{
      id: nativeId,
      tool: 'codex',
      origin: 'local',
      title: 'Project channel session',
      cwd: '/Users/x/HQ',
      project: 'agent-reply-targeting',
      company: 'indigo',
      model: 'gpt-5.6-sol',
      status: 'ended',
      startedAt: '2026-09-02T22:23:32.000Z',
      lastActivityAt: '2026-09-02T22:30:00.000Z',
      source: 'codex-rollout',
    }];
    backend.historyPage = {
      events: [{ receivedAtMs: 1, event: { kind: 'assistantMessage', text: 'Linked history loaded' } }],
      before: null,
    };

    render({ sessionId: nativeId });

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('agent_session_history_page', {
      sessionId: nativeId,
      before: null,
      tool: 'codex',
    }));
    expect(invoke.mock.calls.some(([command, args]) =>
      command === 'agent_session_replay' && args?.sessionId === nativeId,
    )).toBe(false);
    await vi.waitFor(() => expect(host.textContent).toContain('Linked history loaded'));
    expect(pill('session-pill-tool')).toContain('Codex');
  });

  it('opens history with its provider without starting a process', async () => {
    remember(LAST_TOOL_KEY, 'codex');
    remember(lastModelKey('codex'), 'gpt-5.6-sol');
    remember(lastEffortKey('codex'), 'high');
    backend.observed = [
      {
        id: 'claude-history-1',
        tool: 'claude',
        origin: 'local',
        title: 'Continue launch work',
        cwd: '/Users/x/HQ',
        project: 'HQ',
        company: 'indigo',
        model: 'claude-opus-5',
        status: 'ended',
        startedAt: '2026-09-02T12:00:00.000Z',
        lastActivityAt: '2026-09-02T13:00:00.000Z',
        source: 'claude-jsonl',
      },
    ];
    const onopensession = vi.fn();
    backend.historyPage = {
      events: [{ receivedAtMs: 1, event: { kind: 'assistantMessage', text: 'Previous answer' } }],
      before: null,
    };

    render({ onopensession });
    await settle();
    expect(pill('session-pill-tool')).toContain('Codex');

    click(must('sessions-drawer-toggle'));
    await vi.waitFor(() => expect(at('session-resume')).not.toBeNull());
    click(must('session-resume'));

    await vi.waitFor(() => expect(onopensession).toHaveBeenCalledWith('claude-history-1'));
    expect(backend.starts).toHaveLength(0);
    expect(invoke).toHaveBeenCalledWith('agent_session_history_page', {
      sessionId: 'claude-history-1',
      before: null,
      tool: 'claude',
    });
    expect(pill('session-pill-tool')).toContain('Claude');
    expect(readRemembered(LAST_TOOL_KEY)).toBe('claude');
  });

  it('opens a Codex history row directly and preserves its native task id', async () => {
    remember(LAST_TOOL_KEY, 'claude');
    remember(lastModelKey('claude'), 'sonnet');
    backend.observed = [
      {
        id: '01a0640a-0c86-7a31-baad-f9d5cbfd379a',
        tool: 'codex',
        origin: 'local',
        title: 'Build session history',
        cwd: '/Users/x/HQ',
        project: 'session-history',
        company: 'indigo',
        model: 'gpt-5.6-sol',
        status: 'ended',
        startedAt: '2026-09-02T17:32:55.000Z',
        lastActivityAt: '2026-09-02T19:32:07.000Z',
        source: 'codex-rollout',
      },
    ];

    const onopensession = vi.fn();
    render({ onopensession });
    await settle();
    click(must('sessions-drawer-toggle'));
    await vi.waitFor(() => expect(at('session-resume')).not.toBeNull());
    expect(must('session-list-panel').textContent).not.toContain('Live');
    expect(must('session-list-panel').textContent).not.toContain('History');
    expect(must('session-list-panel').textContent).not.toContain('Resume');
    expect(at('session-history-row')?.textContent).toContain('Build session history');
    expect(at('session-history-row')?.textContent).toContain('indigo');
    click(must('session-resume'));

    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('agent_session_history_page', {
      sessionId: '01a0640a-0c86-7a31-baad-f9d5cbfd379a',
      before: null,
      tool: 'codex',
    }));
    expect(backend.starts).toHaveLength(0);
    await vi.waitFor(() =>
      expect(onopensession).toHaveBeenCalledWith('01a0640a-0c86-7a31-baad-f9d5cbfd379a'),
    );
    expect(invoke).not.toHaveBeenCalledWith('agent_session_start', {
      spec: expect.objectContaining({
        resume: '01a0640a-0c86-7a31-baad-f9d5cbfd379a',
      }),
    });
    await vi.waitFor(() => expect(at('session-list-panel')).toBeNull());
    expect(pill('session-pill-tool')).toContain('Codex');
  });

  it('shows a resumed provider transcript only once in the unified list', async () => {
    const nativeId = '01a0640a-0c86-7a31-baad-f9d5cbfd379a';
    backend.list = [{
      sessionId: 'app-owned-1',
      title: 'Build session history',
      tool: 'codex',
      phase: 'idle',
      company: 'indigo',
      project: 'session-history',
      model: 'gpt-5.6-sol',
      requestedModel: null,
      effort: null,
      permissionMode: 'prompt',
      cwd: '/Users/x/HQ',
      startedAt: '2026-09-02T17:32:55.000Z',
      lastActivityAt: '2026-09-02T19:32:07.000Z',
      lastSeq: 0,
      pendingCount: 0,
      resumedFrom: nativeId,
    }];
    backend.observed = [{
      id: nativeId,
      tool: 'codex',
      origin: 'local',
      title: 'Build session history',
      cwd: '/Users/x/HQ',
      project: 'session-history',
      company: 'indigo',
      model: 'gpt-5.6-sol',
      status: 'ended',
      startedAt: '2026-09-02T17:32:55.000Z',
      lastActivityAt: '2026-09-02T19:32:07.000Z',
      source: 'codex-rollout',
    }];

    render({ sessionId: 'app-owned-1' });
    await settle();
    click(must('sessions-drawer-toggle'));
    await vi.waitFor(() => expect(at('session-live-row')).not.toBeNull());
    expect(host.querySelectorAll('[data-testid="session-live-row"]')).toHaveLength(1);
    expect(at('session-resume')).toBeNull();
  });
});

describe('a session whose replay carries a null or hostile payload', () => {
  // The owner's crash: opening the most recent session from history blanked
  // the whole desktop window with `null is not an object (evaluating
  // 'content.split')`. The page is mounted for real against exactly that page
  // of events and must render the conversation.
  function live(): SessionSummary {
    return {
      sessionId: 'sess-1',
      tool: 'claude',
      phase: 'idle',
      company: 'indigo',
      model: 'opus',
      requestedModel: 'opus',
      effort: null,
      permissionMode: 'prompt',
      cwd: '/Users/x/HQ',
      startedAt: '2026-09-02T00:00:00.000Z',
      lastActivityAt: '2026-09-02T00:00:00.000Z',
      lastSeq: 0,
      pendingCount: 0,
    };
  }

  it('renders the transcript around a toolResult whose content is null', async () => {
    backend.list = [live()];
    backend.replay = [
      { kind: 'started', sessionId: 'cli-1', tool: 'claude', model: 'opus', cwd: '/Users/x/HQ', tools: [], commands: [] },
      { kind: 'userMessage', text: 'list the repo', imageCount: 0 },
      { kind: 'toolCall', id: 'c1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'toolResult', id: 'c1', isError: false, content: null },
      { kind: 'assistantMessage', text: 'Two files.' },
      { kind: 'turnDone', status: 'success', error: null, sessionId: null },
    ];
    render({ sessionId: 'sess-1' });
    await vi.waitFor(() => expect(at('session-assistant-prose')).not.toBeNull());

    expect(text('session-user-bubble')).toBe('list the repo');
    expect(text('session-assistant-prose')).toContain('Two files.');
    expect(at('session-tool-group')).not.toBeNull();
    expect(at('session-divider')).toBeNull();
  });

  it('shows one quiet line for an event that cannot be displayed, and everything else', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const hostile = { kind: 'textDelta' } as unknown as SessionEvent;
      Object.defineProperty(hostile, 'text', {
        enumerable: true,
        get() {
          throw new Error('hostile payload');
        },
      });
      backend.list = [live()];
      backend.replay = [
        { kind: 'userMessage', text: 'hello', imageCount: 0 },
        { kind: 'assistantMessage', text: 'before' },
        hostile,
        { kind: 'assistantMessage', text: 'after' },
      ];
      render({ sessionId: 'sess-1' });
      await vi.waitFor(() => expect(at('session-divider')).not.toBeNull());

      const prose = [...host.querySelectorAll('[data-testid="session-assistant-prose"]')].map(
        (node) => node.textContent?.trim(),
      );
      expect(prose).toEqual(['before', 'after']);
      expect(host.querySelectorAll('[data-testid="session-divider"]')).toHaveLength(1);
      expect(text('session-divider')).toBe('1 event could not be displayed (textDelta)');
      expect(at('session-inline-error')).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the page up even if the store’s transcript read itself throws', async () => {
    // Belt to the store's braces: a throw from the transcript getter must not
    // reach the shell's error boundary through the page's `$derived`.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const original = Object.getOwnPropertyDescriptor(liveSessionStore, 'transcript')!;
    try {
      backend.list = [live()];
      backend.replay = [{ kind: 'userMessage', text: 'hello', imageCount: 0 }];
      Object.defineProperty(liveSessionStore, 'transcript', {
        configurable: true,
        get() {
          throw new Error('store exploded');
        },
      });
      expect(() => render({ sessionId: 'sess-1' })).not.toThrow();
      await settle();
      expect(at('session-composer-input')).not.toBeNull();
      expect(error).toHaveBeenCalled();
    } finally {
      Object.defineProperty(liveSessionStore, 'transcript', original);
      error.mockRestore();
    }
  });
});


describe('durable session context', () => {
  it('restores inherited messages and starter after the store is discarded', async () => {
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation((command, args) => command === 'agent_session_context'
      ? Promise.resolve({ sourceSessionId: 'parent', sourceTitle: 'Original project discussion', startedBy: 'alex@example.test',
          history: { before: null, events: [{ receivedAtMs: 1000, event: { kind: 'userMessage', text: 'Inherited planning context', imageCount: 0 } }] } })
      : original(command, args));
    backend.observed = [{ id: 'child', title: 'Follow-up', tool: 'codex', origin: 'local', cwd: '/HQ', company: 'indigo', project: '', model: '', status: 'ended', startedAt: '', lastActivityAt: '', source: 'codex-rollout' }];
    backend.historyPage = { before: null, events: [{ receivedAtMs: 2000, event: { kind: 'assistantMessage', text: 'Child reply', parentToolUseId: null } }] };
    render({ sessionId: 'child', initialHistorySession: backend.observed[0] });
    await settle(); await settle();
    expect(host.textContent).toContain('Inherited planning context');
    expect(host.textContent).toContain('Child reply');
    expect(host.querySelector('[data-testid="session-starter"]')?.getAttribute('aria-label')).toBe('Started by alex@example.test');
    expect(host.querySelector('[data-testid="session-source"]')?.getAttribute('aria-label')).toContain('Original project discussion');
    await unmount(component!); component = null; resetLiveSessionStore();
    render({ sessionId: 'child', initialHistorySession: backend.observed[0] });
    await settle(); await settle();
    expect(host.textContent).toContain('Inherited planning context');
    expect(host.textContent).toContain('Child reply');
  });
});

// @vitest-environment happy-dom
import { mount, unmount, tick } from 'svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import BotBrainHost from './BotBrainHost.svelte';

let component: ReturnType<typeof mount> | undefined;
let target: HTMLElement;
const settle = async () => { for (let i = 0; i < 20; i++) { await tick(); await Promise.resolve(); } };
beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(async () => { if (component) await unmount(component); component = undefined; target?.remove(); vi.useRealTimers(); });

type Reply = { status: number; body: unknown };
const model = (id: string, efforts: string[], extra: Record<string, unknown> = {}) => ({ id, label: id.toUpperCase(), authModes: ['subscription'], efforts, selectable: true, visibility: 'shown', isNew: false, ...extra });
const CATALOG = {
  generatedAt: '2026-10-21T00:00:00.000Z',
  providers: {
    codex: { defaultModel: 'gpt-6-sol', models: [
      model('gpt-6.1-sol', ['low', 'medium', 'high', 'xhigh'], { label: 'GPT-6.1 Sol', isNew: true }),
      model('gpt-6-sol', ['minimal', 'low', 'medium', 'high', 'xhigh'], { label: 'GPT-6 Sol' }),
      model('gpt-6-astra', ['low', 'medium', 'high'], { label: 'GPT-6 Astra' }),
      model('gpt-5.5', ['low', 'medium', 'high'], { label: 'GPT-5.5', visibility: 'legacy' }),
      model('gpt-5.4', ['low', 'medium', 'high'], { label: 'GPT-5.4', selectable: false }),
      model('gpt-6-preview', ['medium'], { visibility: 'hidden' }),
      model('gpt-6-api', ['medium'], { authModes: ['apiKey'] }),
    ] },
    claude: { defaultModel: 'claude-opus-5-5', models: [
      model('claude-opus-5-5', ['low', 'medium', 'high', 'xhigh', 'max'], { label: 'Opus 5.5' }),
      model('claude-sonnet-5', ['low', 'medium', 'high'], { label: 'Sonnet 5' }),
    ] },
    grok: { defaultModel: 'grok-4.7', models: [model('grok-4.7', ['low', 'medium', 'high'], { label: 'Grok 4.7' })] },
  },
};
function profile(provider: string, model: string, logins: string[]) {
  return { ok: true, value: { agent: { uid: 'agt_a', provider: 'agents-v2' }, box: {}, brain: { provider, model, reasoningEffort: 'medium', logins: logins.map(p => ({ provider: p, status: 'authorized' })) } } };
}
async function setup(options: { logins?: string[]; catalog?: Reply | 'throw'; provider?: string; model?: string; onFetch?: (path: string, init: RequestInit | undefined) => Reply } = {}) {
  target = document.createElement('div'); target.className = 'desktop-shell'; document.body.appendChild(target);
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const state = { provider: options.provider ?? 'claude', model: options.model ?? 'claude-opus-5-5', switch: null as Record<string, unknown> | null };
  const onFetch = options.onFetch ?? ((path: string, init: RequestInit | undefined) => {
    if (path === '/v1/agents/models') return options.catalog === 'throw' ? (() => { throw new Error('offline'); })() : options.catalog ?? { status: 200, body: CATALOG };
    if (path.endsWith('/runtime-config') && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body));
      state.model = body.codexModel;
      return { status: 200, body: { uid: 'agt_a', codexModel: body.codexModel, codexReasoningEffort: body.codexReasoningEffort, applied: true } };
    }
    if (path.endsWith('/brain-switch') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      state.switch = { switchId: 'sw-1', status: 'running', step: 'import', from: 'claude', to: body.brain, model: body.model, reasoningEffort: body.reasoningEffort ?? 'high', code: null, error: null };
      return { status: 202, body: { uid: 'agt_a', switch: state.switch } };
    }
    if (path.endsWith('/brain-switch')) return { status: 200, body: { uid: 'agt_a', switch: state.switch } };
    return { status: 404, body: {} };
  });
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    let body: unknown = null;
    try { body = init?.body ? JSON.parse(String(init.body)) : null; } catch { body = init?.body; }
    calls.push({ path, method: init?.method ?? 'GET', body });
    const reply = onFetch(path, init);
    return { status: reply.status, text: async () => JSON.stringify(reply.body) };
  });
  const adapter = {
    bots: { list: vi.fn(async () => ({ ok: true, value: { bots: [] } })), configure: vi.fn() },
    sessions: { loginStatus: vi.fn(async () => ({ ok: true, value: { state: 'connected' } })), loginStart: vi.fn() },
    agents: {
      getProfile: vi.fn(async () => profile(state.provider, state.model, options.logins ?? ['claude', 'codex'])),
      restartBrainApproval: vi.fn(),
      getStatus: vi.fn(async () => ({ ok: true, value: {} })),
      fetch,
    },
  };
  component = mount(BotBrainHost, { target, props: { uid: 'agt_a', name: 'Shawon’s HQ bot', runtimeKind: 'cloud', adapter: adapter as never, onopenurl: vi.fn() } });
  await settle();
  return { adapter, calls, state, fetch };
}
function buttons() { const dialog = target.querySelector('[role="dialog"]'); return [...(dialog ?? target).querySelectorAll('button')]; }
function button(text: string) { return buttons().find(b => b.textContent?.trim() === text); }
async function click(text: string) { const b = button(text); expect(b, text).toBeTruthy(); b!.click(); await settle(); }
async function openRow(id: string) { target.querySelector<HTMLButtonElement>(`[data-testid="brain-${id}"] button`)!.click(); await settle(); }
async function choices(label: string) {
  const trigger = target.querySelector<HTMLButtonElement>(`[aria-label^="${label}:"]`)!;
  trigger.click(); await settle();
  const values = [...target.querySelectorAll<HTMLElement>('[role="option"]')].map(option => option.dataset.value);
  target.querySelector<HTMLElement>(`[role="option"][data-value="${trigger.getAttribute('data-value')}"]`)!.click(); await settle();
  return values;
}
async function pick(label: string, value: string) {
  target.querySelector<HTMLButtonElement>(`[aria-label^="${label}:"]`)!.click(); await settle();
  target.querySelector<HTMLElement>(`[role="option"][data-value="${value}"]`)!.click(); await settle();
}

it('offers Use this brain for a connected brain that is not in use, and no model box for it until then', async () => {
  await setup();
  expect(target.querySelector('[data-testid="brain-codex"] button')?.textContent).toContain('Use this brain');
  expect(target.querySelector('[data-testid="brain-claude"] button')?.textContent).toContain('Configure');
  expect(target.querySelector('[data-testid="brain-grok"] button')?.textContent).toContain('View setup');
  expect(target.textContent).not.toContain('separate runtime migration');
  await openRow('codex');
  expect(target.querySelector('[data-testid="brain-switch-form"]')).toBeTruthy();
  expect(target.querySelector('fieldset')?.disabled).toBe(false);
  expect(target.querySelector('[aria-label^="Model:"]')?.getAttribute('data-value')).toBe('gpt-6-sol');
  expect(button('Use this brain')).toBeTruthy();
  expect(button('Switch')).toBeUndefined();
});

it('shows model and thinking level only for the brain in use', async () => {
  await setup({ logins: ['claude'] });
  await openRow('grok');
  expect(target.querySelector('fieldset')).toBeNull();
  expect(target.querySelector('[aria-label^="Model:"]')).toBeNull();
  expect(button('Connect Grok')).toBeTruthy();
  await click('Connect Grok').catch(() => undefined);
});

it('confirms in place, starts the switch with the chosen model and thinking level, then reports the new brain', async () => {
  const { calls, state } = await setup();
  await openRow('codex');
  await pick('Model', 'gpt-6.1-sol');
  await pick('Thinking level', 'low');
  await click('Use this brain');
  expect(target.textContent).toContain('Switch this bot to OpenAI? It restarts and answers a test message first. Claude stays signed in.');
  expect(calls.filter(c => c.method === 'POST')).toHaveLength(0);
  await click('Cancel');
  expect(button('Use this brain')).toBeTruthy();
  await click('Use this brain');
  await click('Switch');
  expect(calls.filter(c => c.method === 'POST')).toEqual([{ path: '/v1/agents/agt_a/brain-switch', method: 'POST', body: { brain: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' } }]);
  expect(target.querySelector('[role="dialog"]')).toBeNull();
  expect(target.querySelector('[data-testid="brain-switching"]')?.textContent).toContain('Switching to OpenAI…');
  state.switch = { ...state.switch!, status: 'waiting', step: 'waiting-for-idle' };
  await vi.advanceTimersByTimeAsync(3100); await settle();
  expect(target.querySelector('[data-testid="brain-switching"]')?.textContent).toContain('once the bot finishes its current reply');
  state.switch = { ...state.switch!, status: 'done', step: 'test' };
  state.provider = 'codex'; state.model = 'gpt-6.1-sol';
  await vi.advanceTimersByTimeAsync(3100); await settle();
  expect(target.querySelector('[data-testid="brain-switching"]')).toBeNull();
  expect(target.textContent).toContain('Now using OpenAI. The bot answered a test message on it.');
  expect(target.querySelector('[data-testid="brain-codex"] button')?.textContent).toContain('Configure');
  expect(target.querySelector('[data-testid="brain-claude"] button')?.textContent).toContain('Use this brain');
});

it('stops waiting after repeated failed status checks and says to refresh', async () => {
  let started = false;
  const { calls } = await setup({ onFetch: (path, init) => {
    if (path.endsWith('/brain-switch') && init?.method === 'POST') { started = true; return { status: 202, body: { uid: 'agt_a', switch: { switchId: 'sw-1', status: 'running', step: 'import', from: 'claude', to: 'codex', model: 'gpt-6-astra', startedAt: new Date().toISOString() } } }; }
    if (path.endsWith('/brain-switch')) return started ? { status: 500, body: { error: 'upstream stack trace' } } : { status: 200, body: { uid: 'agt_a', switch: null } };
    return { status: 404, body: {} };
  } });
  await openRow('codex');
  await click('Use this brain');
  await click('Switch');
  expect(target.querySelector('[data-testid="brain-switching"]')).toBeTruthy();
  for (let i = 0; i < 4; i++) { await vi.advanceTimersByTimeAsync(3100); await settle(); }
  expect(target.querySelector('[data-testid="brain-switching"]')).toBeTruthy();
  await vi.advanceTimersByTimeAsync(3100); await settle();
  expect(target.querySelector('[data-testid="brain-switching"]')).toBeNull();
  expect(target.textContent).toContain('Could not confirm whether the switch finished. Refresh to see which brain the bot is using.');
  expect(target.textContent).not.toContain('upstream stack trace');
  const polls = calls.filter(c => c.method === 'GET' && c.path.endsWith('/brain-switch')).length;
  await vi.advanceTimersByTimeAsync(10_000); await settle();
  expect(calls.filter(c => c.method === 'GET' && c.path.endsWith('/brain-switch')).length).toBe(polls);
});

it('stops waiting when a switch has been running longer than the time limit', async () => {
  const startedAt = new Date(Date.now() - 21 * 60_000).toISOString();
  const longRunning = { switchId: 'sw-1', status: 'running', step: 'apply', from: 'claude', to: 'codex', model: 'gpt-6-astra', startedAt };
  let started = false;
  await setup({ onFetch: (path, init) => {
    if (path.endsWith('/brain-switch') && init?.method === 'POST') { started = true; return { status: 202, body: { uid: 'agt_a', switch: longRunning } }; }
    if (path.endsWith('/brain-switch')) return { status: 200, body: { uid: 'agt_a', switch: started ? longRunning : null } };
    return { status: 404, body: {} };
  } });
  await openRow('codex');
  await click('Use this brain');
  await click('Switch');
  await vi.advanceTimersByTimeAsync(3100); await settle();
  expect(target.querySelector('[data-testid="brain-switching"]')).toBeNull();
  expect(target.textContent).toContain('Could not confirm whether the switch finished.');
});

it('shows a switch that is already running when the tab opens, and blocks a second start until it ends', async () => {
  const { state } = await setup({ onFetch: (path, init) => {
    if (path.endsWith('/brain-switch') && init?.method === 'POST') return { status: 409, body: { code: 'BRAIN_SWITCH_IN_PROGRESS' } };
    if (path.endsWith('/brain-switch')) return { status: 200, body: { uid: 'agt_a', switch: state.switch } };
    return { status: 404, body: {} };
  } });
  expect(target.querySelector('[data-testid="brain-switching"]')).toBeNull();
  state.switch = { switchId: 'sw-9', status: 'waiting', step: 'waiting-for-idle', from: 'claude', to: 'codex', model: 'gpt-6-astra', startedAt: new Date().toISOString() };
  target.querySelector<HTMLButtonElement>('[aria-label="Refresh brain"]')!.click(); await settle();
  expect(target.querySelector('[data-testid="brain-switching"]')?.textContent).toContain('Switching to OpenAI once the bot finishes its current reply');
  await openRow('codex');
  expect(button('Use this brain')?.disabled).toBe(true);
  await click('Cancel');
  state.switch = { ...state.switch, status: 'done', step: 'test', finishedAt: new Date().toISOString() };
  state.provider = 'codex'; state.model = 'gpt-6-astra';
  await vi.advanceTimersByTimeAsync(3100); await settle();
  expect(target.querySelector('[data-testid="brain-switching"]')).toBeNull();
  expect(target.textContent).toContain('Now using OpenAI. The bot answered a test message on it.');
  expect(target.querySelector('[data-testid="brain-codex"] button')?.textContent).toContain('Configure');
});

it('shows how a recent switch ended when the tab opens, but not an old one, and never internal text', async () => {
  const recent = { switchId: 'sw-2', status: 'rolled-back', step: 'rollback', from: 'claude', to: 'codex', model: 'gpt-6-astra', code: 'TEST_REPLY_FAILED', error: 'OpenAI did not answer a test message. The bot is back on Claude.', startedAt: new Date(Date.now() - 300_000).toISOString(), finishedAt: new Date(Date.now() - 60_000).toISOString() };
  await setup({ onFetch: path => path.endsWith('/brain-switch') ? { status: 200, body: { uid: 'agt_a', switch: recent } } : { status: 404, body: {} } });
  expect(target.textContent).toContain('OpenAI did not answer a test message. The bot is back on Claude.');
  expect(target.querySelector('[data-testid="brain-switching"]')).toBeNull();
  await unmount(component!); component = undefined; target.remove();

  const old = { ...recent, finishedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString() };
  await setup({ onFetch: path => path.endsWith('/brain-switch') ? { status: 200, body: { uid: 'agt_a', switch: old } } : { status: 404, body: {} } });
  expect(target.textContent).not.toContain('did not answer a test message');
  await unmount(component!); component = undefined; target.remove();

  const leaky = { ...recent, error: 'TypeError: Cannot read properties of undefined\n    at /var/task/index.js:12:3' };
  await setup({ onFetch: path => path.endsWith('/brain-switch') ? { status: 200, body: { uid: 'agt_a', switch: leaky } } : { status: 404, body: {} } });
  expect(target.textContent).toContain('The switch to OpenAI did not work. The bot is back on its previous brain.');
  expect(target.textContent).not.toContain('TypeError');
  expect(target.textContent).not.toContain('/var/task');
});

it('leaves the thinking level to the brain default when none is chosen', async () => {
  const { calls } = await setup();
  await openRow('codex');
  await click('Use this brain');
  await click('Switch');
  expect(calls.filter(c => c.method === 'POST')[0]?.body).toEqual({ brain: 'codex', model: 'gpt-6-sol' });
});

it('shows the plain reason when the switch rolls back, without exposing anything else', async () => {
  const { state } = await setup();
  await openRow('codex');
  await click('Use this brain');
  await click('Switch');
  state.switch = { ...state.switch!, status: 'rolled-back', step: 'rollback', code: 'TEST_REPLY_FAILED', error: 'OpenAI did not answer a test message. The bot is back on Claude.' };
  await vi.advanceTimersByTimeAsync(3100); await settle();
  expect(target.textContent).toContain('OpenAI did not answer a test message. The bot is back on Claude.');
  expect(target.textContent).not.toContain('TEST_REPLY_FAILED');
  expect(target.querySelector('[data-testid="brain-claude"] button')?.textContent).toContain('Configure');
});

it('explains a refused switch inside the dialog and never echoes the response body', async () => {
  const { calls } = await setup({ onFetch: () => ({ status: 403, body: { error: 'private upstream detail', code: 'FORBIDDEN' } }) });
  await openRow('codex');
  await click('Use this brain');
  await click('Switch');
  expect(target.querySelector('[role="alert"]')?.textContent).toContain('does not have permission to switch');
  expect(target.textContent).not.toContain('private upstream detail');
  expect(target.querySelector('[role="dialog"]')).toBeTruthy();
  expect(calls.filter(c => c.method === 'POST')).toHaveLength(1);
});

it('says when a switch is already running or switching is turned off', async () => {
  let reply: Reply = { status: 409, body: { code: 'BRAIN_SWITCH_IN_PROGRESS' } };
  await setup({ onFetch: () => reply });
  await openRow('codex');
  await click('Use this brain');
  await click('Switch');
  expect(target.querySelector('[role="alert"]')?.textContent).toContain('already running');
  reply = { status: 409, body: { code: 'BRAIN_SWITCH_DISABLED' } };
  await click('Use this brain');
  await click('Switch');
  expect(target.querySelector('[role="alert"]')?.textContent).toContain('turned off right now');
});

it('keeps the migration note and no switch for a cloud bot that is not on the multi-brain runtime', async () => {
  const { adapter } = await setup();
  adapter.agents.getProfile.mockResolvedValue({ ok: true, value: { agent: { uid: 'agt_a' }, box: {}, brain: { provider: 'claude', model: 'claude-opus-5-5', logins: [{ provider: 'claude', status: 'authorized' }, { provider: 'codex', status: 'authorized' }] } } } as never);
  target.querySelector<HTMLButtonElement>('[aria-label="Refresh brain"]')!.click(); await settle();
  expect(target.querySelector('[data-testid="brain-codex"] button')?.textContent).toContain('View');
  await openRow('codex');
  expect(target.textContent).toContain('separate runtime migration');
  expect(target.querySelector('[data-testid="brain-switch-form"]')).toBeNull();
  expect(target.querySelector('fieldset')).toBeNull();
});

it('offers only the live catalog models a subscription can select when switching, with each model’s thinking levels', async () => {
  const { calls } = await setup();
  expect(calls.filter(c => c.path === '/v1/agents/models')).toEqual([{ path: '/v1/agents/models', method: 'GET', body: null }]);
  await openRow('codex');
  expect(await choices('Model')).toEqual(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra']);
  expect(target.querySelector('[aria-label^="Model:"]')?.getAttribute('data-value')).toBe('gpt-6-sol');
  expect(await choices('Thinking level')).toEqual(['', 'minimal', 'low', 'medium', 'high', 'xhigh']);
  await pick('Thinking level', 'minimal');
  await pick('Model', 'gpt-6-astra');
  expect(target.querySelector('[aria-label^="Thinking level:"]')?.getAttribute('data-value')).toBe('');
  expect(await choices('Thinking level')).toEqual(['', 'low', 'medium', 'high']);
  await pick('Thinking level', 'high');
  await click('Use this brain');
  await click('Switch');
  expect(calls.filter(c => c.method === 'POST')[0]?.body).toEqual({ brain: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' });
});

it('configures the current brain from the live catalog and moves a bot off a legacy model', async () => {
  const { calls } = await setup({ provider: 'codex', model: 'gpt-5.5', logins: ['codex'] });
  expect(target.querySelector('[data-testid="brain-codex"] button')?.textContent).toContain('Configure');
  await openRow('codex');
  expect(target.querySelector('[data-testid="brain-switch-form"]')).toBeNull();
  expect(await choices('Model')).toEqual(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra']);
  expect(target.querySelector('[aria-label^="Model:"]')?.getAttribute('data-value')).toBe('gpt-6-sol');
  expect(button('Save configuration')?.disabled).toBe(false);
  await click('Save configuration');
  expect(calls.filter(c => c.method === 'PATCH')).toEqual([{ path: '/v1/agents/agt_a/runtime-config', method: 'PATCH', body: { codexModel: 'gpt-6-sol', codexReasoningEffort: 'medium' } }]);
  expect(target.textContent).toContain('Configuration saved for future messages.');
});

it('keeps a current catalog model selected in the Configure form and lists only catalog models', async () => {
  await setup();
  await openRow('claude');
  expect(target.querySelector('[aria-label^="Model:"]')?.getAttribute('data-value')).toBe('claude-opus-5-5');
  expect(await choices('Model')).toEqual(['claude-opus-5-5', 'claude-sonnet-5']);
  expect(await choices('Thinking level')).toEqual(['', 'low', 'medium', 'high', 'xhigh', 'max']);
  expect(button('Save configuration')?.disabled).toBe(true);
});

for (const [name, catalog] of [['refuses', { status: 503, body: { error: 'catalog_unavailable' } }], ['cannot be reached', 'throw']] as const) {
  it(`falls back to the built-in list without GPT-5.5 when the catalog ${name}`, async () => {
    await setup({ catalog });
    await openRow('codex');
    expect(await choices('Model')).toEqual(['gpt-6-astra']);
    expect(target.querySelector('[aria-label^="Model:"]')?.getAttribute('data-value')).toBe('gpt-6-astra');
    expect(await choices('Thinking level')).toEqual(['', 'minimal', 'low', 'medium', 'high', 'xhigh']);
    await click('Cancel');
    await openRow('claude');
    expect(await choices('Model')).toEqual(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']);
    expect(target.querySelector('[aria-label^="Model:"]')?.getAttribute('data-value')).toBe('claude-opus-5-5');
  });
}

it('keeps a current model the built-in list lacks when the catalog is down, but never GPT-5.5', async () => {
  await setup({ catalog: { status: 503, body: {} }, provider: 'grok', model: 'grok-4.3', logins: ['grok'] });
  await openRow('grok');
  expect(await choices('Model')).toEqual(['grok-4.7', 'grok-4.6', 'grok-4.5', 'grok-4.3']);
  expect(target.querySelector('[aria-label^="Model:"]')?.getAttribute('data-value')).toBe('grok-4.3');
  await unmount(component!); component = undefined; target.remove();

  await setup({ catalog: { status: 503, body: {} }, provider: 'codex', model: 'gpt-5.5', logins: ['codex'] });
  await openRow('codex');
  expect(await choices('Model')).toEqual(['gpt-6-astra']);
  expect(target.querySelector('[aria-label^="Model:"]')?.getAttribute('data-value')).toBe('gpt-6-astra');
});

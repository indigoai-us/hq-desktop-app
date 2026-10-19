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
function profile(provider: string, model: string, logins: string[]) {
  return { ok: true, value: { agent: { uid: 'agt_a', provider: 'agents-v2' }, box: {}, brain: { provider, model, reasoningEffort: 'medium', logins: logins.map(p => ({ provider: p, status: 'authorized' })) } } };
}
async function setup(options: { logins?: string[]; onFetch?: (path: string, init: RequestInit | undefined) => Reply } = {}) {
  target = document.createElement('div'); target.className = 'desktop-shell'; document.body.appendChild(target);
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const state = { provider: 'claude', model: 'claude-opus-5-5', switch: null as Record<string, unknown> | null };
  const onFetch = options.onFetch ?? ((path: string, init: RequestInit | undefined) => {
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
  expect(target.querySelector('[aria-label^="Model:"]')?.getAttribute('data-value')).toBe('gpt-6-astra');
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
  await pick('Model', 'gpt-5.5');
  await pick('Thinking level', 'low');
  await click('Use this brain');
  expect(target.textContent).toContain('Switch this bot to OpenAI? It restarts and answers a test message first. Claude stays signed in.');
  expect(calls.filter(c => c.method === 'POST')).toHaveLength(0);
  await click('Cancel');
  expect(button('Use this brain')).toBeTruthy();
  await click('Use this brain');
  await click('Switch');
  expect(calls.filter(c => c.method === 'POST')).toEqual([{ path: '/v1/agents/agt_a/brain-switch', method: 'POST', body: { brain: 'codex', model: 'gpt-5.5', reasoningEffort: 'low' } }]);
  expect(target.querySelector('[role="dialog"]')).toBeNull();
  expect(target.querySelector('[data-testid="brain-switching"]')?.textContent).toContain('Switching to OpenAI…');
  state.switch = { ...state.switch!, status: 'waiting', step: 'waiting-for-idle' };
  await vi.advanceTimersByTimeAsync(3100); await settle();
  expect(target.querySelector('[data-testid="brain-switching"]')?.textContent).toContain('once the bot finishes its current reply');
  state.switch = { ...state.switch!, status: 'done', step: 'test' };
  state.provider = 'codex'; state.model = 'gpt-5.5';
  await vi.advanceTimersByTimeAsync(3100); await settle();
  expect(target.querySelector('[data-testid="brain-switching"]')).toBeNull();
  expect(target.textContent).toContain('Now using OpenAI. The bot answered a test message on it.');
  expect(target.querySelector('[data-testid="brain-codex"] button')?.textContent).toContain('Configure');
  expect(target.querySelector('[data-testid="brain-claude"] button')?.textContent).toContain('Use this brain');
});

it('leaves the thinking level to the brain default when none is chosen', async () => {
  const { calls } = await setup();
  await openRow('codex');
  await click('Use this brain');
  await click('Switch');
  expect(calls.filter(c => c.method === 'POST')[0]?.body).toEqual({ brain: 'codex', model: 'gpt-6-astra' });
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

// @vitest-environment happy-dom
import { mount, unmount, tick } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import BotBrainHost from './BotBrainHost.svelte';
import { loginState, providerId } from './bot-brain.js';
let component: ReturnType<typeof mount> | undefined;
let target: HTMLElement;
const settle = async () => { for (let i = 0; i < 20; i++) { await tick(); await Promise.resolve(); } };
afterEach(async () => { if (component) await unmount(component); component = undefined; target?.remove(); });
async function setup(kind: 'local' | 'cloud' = 'local', saveOk = true) {
  target = document.createElement('div'); target.className = 'desktop-shell'; document.body.appendChild(target);
  let model = '';
  const adapter = {
    bots: { list: vi.fn(async () => ({ ok: true, value: { bots: [{ agentUid: 'agt_a', name: 'real-handle', runtime: 'claude', model, effort: 'medium' }] } })), configure: vi.fn(async (_name, patch) => { if (saveOk) model = patch.model; return { ok: saveOk, value: {} }; }) },
    sessions: { loginStatus: vi.fn(async () => ({ ok: true, value: { state: 'connected' } })), loginStart: vi.fn() },
    agents: {
      getProfile: vi.fn(async () => ({ ok: true, value: { agent: { uid: 'agt_a' }, box: {}, brain: { provider: 'claude', model: 'claude-opus-5', logins: [{ provider: 'claude', status: 'authorized' }] } } })),
      restartBrainApproval: vi.fn(async () => ({ ok: true, value: { agent: { provider: 'claude' }, pairing: { url: 'https://auth.openai.com/device', code: 'DEMO-CODE' } } })),
      getStatus: vi.fn(async () => ({ ok: true, value: { agent: { provider: 'claude' }, pairing: { url: 'https://auth.openai.com/device', code: 'DEMO-CODE' } } })),
    },
  };
  const open = vi.fn();
  component = mount(BotBrainHost, { target, props: { uid: 'agt_a', name: 'Display name', runtimeKind: kind, adapter: adapter as never, onopenurl: open } });
  await settle(); return { adapter, open };
}
async function click(text: string) { const button = [...target.querySelectorAll('button')].find(b => b.textContent?.trim() === text); expect(button).toBeTruthy(); button!.click(); await settle(); }
async function openClaude() { target.querySelector<HTMLButtonElement>('[data-testid="brain-claude"] button')!.click(); await settle(); }
async function chooseModel() {
  target.querySelector<HTMLButtonElement>('[aria-label^="Model:"]')!.click(); await settle();
  target.querySelector<HTMLElement>('[role="option"][data-value="claude-opus-5"]')!.click(); await settle();
}

it('loads without signing in and configures only the matched local bot', async () => {
  const { adapter } = await setup(); expect(adapter.sessions.loginStart).not.toHaveBeenCalled();
  await openClaude(); await chooseModel();
  target.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
  expect(adapter.bots.configure).toHaveBeenCalledWith('real-handle', { model: 'claude-opus-5', effort: 'medium' });
});
it('keeps the chosen model on refused saves', async () => {
  await setup('local', false); await openClaude(); await chooseModel();
  target.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
  expect(target.querySelector('[role="alert"]')?.textContent).toContain('Could not save');
  expect(target.querySelector('[aria-label^="Model:"]')?.getAttribute('data-value')).toBe('claude-opus-5');
});
it('cloud setup requests a scoped provider sign-in without changing models', async () => {
  const { adapter, open } = await setup('cloud');
  expect(adapter.agents.restartBrainApproval).not.toHaveBeenCalled();
  target.querySelector<HTMLButtonElement>('[data-testid="brain-codex"] button')!.click(); await settle(); await click('Connect OpenAI');
  expect(adapter.agents.restartBrainApproval).toHaveBeenCalledWith('agt_a', 'codex');
  expect(adapter.bots.configure).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  await click('Open provider sign-in'); expect(open).toHaveBeenCalledWith('https://auth.openai.com/device');
});
it('shows cloud model configuration read-only', async () => {
  const { adapter } = await setup('cloud'); await openClaude();
  expect(target.querySelector('fieldset')?.disabled).toBe(true);
  expect(adapter.bots.configure).not.toHaveBeenCalled();
});
it('normalizes provider identities but leaves unknown logins unknown', () => {
  expect(providerId('openai')).toBe('codex'); expect(providerId('xai')).toBe('grok');
  expect(loginState('authorized')).toBe('connected'); expect(loginState('expired')).toBe('disconnected'); expect(loginState('not-connected')).toBe('disconnected'); expect(loginState('something-new')).toBe('unknown');
});

it.each(['codex', 'claude', 'grok'] as const)('saves cloud %s settings through the scoped runtime endpoint', async provider => {
  const { adapter } = await setup('cloud');
  const models = { codex: 'gpt-6-astra', claude: 'claude-opus-5', grok: 'grok-4.3' };
  adapter.agents.getProfile.mockResolvedValue({ ok: true, value: { agent: { uid: 'agt_a' }, box: {}, brain: { provider, model: models[provider], logins: [{ provider, status: 'authorized' }] } } });
  const fetch = vi.fn(async (_path, init) => ({ status: 200, text: async () => JSON.stringify({ uid: 'agt_a', ...JSON.parse(init.body), applied: true }) }));
  Object.assign(adapter.agents, { fetch });
  target.querySelector<HTMLButtonElement>('[aria-label="Refresh brain"]')!.click(); await settle();
  target.querySelector<HTMLButtonElement>('[data-testid="brain-' + provider + '"] button')!.click(); await settle();
  target.querySelector<HTMLButtonElement>('[aria-label^="Thinking level:"]')!.click(); await settle();
  target.querySelector<HTMLElement>('[role="option"][data-value="high"]')!.click(); await settle();
  target.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
  expect(fetch).toHaveBeenCalledWith('/v1/agents/agt_a/runtime-config', expect.objectContaining({ method: 'PATCH', body: JSON.stringify({ codexModel: models[provider], codexReasoningEffort: 'high' }) }));
  expect(target.textContent).toContain('Configuration saved for future messages');
});

it.each(['codex', 'claude', 'grok'] as const)('starts sign-in for the selected %s provider only', async provider => {
  const { adapter } = await setup('cloud');
  adapter.agents.getProfile.mockResolvedValue({ ok: true, value: { agent: { uid: 'agt_a' }, box: {}, brain: { provider: 'claude', model: 'claude-opus-5', logins: [] } } });
  target.querySelector<HTMLButtonElement>('[aria-label="Refresh brain"]')!.click(); await settle();
  target.querySelector<HTMLButtonElement>('[data-testid="brain-' + provider + '"] button')!.click(); await settle();
  await click('Connect ' + ({ codex: 'OpenAI', claude: 'Claude', grok: 'Grok' })[provider]);
  expect(adapter.agents.restartBrainApproval).toHaveBeenCalledWith('agt_a', provider);
  expect(adapter.bots.configure).not.toHaveBeenCalled();
});

it('keeps cloud settings on a rejected save without displaying provider response bodies', async () => {
  const { adapter } = await setup('cloud');
  Object.assign(adapter.agents, { fetch: vi.fn(async () => ({ status: 403, text: async () => 'private upstream detail' })) });
  target.querySelector<HTMLButtonElement>('[aria-label="Refresh brain"]')!.click(); await settle();
  await openClaude();
  target.querySelector<HTMLButtonElement>('[aria-label^="Thinking level:"]')!.click(); await settle();
  target.querySelector<HTMLElement>('[role="option"][data-value="high"]')!.click(); await settle();
  target.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle();
  expect(target.querySelector('[role=alert]')?.textContent).toContain('Could not save');
  expect(target.textContent).not.toContain('private upstream detail');
  expect(target.querySelector('[aria-label^="Thinking level:"]')?.getAttribute('data-value')).toBe('high');
});

it('reports backend sign-in failure instead of waiting for a nonexistent link', async () => {
  const { adapter } = await setup('cloud');
  adapter.agents.restartBrainApproval.mockResolvedValue({ ok: true, value: { signIn: 'failed', brain: 'codex', pairing: null } } as never);
  target.querySelector<HTMLButtonElement>('[data-testid="brain-codex"] button')!.click(); await settle();
  await click('Connect OpenAI');
  expect(target.querySelector('[role=alert]')?.textContent).toContain('could not launch sign-in');
  expect(target.textContent).not.toContain('Preparing your sign-in link');
});

async function setupMultiProvider(status: number, value: unknown) {
  const { adapter } = await setup('cloud');
  adapter.agents.getProfile.mockResolvedValue({ ok: true, value: { agent: { uid: 'agt_a', provider: 'agents-v2' }, box: {}, brain: { provider: 'claude', model: 'claude-opus-5', logins: [] } } } as never);
  const fetch = vi.fn(async () => ({ status, text: async () => JSON.stringify(value) }));
  Object.assign(adapter.agents, { fetch });
  target.querySelector<HTMLButtonElement>('[aria-label="Refresh brain"]')!.click(); await settle();
  target.querySelector<HTMLButtonElement>('[data-testid="brain-grok"] button')!.click(); await settle();
  await click('Connect Grok');
  return { adapter, fetch };
}
it('authorizes a multi-provider bot without destructive reauth and accepts an existing login', async () => {
  const { adapter, fetch } = await setupMultiProvider(200, { brain: 'grok', authorized: true });
  expect(fetch).toHaveBeenCalledWith('/v1/agents/agt_a/brains/grok/authorize', expect.objectContaining({ method: 'POST', body: '{}' }));
  expect(adapter.agents.restartBrainApproval).not.toHaveBeenCalled();
  expect(target.textContent).toContain('Provider is already connected');
});
it('shows permission failures without falling back to reauth or echoing response bodies', async () => {
  const { adapter, fetch } = await setupMultiProvider(403, { error: 'private upstream detail' });
  expect(target.querySelector('[role=alert]')?.textContent).toContain('does not have permission');
  expect(target.textContent).not.toContain('private upstream detail');
  expect(adapter.agents.restartBrainApproval).not.toHaveBeenCalled();
  await click('Retry sign-in');
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('keeps explicit startup failure actionable for an online multi-provider bot', async () => {
  const { adapter } = await setupMultiProvider(200, { brain: 'grok', signIn: 'failed', pairing: null });
  expect(target.querySelector('[role=alert]')?.textContent).toContain('provider login service');
  expect(target.textContent).not.toContain('check that the bot is online');
  expect(adapter.agents.restartBrainApproval).not.toHaveBeenCalled();
});

it('stops an endless wait and recovers when a later check returns the link', async () => {
  const { adapter } = await setupMultiProvider(202, { brain: 'grok', signIn: 'starting', pairing: null });
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 100000);
  try {
    await click('Check connection');
    expect(target.querySelector('[role=alert]')?.textContent).toContain('has not returned a sign-in link');
    adapter.agents.getStatus.mockResolvedValue({ ok: true, value: { brain: 'grok', pairing: { url: 'https://accounts.x.ai/oauth2/device', code: 'TEST-CODE' } } } as never);
    await click('Check connection');
    expect(target.querySelector('[role=alert]')).toBeNull();
    expect(target.textContent).toContain('Open provider sign-in');
  } finally { now.mockRestore(); }
});

it('shows providers the server reports as not connected as Not connected', async () => {
  const { adapter } = await setup('cloud');
  adapter.agents.getProfile.mockResolvedValue({ ok: true, value: { agent: { uid: 'agt_a' }, box: {}, brain: { provider: 'claude', model: 'claude-opus-5', logins: [{ provider: 'codex', status: 'not-connected' }, { provider: 'claude', status: 'authorized' }, { provider: 'grok', status: 'not-connected' }] } } });
  target.querySelector<HTMLButtonElement>('[aria-label="Refresh brain"]')!.click(); await settle();
  const status = (provider: string) => target.querySelector('[data-testid="brain-' + provider + '"] .status')?.textContent?.trim();
  expect(status('codex')).toBe('Not connected');
  expect(status('grok')).toBe('Not connected');
  expect(status('claude')).toBe('Connected');
});

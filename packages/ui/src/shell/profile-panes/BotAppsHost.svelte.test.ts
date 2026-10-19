// @vitest-environment happy-dom
import { mount, unmount, tick } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import BotAppsHost from './BotAppsHost.svelte';
let component: ReturnType<typeof mount> | undefined;
let target: HTMLElement;
const settle = async () => { for (let i = 0; i < 20; i++) { await tick(); await Promise.resolve(); } };
afterEach(async () => { if (component) await unmount(component); component = undefined; target?.remove(); });
async function setup(flag = true, granted = false, mutationOk = true) {
  target = document.createElement('div'); target.className = 'desktop-shell'; document.body.appendChild(target);
  let enabled = granted;
  const integrations = {
    listConnections: vi.fn(async () => ({ ok: true, value: { viewer: { canManageIntegrations: true }, connections: [{ id: 'connection_1', provider: 'factory:linear', status: 'connected', access: { mode: 'shared' }, installation: { connectionId: 'connection_1', provider: 'linear', displayName: 'Linear', domain: 'linear.app', surface: { kind: 'mcp', url: 'https://mcp.linear.app/mcp', credentialIds: ['direct-mcp-bearer-token'] } } }] } })),
    getConnectionAccess: vi.fn(async () => ({ ok: true, value: { canManage: true, access: { mode: 'shared' }, entries: enabled ? [{ granteeType: 'person', granteeId: 'agt_a', permission: 'read' }] : [] } })),
    grantConnectionAccess: vi.fn(async () => { if (mutationOk) enabled = true; return { ok: mutationOk, value: {} }; }),
    revokeConnectionAccess: vi.fn(async () => { if (mutationOk) enabled = false; return { ok: mutationOk, value: {} }; }),
    catalogSearch: vi.fn(async () => ({ ok: true, value: { entries: [{ entryId: 'cat_docs', domain: 'docs.example.com', name: 'Docs', mcpReady: true, authClass: 'none' }] } })),
    install: vi.fn(async () => ({ ok: true, value: {} })),
    startOAuth: vi.fn(), uninstall: vi.fn(),
  };
  const adapter = { integrations, identity: { hasFeature: vi.fn(async () => ({ ok: true, value: flag })) }, agents: { getProfile: vi.fn(async () => ({ ok: true, value: { agent: { uid: 'agt_a' }, box: {} } })) } };
  component = mount(BotAppsHost, { target, props: { uid: 'agt_a', companyUid: 'cmp_a', name: 'Scout', adapter: adapter as never, onopenurl: vi.fn() } });
  await settle(); return integrations;
}
async function click(label: string) {
  const button = [...target.querySelectorAll('button')].find(button => button.textContent?.trim() === label);
  expect(button).toBeTruthy(); button!.click(); await settle();
}
async function openApp() { target.querySelector<HTMLButtonElement>('[data-testid="bot-app"]')!.click(); await settle(); }
async function openCompanyApp() { await click('Browse apps'); document.querySelector<HTMLButtonElement>('[data-testid="company-app"]')!.click(); await settle(); }
it('reads apps without mutations and grants access only to the selected bot', async () => {
  const api = await setup();
  expect(api.install).not.toHaveBeenCalled(); expect(api.grantConnectionAccess).not.toHaveBeenCalled();
  expect(target.querySelector('[data-testid="bot-app"]')).toBeNull();
  expect(target.querySelector('[data-testid="bot-apps-empty"]')?.textContent).toContain('No company apps are connected to this bot.');
  await openCompanyApp(); await click('Add to bot');
  expect(api.grantConnectionAccess).toHaveBeenCalledWith({ companyUid: 'cmp_a', connectionId: 'connection_1', granteeUid: 'agt_a' });
  expect(target.querySelector('[role="dialog"]')?.textContent).toContain('Available to bot');
});
it('requires confirmation to revoke bot access and never uninstalls company apps', async () => {
  const api = await setup(true, true); await openApp(); await click('Remove bot access');
  expect(api.revokeConnectionAccess).not.toHaveBeenCalled();
  await click('Confirm removal');
  expect(api.revokeConnectionAccess).toHaveBeenCalledWith({ companyUid: 'cmp_a', connectionId: 'connection_1', granteeUid: 'agt_a' });
  expect(api.uninstall).not.toHaveBeenCalled();
});
it('honors the per-bot control feature gate', async () => {
  const api = await setup(false); await openCompanyApp();
  expect(target.querySelector('[role="dialog"]')?.textContent).toContain('not enabled');
  expect([...target.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Add to bot')).toBe(false);
  expect(api.grantConnectionAccess).not.toHaveBeenCalled();
});
it('retains existing access after a refused mutation', async () => {
  await setup(true, false, false); await openCompanyApp(); await click('Add to bot');
  expect(target.querySelector('[role="alert"]')?.textContent).toContain('Could not complete');
  expect(target.querySelector('[role="dialog"]')?.textContent).toContain('Company connection');
});
it('uses catalog IDs for no-auth setup without silently granting bot access', async () => {
  const api = await setup(); await click('Browse apps');
  expect(api.catalogSearch).toHaveBeenCalledWith('cmp_a', '', 100);
  target.querySelector<HTMLButtonElement>('[data-testid="catalog-app"]')!.click(); await settle(); await click('Connect app');
  expect(api.install).toHaveBeenCalledWith({ companyUid: 'cmp_a', catalogEntryId: 'cat_docs' });
  expect(api.grantConnectionAccess).not.toHaveBeenCalled();
});

it('opens existing credential settings without changing connection or bot access', async () => {
  const api = await setup(); await openCompanyApp(); await click('Connection settings');
  expect(target.querySelector('[aria-label="Connection settings"]')).not.toBeNull();
  expect(target.querySelector('input[type="password"]')).not.toBeNull();
  expect(api.install).not.toHaveBeenCalled(); expect(api.grantConnectionAccess).not.toHaveBeenCalled();
});

it('keeps old app cards hidden until connection access has finished refreshing', async () => {
  const api = await setup(true, true);
  let finish!: (value: never) => void;
  api.getConnectionAccess.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  target.querySelector<HTMLButtonElement>('[aria-label="Refresh apps"]')!.click();
  await settle();
  expect(target.querySelector('[data-testid="bot-apps-loading"]')).not.toBeNull();
  expect(target.querySelector('[data-testid="bot-app"]')).toBeNull();
  finish({ ok: true, value: { canManage: true, access: { mode: 'shared' }, entries: [{ granteeType: 'person', granteeId: 'agt_a', permission: 'read' }] } } as never);
  await settle();
  expect(target.querySelector('[data-testid="bot-apps-loading"]')).toBeNull();
  expect(target.querySelector('[data-testid="bot-app"]')).not.toBeNull();
});
async function setupPersonal(listResult: unknown, runtimeKind: 'cloud' | 'local' = 'cloud') {
  target = document.createElement('div'); target.className = 'desktop-shell'; document.body.appendChild(target);
  const integrations = {
    listConnections: vi.fn(async () => ({ ok: true, value: { viewer: { canManageIntegrations: true }, connections: [] } })),
    getConnectionAccess: vi.fn(), grantConnectionAccess: vi.fn(), revokeConnectionAccess: vi.fn(),
    catalogSearch: vi.fn(async () => ({ ok: true, value: { entries: [] } })), install: vi.fn(), startOAuth: vi.fn(), uninstall: vi.fn(),
  };
  const personalApps = {
    list: vi.fn(async () => listResult), catalog: vi.fn(), add: vi.fn(), remove: vi.fn(), startSignIn: vi.fn(), signInStatus: vi.fn(),
  };
  const adapter = { integrations, personalApps, identity: { hasFeature: vi.fn(async () => ({ ok: true, value: true })) }, agents: { getProfile: vi.fn(async () => ({ ok: true, value: { agent: { uid: 'agt_a' }, box: {} } })) } };
  component = mount(BotAppsHost, { target, props: { uid: 'agt_a', companyUid: 'cmp_a', name: 'Scout', runtimeKind, adapter: adapter as never, onopenurl: vi.fn() } });
  await settle(); return personalApps;
}
it('shows the bot owner its personal apps next to company apps on a cloud bot', async () => {
  const api = await setupPersonal({ ok: true, value: { apps: [{ name: 'notion', url: 'https://mcp.notion.com', auth: 'oauth', enabled: true, connected: true, tools: 12 }] } });
  expect(api.list).toHaveBeenCalledWith('agt_a');
  expect(target.querySelector('[aria-label="Personal apps"]')).toBeTruthy();
  expect(target.textContent).toContain('Company apps');
  expect(target.querySelector('[data-testid="personal-app"]')?.textContent).toContain('Signed in · 12 tools');
});
it('hides personal apps when HQ answers 404 (not the owner, or turned off for the company)', async () => {
  await setupPersonal({ ok: false, reason: 'error', code: 'http-404', status: 404 });
  expect(target.querySelector('[aria-label="Personal apps"]')).toBeNull();
  expect(target.textContent).not.toContain('Company apps');
  expect(target.textContent).not.toContain('Could not load this bot');
});
it('keeps the section with an error for any other failure', async () => {
  await setupPersonal({ ok: false, reason: 'error', code: 'http-503', status: 503 });
  expect(target.querySelector('[aria-label="Personal apps"]')?.textContent).toContain('Could not load this bot');
});
it('never shows personal apps on a local bot', async () => {
  const api = await setupPersonal({ ok: true, value: { apps: [] } }, 'local');
  expect(api.list).not.toHaveBeenCalled();
  expect(target.querySelector('[aria-label="Personal apps"]')).toBeNull();
});
it('shows a signed-in app as connecting until the reloading bot reports it connected', async () => {
  vi.useFakeTimers();
  try {
    const vercel = (connected: boolean) => ({ name: 'vercel', url: 'https://mcp.vercel.com', auth: 'oauth', enabled: true, connected, tools: connected ? 239 : null });
    const api = await setupPersonal({ ok: true, value: { apps: [] } });
    api.catalog.mockResolvedValue({ ok: true, value: { entries: [{ name: 'vercel', description: 'Deploys', url: 'https://mcp.vercel.com', transport: 'http', auth: 'oauth', installed: false, supported: true }] } });
    api.add.mockResolvedValue({ ok: true, value: {} });
    api.list.mockResolvedValue({ ok: true, value: { apps: [vercel(false)] } });
    api.startSignIn.mockResolvedValue({ ok: true, value: { flowId: 'flow-1', authorizationUrl: 'https://vercel.com/oauth/authorize?state=s' } });
    api.signInStatus.mockResolvedValue({ ok: true, value: { status: 'authorization_required', error: null, tools: 0 } });
    const card = () => target.querySelector('[data-testid="personal-app"]')?.textContent ?? '';
    const section = () => target.querySelector('[aria-label="Personal apps"]')!;
    [...section().querySelectorAll('button')].find(button => button.textContent?.includes('Browse apps'))!.click(); await settle();
    document.querySelector<HTMLButtonElement>('[data-testid="personal-catalog-app"]')!.click(); await settle();
    [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Add and sign in')!.click(); await settle();
    expect(card()).toContain('Waiting for sign-in');
    await vi.advanceTimersByTimeAsync(6000); await settle();
    expect(card()).toContain('Waiting for sign-in');
    api.signInStatus.mockResolvedValue({ ok: true, value: { status: 'approved', error: null, tools: 239 } });
    await vi.advanceTimersByTimeAsync(2000); await settle();
    expect(card()).toContain('Connecting…');
    await vi.advanceTimersByTimeAsync(45000); await settle();
    expect(card()).toContain('Connecting…');
    api.list.mockResolvedValue({ ok: true, value: { apps: [vercel(true)] } });
    await vi.advanceTimersByTimeAsync(3000); await settle();
    expect(card()).toContain('Signed in · 239 tools');
    expect(section().querySelector('[role="status"]')?.textContent).toBe('vercel is connected.');
  } finally { vi.useRealTimers(); }
});
it('says so when the bot has not picked up a signed-in app after two minutes', async () => {
  vi.useFakeTimers();
  try {
    const api = await setupPersonal({ ok: true, value: { apps: [{ name: 'vercel', url: 'https://mcp.vercel.com', auth: 'oauth', enabled: true, connected: false, tools: null }] } });
    api.startSignIn.mockResolvedValue({ ok: true, value: { flowId: 'flow-1', authorizationUrl: 'https://vercel.com/oauth/authorize?state=s' } });
    api.signInStatus.mockResolvedValue({ ok: true, value: { status: 'approved', error: null, tools: 239 } });
    target.querySelector<HTMLButtonElement>('[data-testid="personal-app"]')!.click(); await settle();
    [...document.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Sign in')!.click(); await settle();
    await vi.advanceTimersByTimeAsync(2000 + 40 * 3000); await settle();
    expect(target.querySelector('[aria-label="Personal apps"] [role="status"]')?.textContent).toContain('hasn’t picked it up yet');
    expect(target.querySelector('[data-testid="personal-app"]')?.textContent).toContain('Needs sign-in');
  } finally { vi.useRealTimers(); }
});

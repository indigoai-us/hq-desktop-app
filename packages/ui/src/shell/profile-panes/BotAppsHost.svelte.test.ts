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
it('reads apps without mutations and grants access only to the selected bot', async () => {
  const api = await setup();
  expect(api.install).not.toHaveBeenCalled(); expect(api.grantConnectionAccess).not.toHaveBeenCalled();
  await openApp(); await click('Add to bot');
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
  const api = await setup(false); await openApp();
  expect(target.querySelector('[role="dialog"]')?.textContent).toContain('not enabled');
  expect([...target.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Add to bot')).toBe(false);
  expect(api.grantConnectionAccess).not.toHaveBeenCalled();
});
it('retains existing access after a refused mutation', async () => {
  await setup(true, false, false); await openApp(); await click('Add to bot');
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
  const api = await setup(); await openApp(); await click('Connection settings');
  expect(target.querySelector('[aria-label="Connection settings"]')).not.toBeNull();
  expect(target.querySelector('input[type="password"]')).not.toBeNull();
  expect(api.install).not.toHaveBeenCalled(); expect(api.grantConnectionAccess).not.toHaveBeenCalled();
});

it('keeps old app cards hidden until connection access has finished refreshing', async () => {
  const api = await setup();
  let finish!: (value: never) => void;
  api.getConnectionAccess.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  target.querySelector<HTMLButtonElement>('[aria-label="Refresh apps"]')!.click();
  await settle();
  expect(target.querySelector('[data-testid="bot-apps-loading"]')).not.toBeNull();
  expect(target.querySelector('[data-testid="bot-app"]')).toBeNull();
  finish({ ok: true, value: { canManage: true, access: { mode: 'shared' }, entries: [] } } as never);
  await settle();
  expect(target.querySelector('[data-testid="bot-apps-loading"]')).toBeNull();
  expect(target.querySelector('[data-testid="bot-app"]')).not.toBeNull();
});

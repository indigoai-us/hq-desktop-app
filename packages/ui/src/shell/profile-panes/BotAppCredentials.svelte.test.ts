// @vitest-environment happy-dom
import { mount, unmount, tick } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import BotAppCredentials from './BotAppCredentials.svelte';
import { credentialConfigs } from './bot-app-credentials.js';
import { integrationOAuthStartBody } from '@hq/platform';
const payload = { viewer: { canManageIntegrations: true }, connections: [{ id: 'con_a', provider: 'factory:acme', status: 'connected', pullAllHistory: false, installation: { connectionId: 'con_a', provider: 'acme', domain: 'acme.example', displayName: 'Acme', surface: { kind: 'mcp', url: 'https://mcp.acme.example/mcp', credentialIds: ['direct-mcp-bearer-token'] } } }] };
let component: ReturnType<typeof mount>, target: HTMLElement;
const settle = async () => { for (let i = 0; i < 20; i++) { await tick(); await Promise.resolve(); } };
afterEach(async () => { if (component) await unmount(component); target?.remove(); });
async function setup(result: unknown = { ok: true, value: { connection: { id: 'con_a', status: 'connected' }, installation: { status: 'installed' } } }) {
  target = document.createElement('div'); document.body.appendChild(target);
  const api = { listConnections: vi.fn(async () => ({ ok: true, value: payload })), install: vi.fn(async () => result) };
  const saved = vi.fn(), close = vi.fn();
  component = mount(BotAppCredentials, { target, props: { config: credentialConfigs(payload).con_a, companyUid: 'cmp_a', api: api as never, onclose: close, onsaved: saved } });
  await settle(); return { api, saved, close };
}
async function fill() {
  const input = target.querySelector<HTMLInputElement>('input[type=password]')!;
  input.value = 'test-secret-not-real'; input.dispatchEvent(new Event('input', { bubbles: true }));
  target.querySelector<HTMLButtonElement>('[aria-haspopup=listbox]')!.click(); await settle();
  [...target.querySelectorAll<HTMLElement>('[role=option]')].find(el => el.textContent?.includes('Bearer token'))!.click(); await settle();
}
async function submit() { target.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle(); }
it('replaces credentials on the persisted provider without changing history or grants', async () => {
  const { api, saved } = await setup(); await fill(); await submit();
  expect(api.listConnections).toHaveBeenCalledWith('cmp_a');
  expect(api.install).toHaveBeenCalledWith({ companyUid: 'cmp_a', provider: 'acme', mcpUrl: 'https://mcp.acme.example/mcp', displayName: 'Acme', domain: 'acme.example', authMode: 'bearer', bearerToken: 'test-secret-not-real', authScheme: { placement: 'authorization', format: 'bearer' }, pullAllHistory: false });
  expect(saved).toHaveBeenCalledOnce(); expect(target.textContent).toContain('Credentials updated.');
  expect(target.querySelector('input[type=password]')).toBeNull();
});
it('fails closed when permission is revoked before submission and wipes the key', async () => {
  const { api } = await setup(); api.listConnections.mockResolvedValue({ ok: true, value: { ...payload, viewer: { canManageIntegrations: false } } });
  await fill(); await submit(); expect(api.install).not.toHaveBeenCalled();
  expect(target.querySelector<HTMLInputElement>('input[type=password]')!.value).toBe('');
});
it('does not echo rejected credential payloads or report success', async () => {
  const { saved } = await setup({ ok: false, error: 'test-secret-not-real' }); await fill(); await submit();
  expect(saved).not.toHaveBeenCalled(); expect(target.textContent).not.toContain('test-secret-not-real');
  expect(target.querySelector<HTMLInputElement>('input[type=password]')!.value).toBe('');
});
it('rejects success for a different connection', async () => {
  const { saved } = await setup({ ok: true, value: { connection: { id: 'con_other', status: 'connected' }, installation: { status: 'installed' } } }); await fill(); await submit();
  expect(saved).not.toHaveBeenCalled(); expect(target.textContent).toContain('could not be verified');
});
it('does not expose settings without admin rights or a safe persisted endpoint', () => {
  expect(credentialConfigs({ ...payload, viewer: { canManageIntegrations: false } })).toEqual({});
  const bad = structuredClone(payload); bad.connections[0].installation.surface.url += '?token=secret';
  expect(credentialConfigs(bad)).toEqual({});
});

async function setupOAuth() {
  const data = structuredClone(payload);
  Object.assign(data.connections[0].installation, { updatedAt: 'before', status: 'installed' });
  Object.assign(data.connections[0].installation.surface, { credentialIds: ['remote-mcp-oauth'], authStatus: 'required' });
  target = document.createElement('div'); document.body.appendChild(target);
  const api = {
    listConnections: vi.fn(async () => ({ ok: true, value: data })),
    oauthCallbackUrl: vi.fn(async () => ({ ok: true, value: 'https://hq.example/callback' })),
    startOAuth: vi.fn(async () => ({ ok: true, value: { provider: 'acme', authorizationUrl: 'https://acme.example/authorize' } })),
  };
  const saved = vi.fn(), open = vi.fn();
  component = mount(BotAppCredentials, { target, props: { config: credentialConfigs(data).con_a, companyUid: 'cmp_a', api: api as never, onclose: vi.fn(), onsaved: saved, onopenurl: open } });
  await settle(); return { data, api, saved, open };
}
async function click(label: string) {
  [...target.querySelectorAll('button')].find(button => button.textContent === label)!.click(); await settle();
}
it('reconnects OAuth using the existing identity and verifies a fresh update on the same connection', async () => {
  const { data, api, saved, open } = await setupOAuth();
  await click('Reconnect Acme');
  const input = { companyUid: 'cmp_a', provider: 'acme', mcpUrl: 'https://mcp.acme.example/mcp', displayName: 'Acme', domain: 'acme.example', pullAllHistory: false, redirectUri: 'https://hq.example/callback' };
  expect(api.startOAuth).toHaveBeenCalledWith(input);
  expect(integrationOAuthStartBody(input)).toEqual(input);
  expect(open).toHaveBeenCalledWith('https://acme.example/authorize');
  await click('Check connection');
  expect(saved).not.toHaveBeenCalled();
  expect(target.textContent).toContain('Sign-in has not been confirmed yet');
  Object.assign(data.connections[0].installation, { updatedAt: 'after' });
  await click('Check connection');
  expect(saved).toHaveBeenCalledOnce();
  expect(target.textContent).toContain('Connection updated.');
});
it('does not launch OAuth after permission is revoked', async () => {
  const { data, api, open } = await setupOAuth();
  data.viewer.canManageIntegrations = false;
  await click('Reconnect Acme');
  expect(api.startOAuth).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
});
it('rejects an OAuth response for a different provider', async () => {
  const { api, open } = await setupOAuth();
  api.startOAuth.mockResolvedValue({ ok: true, value: { provider: 'other', authorizationUrl: 'https://other.example/authorize' } });
  await click('Reconnect Acme');
  expect(open).not.toHaveBeenCalled(); expect(target.textContent).toContain('Could not start sign-in');
});

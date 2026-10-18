// @vitest-environment happy-dom
import { mount, unmount, tick } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import BotChannelsHost from './BotChannelsHost.svelte';
let component: ReturnType<typeof mount> | undefined;
let host: HTMLElement;
let openUrl: ReturnType<typeof vi.fn<(url: string) => void>>;
const settle = async () => { for (let i = 0; i < 12; i++) { await tick(); await Promise.resolve(); } };
afterEach(async () => { if (component) await unmount(component); component = undefined; host?.remove(); });
async function setup(denied = false, connected = false) {
  openUrl = vi.fn();
  host = document.createElement('div'); document.body.appendChild(host);
  const api = { getStatus: vi.fn(async () => denied ? { ok: false, status: 403 } : { ok: true, value: { agent: { channels: connected ? { slack: { workspace: 'test', appId: 'A0TEST', connectionMode: 'socket' } } : {}, channelDiagnostics: { slack: { inboundCapability: connected ? 'socket-mode' : 'unknown' } } } } }), getProfile: vi.fn(async () => ({ ok: true, value: { box: { platforms: [{ name: 'Telegram', state: 'connected' }] } } })), attachSlack: vi.fn(async () => ({ ok: true, value: { config: { workspace: 'pending-install', installUrl: 'https://slack.com/oauth/v2/authorize?client_id=test' } } })), submitSlackAppToken: vi.fn(), disconnectSlack: vi.fn(async () => { connected = false; return { ok: true, value: {} }; }) };
  component = mount(BotChannelsHost, { target: host, props: { uid: 'agt_a', companyUid: 'cmp_a', name: 'Scout', agents: api as never, adapter: { agents: api } as never, onopenurl: openUrl } });
  await settle(); return api;
}
it('reads live status without creating a connection and shows reported platforms', async () => {
  const api = await setup();
  expect(api.getStatus).toHaveBeenCalledWith('agt_a');
  expect(api.attachSlack).not.toHaveBeenCalled();
  expect(host.querySelector('[data-testid="channel-telegram"]')?.textContent).toContain('Connected');
  expect(host.querySelector<HTMLButtonElement>('[data-testid="channel-slack"] button')?.disabled).toBe(false);
  expect(host.querySelector('[data-testid="channel-whatsapp"]')).toBeNull();
});
it('keeps setup disabled after denied status reads', async () => {
  const api = await setup(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('owner or admin');
  host.querySelector<HTMLButtonElement>('[data-testid="channel-slack"] button')?.click();
  await settle();
  expect(host.querySelector('[role="dialog"]')?.textContent).not.toContain('Connect Slack');
  expect(api.attachSlack).not.toHaveBeenCalled();
});

it('Connect opens real Slack setup with one click and attaches once', async () => {
  const api = await setup();
  host.querySelector<HTMLButtonElement>('[data-testid="channel-slack"] button')!.click();
  await settle();
  expect(api.attachSlack).toHaveBeenCalledTimes(1);
  expect(api.attachSlack).toHaveBeenCalledWith('agt_a');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Slack');
});
it('Manage opens existing Slack settings without attaching again', async () => {
  const api = await setup(false, true);
  host.querySelector<HTMLButtonElement>('[data-testid="channel-slack"] button')!.click();
  await settle();
  expect(document.querySelector('[data-testid="slack-connect-settings"]')?.textContent).toContain('Slack app settings');
  document.querySelector<HTMLButtonElement>('[data-testid="slack-connect-settings"]')!.click();
  expect(openUrl).toHaveBeenCalledWith('https://api.slack.com/apps/A0TEST/general');
  expect(api.attachSlack).not.toHaveBeenCalled();
});

it('disconnects Slack only after confirmation and never reattaches when status becomes empty', async () => {
  const api = await setup(false, true);
  host.querySelector<HTMLButtonElement>('[data-testid="channel-slack"] button')!.click(); await settle();
  const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === text)!;
  button('Disconnect Slack').click(); await settle();
  expect(api.disconnectSlack).not.toHaveBeenCalled();
  button('Confirm disconnect').click(); await settle();
  expect(api.disconnectSlack).toHaveBeenCalledOnce();
  expect(api.attachSlack).not.toHaveBeenCalled();
  expect(host.querySelector('[data-testid="channel-slack"]')?.textContent).toContain('Not connected');
});

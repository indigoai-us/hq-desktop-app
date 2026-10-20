// @vitest-environment happy-dom
import { mount, unmount, tick } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import BotChannelManager from './BotChannelManager.svelte';
let component: ReturnType<typeof mount>;
let host: HTMLElement;
const settle = async () => { for (let i = 0; i < 20; i++) { await tick(); await Promise.resolve(); } };
afterEach(async () => { if (component) await unmount(component); host?.remove(); });
async function setup(configured = false, channel: 'telegram' | 'teams' = 'telegram') {
  host = document.createElement('div'); document.body.appendChild(host);
  const api = {
    channelStatus: vi.fn(async () => ({ ok: true, value: { configured, eligible: true } })),
    channelContacts: vi.fn(async () => ({ ok: true, value: { contacts: [{ personUid: 'prs_ada', displayName: 'Ada' }] } })),
    connectTelegram: vi.fn(async () => ({ ok: true, value: { creationLink: 'https://t.me/newbot/hq/test_bot' } })),
    disconnectTelegram: vi.fn(async () => { configured = false; return { ok: true, value: { detached: true } }; }),
    addChannelContact: vi.fn(async () => ({ ok: true, value: channel === 'telegram' ? { deepLink: 'https://t.me/test_bot?start=fake' } : { enrollLink: '/enroll/teams?token=fake' } })),
    removeChannelContact: vi.fn(async () => ({ ok: true, value: { revoked: true } })),
  };
  const open = vi.fn();
  component = mount(BotChannelManager, { target: host, props: { uid: 'agt_test', name: 'Scout', channel, companyUid: 'cmp_test', agents: api as never,
    adapter: { company: { listCompanyMemberships: vi.fn(async () => ({ ok: true, value: { members: [{ personUid: 'prs_ada', personName: 'Ada' }, { personUid: 'agt_robot', personName: 'Robot' }] } })) } } as never,
    onclose: vi.fn(), onchanged: vi.fn(async () => {}), onopenurl: open } });
  await settle(); return { api, open };
}
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === text)!;
async function fill(input: HTMLInputElement, value: string) { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); await settle(); }
it('starts managed setup only after a valid explicit submit, and opens the returned link', async () => {
  const { api, open } = await setup();
  expect(api.connectTelegram).not.toHaveBeenCalled();
  expect(button('Continue in Telegram').disabled).toBe(true);
  await fill(host.querySelector('input')!, 'scout_bot');
  button('Continue in Telegram').click(); await settle();
  expect(api.connectTelegram).toHaveBeenCalledExactlyOnceWith('agt_test', { managed: true, suggestedUsername: 'scout_bot', suggestedName: 'Scout' });
  expect(host.textContent).toContain('Not connected');
  button('Open setup link').click();
  expect(open).toHaveBeenCalledWith('https://t.me/newbot/hq/test_bot');
});
it('sends a token only on submit and does not display server error text or claim success', async () => {
  const { api } = await setup();
  api.connectTelegram.mockResolvedValueOnce({ ok: false, status: 400, message: 'fake-secret-token' } as never);
  button('Use an existing bot').click(); await settle();
  await fill(host.querySelector('input[type=password]')!, 'fake-secret-token');
  button('Connect Telegram').click(); await settle();
  expect(api.connectTelegram).toHaveBeenCalledWith('agt_test', { token: 'fake-secret-token' });
  expect(host.querySelector('[role=alert]')?.textContent).not.toContain('fake-secret-token');
  expect(host.textContent).toContain('Not connected');
});
it('mints links for selected members and requires confirmation before removing access or disconnecting', async () => {
  const { api } = await setup(true);
  button('Ada').click(); await settle();
  button('Create connection link').click(); await settle();
  expect(api.addChannelContact).toHaveBeenCalledWith('agt_test', 'telegram', 'prs_ada');
  button('Remove').click(); await settle();
  expect(api.removeChannelContact).not.toHaveBeenCalled();
  button('Confirm remove').click(); await settle();
  expect(api.removeChannelContact).toHaveBeenCalledWith('agt_test', 'telegram', 'prs_ada');
  button('Disconnect Telegram').click(); await settle();
  expect(api.disconnectTelegram).not.toHaveBeenCalled();
  button('Confirm disconnect').click(); await settle();
  expect(api.disconnectTelegram).toHaveBeenCalledWith('agt_test');
  expect(host.textContent).toContain('Not connected');
});
it('normalizes Teams enrollment links to the canonical console host', async () => {
  const { api, open } = await setup(true, 'teams');
  expect(button('Robot')).toBeUndefined();
  button('Ada').click(); await settle(); button('Create connection link').click(); await settle();
  button('Open setup link').click();
  expect(api.addChannelContact).toHaveBeenCalledWith('agt_test', 'teams', 'prs_ada');
  expect(open).toHaveBeenCalledWith('https://hq.computer/enroll/teams?token=fake');
  expect(host.textContent).not.toContain('Disconnect Telegram');
});
it('does not open an untrusted server link', async () => {
  const { api } = await setup();
  api.connectTelegram.mockResolvedValueOnce({ ok: true, value: { creationLink: 'https://evil.test/newbot' } });
  await fill(host.querySelector('input')!, 'scout_bot'); button('Continue in Telegram').click(); await settle();
  expect(host.querySelector('[role=alert]')?.textContent).toContain('supported setup link');
  expect(button('Open setup link')).toBeUndefined();
});

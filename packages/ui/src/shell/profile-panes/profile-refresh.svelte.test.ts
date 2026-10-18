// @vitest-environment happy-dom
import { mount, unmount, tick } from 'svelte';
import { expect, it } from 'vitest';
import Fixture from './ProfileRefreshFixture.svelte';
it('preserves tab and expanded details across shell refreshes but resets for another bot', async () => {
  const target = document.createElement('div'); document.body.appendChild(target);
  const component = mount(Fixture, { target });
  const settle = async () => { for (let i = 0; i < 8; i++) { await tick(); await Promise.resolve(); } };
  const button = (name: string) => [...target.querySelectorAll('button')].find(b => b.textContent?.trim() === name)!;
  try {
    await settle();
    target.querySelector<HTMLButtonElement>('[data-tab="brain"]')!.click(); await settle();
    button('Refresh shell').click(); await settle();
    expect(target.querySelector('[data-tab="brain"]')?.getAttribute('aria-selected')).toBe('true');
    button('Bot details').click(); await settle();
    const name = target.querySelector<HTMLInputElement>('[data-testid="edit-bot-name"]')!;
    name.value = 'Keep my draft'; name.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    button('Refresh shell').click(); await settle();
    expect(name.value).toBe('Keep my draft');
    expect(button('Bot details').getAttribute('aria-expanded')).toBe('true');
    button('Switch bot').click(); await settle();
    expect(target.querySelector('[data-tab="channels"]')?.getAttribute('aria-selected')).toBe('true');
    expect(button('Bot details').getAttribute('aria-expanded')).toBe('false');
  } finally { await unmount(component); target.remove(); }
});

it('only lists default channels and active extra connections', async () => {
  const { default: Panel } = await import('./BotChannelsPanel.svelte');
  const { channelRows } = await import('./bot-channels.js');
  const target = document.createElement('div'); document.body.appendChild(target);
  const rows = channelRows(null, { box: { platforms: [{ name: 'unused', state: 'disabled' }, { name: 'matrix', state: 'connected' }] } }, false);
  const component = mount(Panel, { target, props: { rows } });
  try { await tick(); expect(target.querySelectorAll('article')).toHaveLength(3); expect(target.querySelector('[data-testid="channel-unused"]')).toBeNull(); expect(target.querySelector('[data-testid="channel-matrix"]')).not.toBeNull(); }
  finally { await unmount(component); target.remove(); }
});

it('uses the bot-reported company for Apps opened from an unscoped DM', async () => {
  const { default: Host } = await import('./ProfilePaneHost.svelte');
  const { vi } = await import('vitest');
  const listConnections = vi.fn(async () => ({ ok: true, value: { connections: [] } }));
  const agents = { getStatus: async () => ({ ok: true, value: { agent: { companyUid: 'cmp_reported' } } }), listJobs: async () => ({ ok: true, value: { jobs: [] } }), getProfile: async () => ({ ok: true, value: {} }) };
  const target = document.createElement('div'); document.body.appendChild(target);
  const component = mount(Host, { target, props: { kind: 'bot', name: 'Scout', agentUid: 'agt_a', agents: agents as never, adapter: { agents, integrations: { listConnections } } as never } });
  try {
    for (let i=0;i<10;i++) { await tick(); await Promise.resolve(); }
    target.querySelector<HTMLButtonElement>('[data-tab="apps"]')!.click();
    for (let i=0;i<10;i++) { await tick(); await Promise.resolve(); }
    expect(listConnections).toHaveBeenCalledWith('cmp_reported');
  } finally { await unmount(component); target.remove(); }
});

it('routes local pause to the matched local handle and recovers from a rejected request', async () => {
  const { default: Host } = await import('./ProfilePaneHost.svelte');
  const { vi } = await import('vitest');
  const stop = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ ok: true, value: {} });
  const bots = { list: async () => ({ ok: true, value: { bots: [{ agentUid: 'agt_a', name: 'local-handle' }] } }), stop };
  const target = document.createElement('div'); document.body.appendChild(target);
  const component = mount(Host, { target, props: { kind: 'bot', name: 'Display label', agentUid: 'agt_a', runtimeKind: 'local', adapter: { bots } as never } });
  const settle = async () => { for(let i=0;i<10;i++) { await tick(); await Promise.resolve(); } };
  try {
    await settle(); target.querySelector<HTMLButtonElement>('.details-button')!.click(); await settle();
    const pause = target.querySelector<HTMLButtonElement>('[data-testid="bot-profile-pause"]')!;
    pause.click(); await settle();
    expect(stop).toHaveBeenCalledWith('local-handle'); expect(pause.disabled).toBe(false); expect(pause.textContent).toBe('Pause');
    expect(target.textContent).toContain('Could not pause');
    pause.click(); await settle(); expect(pause.textContent).toBe('Resume');
  } finally { await unmount(component); target.remove(); }
});

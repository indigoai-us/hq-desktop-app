// @vitest-environment happy-dom
import { mount, unmount, tick } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import BotEmailManager from './BotEmailManager.svelte';
let component: ReturnType<typeof mount>;
let host: HTMLElement;
const settle = async () => { for (let i = 0; i < 20; i++) { await tick(); await Promise.resolve(); } };
afterEach(async () => { if (component) await unmount(component); host?.remove(); });
async function setup(address = '') {
  host = document.createElement('div'); document.body.appendChild(host);
  const api = {
    getStatus: vi.fn(async () => ({ ok: true, value: { agent: { channels: { email: address ? { address } : null } } } })),
    connectEmail: vi.fn(async () => { address = 'scout@example.test'; return { ok: true, value: {} }; }),
    updateEmailAddress: vi.fn(async (_uid, localPart) => { address = localPart + '@example.test'; return { ok: true, value: {} }; }),
    disconnectEmail: vi.fn(async () => { address = ''; return { ok: true, value: {} }; }),
  };
  component = mount(BotEmailManager, { target: host, props: { uid: 'agt_a', agents: api as never, onclose: vi.fn(), onchanged: vi.fn(async () => {}) } });
  await settle(); return api;
}
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === text)!;
it('connects explicitly, reads back, validates and saves an address, and confirms disconnect', async () => {
  const api = await setup();
  expect(api.connectEmail).not.toHaveBeenCalled();
  button('Connect email').click(); await settle();
  expect(api.connectEmail).toHaveBeenCalledWith('agt_a');
  expect(host.textContent).toContain('scout@example.test');
  const input = host.querySelector('input')!;
  input.value = 'invalid name'; input.dispatchEvent(new Event('input')); await settle();
  expect(button('Save address').disabled).toBe(true);
  input.value = 'scout-new'; input.dispatchEvent(new Event('input')); await settle();
  button('Save address').click(); await settle();
  expect(api.updateEmailAddress).toHaveBeenCalledWith('agt_a', 'scout-new');
  expect(host.textContent).toContain('scout-new@example.test');
  button('Disconnect email').click(); await settle();
  expect(api.disconnectEmail).not.toHaveBeenCalled();
  button('Confirm disconnect').click(); await settle();
  expect(api.disconnectEmail).toHaveBeenCalledWith('agt_a');
  expect(button('Connect email')).toBeDefined();
});
it('keeps the current address and draft when the server rejects a rename', async () => {
  const api = await setup('scout@example.test');
  api.updateEmailAddress.mockResolvedValueOnce({ ok: false, status: 409 } as never);
  const input = host.querySelector('input')!; input.value = 'taken'; input.dispatchEvent(new Event('input')); await settle();
  button('Save address').click(); await settle();
  expect(host.querySelector('[role=alert]')?.textContent).toContain('unavailable');
  expect(host.textContent).toContain('scout@example.test');
  expect(input.value).toBe('taken');
});

// @vitest-environment happy-dom
import { mount, unmount, tick } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import BotIdentityEditor from './BotIdentityEditor.svelte';

let component: ReturnType<typeof mount> | undefined;
let host: HTMLElement;
const profile = { agent: { uid: 'agt_a', displayName: 'Scout', title: 'Researcher', description: 'Find answers.' }, editable: { title: true, description: true } };
const settle = async () => { for (let i = 0; i < 8; i++) { await tick(); await Promise.resolve(); } };
async function setup(options: { saveOk?: boolean; readOk?: boolean; titleEditable?: boolean } = {}) {
  host = document.createElement('div'); document.body.appendChild(host);
  const api = {
    getProfile: vi.fn(async () => options.readOk === false ? { ok: false } : { ok: true, value: { ...profile, editable: { title: options.titleEditable ?? true, description: true } } }),
    getStatus: vi.fn(async () => ({ ok: false })),
    updateProfile: vi.fn(async () => ({ ok: options.saveOk ?? true, value: {} })),
  };
  const updated = vi.fn();
  component = mount(BotIdentityEditor, { target: host, props: { uid: 'agt_a', name: 'Cached name', agents: api as never, onupdated: updated } });
  await settle();
  return { api, updated };
}
function fill(selector: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(selector)!;
  input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
}
async function submit() {
  host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await settle();
}
afterEach(async () => { if (component) await unmount(component); component = undefined; host?.remove(); });

it('loads authoritative fields and sends only changed profile fields', async () => {
  const { api, updated } = await setup();
  expect(host.querySelector<HTMLInputElement>('[data-testid="edit-bot-name"]')!.value).toBe('Scout');
  fill('[data-testid="edit-bot-name"]', '  Atlas  ');
  await tick(); await submit();
  expect(api.updateProfile).toHaveBeenCalledWith('agt_a', { displayName: 'Atlas' });
  expect(updated).toHaveBeenCalledWith({ displayName: 'Atlas' });
  expect(host.textContent).toContain('Changes saved');
});

it('rejects a blank name and never sends a mutation', async () => {
  const { api } = await setup();
  fill('[data-testid="edit-bot-name"]', '   ');
  await tick(); await submit();
  expect(api.updateProfile).not.toHaveBeenCalled();
  expect(host.querySelector<HTMLButtonElement>('[data-testid="edit-bot-save"]')!.disabled).toBe(true);
});

it('preserves edits when saving fails and does not update the parent', async () => {
  const { api, updated } = await setup({ saveOk: false });
  fill('textarea', 'A new purpose'); await tick(); await submit();
  expect(api.updateProfile).toHaveBeenCalledWith('agt_a', { description: 'A new purpose' });
  expect(host.querySelector('textarea')!.value).toBe('A new purpose');
  expect(host.textContent).toContain('Could not save changes');
  expect(updated).not.toHaveBeenCalled();
});

it('keeps a denied profile read disabled', async () => {
  const { api } = await setup({ readOk: false });
  expect(host.querySelector('fieldset')!.disabled).toBe(true);
  await submit(); expect(api.updateProfile).not.toHaveBeenCalled();
});

it('honors server restrictions on title edits', async () => {
  const { api } = await setup({ titleEditable: false });
  expect(host.querySelector<HTMLInputElement>('input[id$="-title"]')!.readOnly).toBe(true);
  fill('input[id$="-title"]', 'Not allowed');
  fill('[data-testid="edit-bot-name"]', 'Atlas');
  await tick(); await submit();
  expect(api.updateProfile).toHaveBeenCalledWith('agt_a', { displayName: 'Atlas' });
});

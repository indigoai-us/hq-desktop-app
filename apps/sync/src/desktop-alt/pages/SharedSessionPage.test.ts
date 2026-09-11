// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('svelte', async () => {
  // @ts-expect-error Browser runtime for real component mounting.
  return await import('../../../node_modules/svelte/src/index-client.js');
});
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
import { mount, unmount } from 'svelte';
import SharedSessionPage from './SharedSessionPage.svelte';

let component: ReturnType<typeof mount> | undefined;
afterEach(async () => {
  if (component) await unmount(component);
  component = undefined;
  document.body.innerHTML = '';
  invoke.mockReset();
  vi.useRealTimers();
});
function open() {
  component = mount(SharedSessionPage, { target: document.body, props: { channelId: 'chn_project', sessionId: 'shared-1' } });
}
it('loads every transcript page with no execution or composer controls', async () => {
  invoke.mockResolvedValueOnce({ session: { title: 'Launch planning' }, messages: [{ sequence: 0, role: 'user', text: 'First page' }], nextCursor: 1 })
    .mockResolvedValue({ session: { title: 'Launch planning' }, messages: [{ sequence: 1, role: 'assistant', text: 'Last page' }], nextCursor: null });
  open();
  await vi.waitFor(() => expect(document.body.textContent).toContain('Last page'));
  expect(document.body.textContent).toContain('First page');
  expect(document.body.textContent).toContain('Read only');
  expect(document.querySelector('textarea, [contenteditable=true]')).toBeNull();
  expect(invoke.mock.calls.map(([name]) => name)).toEqual(['project_sessions_read', 'project_sessions_read']);
  expect(invoke.mock.calls[1][1].after).toBe('1');
});
it('clears displayed transcript and title when membership is revoked', async () => {
  vi.useFakeTimers();
  invoke.mockResolvedValueOnce({ session: { title: 'Private project title' }, messages: [{ sequence: 0, role: 'assistant', text: 'Member-only answer' }], nextCursor: null })
    .mockRejectedValue(new Error('404'));
  open();
  await vi.advanceTimersByTimeAsync(1);
  expect(document.body.textContent).toContain('Member-only answer');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(document.body.textContent).not.toContain('Member-only answer');
  expect(document.body.textContent).not.toContain('Private project title');
  expect(document.body.textContent).toContain('This session is unavailable');
  expect(invoke.mock.calls.every(([name]) => name === 'project_sessions_read')).toBe(true);
});

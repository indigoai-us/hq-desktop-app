// @vitest-environment happy-dom
import { mount, unmount, tick } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import BotRoutinesHost from './BotRoutinesHost.svelte';
let component: ReturnType<typeof mount> | undefined;
let host: HTMLElement;
const settle = async () => { for (let i = 0; i < 15; i++) { await tick(); await Promise.resolve(); } };
afterEach(async () => { if (component) await unmount(component); component = undefined; host?.remove(); });
async function setup(source = 'live', ok = true, editable = true) {
  host = document.createElement('div'); host.className = 'desktop-shell'; document.body.appendChild(host);
  let enabled = true;
  const api = {
    getProfile: vi.fn(async () => ({ ok: true, value: { agent: { uid: 'agt_a' }, boxFreshness: { source }, box: { routines: [{ id: 'r1', name: 'Brief', prompt: 'Summarize priorities.', enabled, editable, schedule: { cadence: 'daily', expr: '0 9 * * *' } }] } } })),
    runtimeAction: vi.fn(async (_uid, request) => { if (ok && request.actionId === 'cron.pause') enabled = false; return { ok, value: {} }; }),
  };
  component = mount(BotRoutinesHost, { target: host, props: { uid: 'agt_a', name: 'Scout', agents: api as never, jobs: [], unavailable: null, onpause: async () => true } });
  await settle(); return api;
}
async function click(text: string) {
  const button = [...host.querySelectorAll('button')].find(el => el.textContent?.trim() === text);
  expect(button).toBeTruthy(); button!.click(); await settle();
}
it('reads without mutations and routes pause to the correct bot and routine', async () => {
  const api = await setup();
  expect(api.runtimeAction).not.toHaveBeenCalled();
  host.querySelector<HTMLButtonElement>('[data-testid="routine-card"]')!.click(); await settle();
  await click('Pause');
  expect(api.runtimeAction).toHaveBeenCalledWith('agt_a', expect.objectContaining({ actionId: 'cron.pause', params: { jobId: 'r1' }, idempotencyKey: expect.any(String) }));
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Resume');
});
it('retains enabled state when the action is refused', async () => {
  await setup('live', false);
  host.querySelector<HTMLButtonElement>('[data-testid="routine-card"]')!.click(); await settle(); await click('Pause');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not complete');
  expect([...host.querySelectorAll('button')].some(el => el.textContent?.trim() === 'Pause')).toBe(true);
});
it('shows cached routines read-only and disables creation', async () => {
  const api = await setup('cache');
  expect([...host.querySelectorAll('button')].find(el => el.textContent?.includes('New routine'))?.disabled).toBe(true);
  host.querySelector<HTMLButtonElement>('[data-testid="routine-card"]')!.click(); await settle();
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain('read-only');
  expect(api.runtimeAction).not.toHaveBeenCalled();
});
it('respects per-routine edit restrictions', async () => {
  const api = await setup('live', true, false);
  host.querySelector<HTMLButtonElement>('[data-testid="routine-card"]')!.click(); await settle();
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain('read-only');
  expect(api.runtimeAction).not.toHaveBeenCalled();
});

it('reuses the idempotency key when a refused action is retried', async () => {
  const api = await setup('live', false);
  host.querySelector<HTMLButtonElement>('[data-testid="routine-card"]')!.click(); await settle();
  await click('Pause'); await click('Pause');
  expect(api.runtimeAction.mock.calls[0][1].idempotencyKey).toBe(api.runtimeAction.mock.calls[1][1].idempotencyKey);
});

it('hides previous routines and the legacy section during a refresh, then clears failed data', async () => {
  const api = await setup();
  let finish!: (value: never) => void;
  api.getProfile.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  host.querySelector<HTMLButtonElement>('[aria-label="Refresh routines"]')!.click();
  await settle();
  expect(host.querySelector('[data-testid="bot-routines-loading"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="routine-card"]')).toBeNull();
  expect(host.textContent).not.toContain('Scheduled jobs');
  finish({ ok: false } as never);
  await settle();
  expect(host.querySelector('[data-testid="routine-card"]')).toBeNull();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Could not load');
});

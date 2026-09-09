// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('svelte', async () => {
  // @ts-expect-error Browser entry needed by mounted tests.
  return await import('../../../node_modules/svelte/src/index-client.js');
});
const api = vi.hoisted(() => ({ providerLoginStart: vi.fn(), providerLoginStatus: vi.fn(), providerLoginCancel: vi.fn() }));
const shell = vi.hoisted(() => ({ open: vi.fn(async () => {}) }));
vi.mock('@tauri-apps/plugin-shell', () => ({ open: shell.open }));
vi.mock('../../desktop-alt/lib/live-session-store.svelte', () => ({ liveSessionStore: api }));
import { mount, unmount, flushSync } from 'svelte';
import ProviderConnect from './ProviderConnect.svelte';
let component: ReturnType<typeof mount>;
const onconnected = vi.fn(), onchoose = vi.fn();
function render(extra = {}) { component = mount(ProviderConnect, { target: document.body, props: {
  selected: 'claude', claudeAvailable: true, codexAvailable: true,
  claudeConnected: false, codexConnected: false, onconnected, onchoose, ...extra,
} }); flushSync(); }
function click(label: string) { const button = [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === label); expect(button).toBeTruthy(); button!.click(); flushSync(); }
async function settle() { for (let i=0;i<8;i++) { await Promise.resolve(); flushSync(); } }
beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); api.providerLoginStart.mockResolvedValue({ state:'waiting' }); api.providerLoginStatus.mockResolvedValue({ state:'waiting' }); api.providerLoginCancel.mockResolvedValue({ state:'disconnected' }); });
afterEach(() => { if(component)unmount(component); document.body.innerHTML=''; vi.useRealTimers(); });
describe('provider connection', () => {
  it('starts once, polls for real success, and reports connection to the page', async () => {
    render(); click('Connect Claude'); await settle(); click('Connect Claude');
    expect(api.providerLoginStart).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain('Waiting for browser sign-in');
    expect(onconnected).not.toHaveBeenCalled();
    api.providerLoginStatus.mockResolvedValue({ state:'connected' });
    await vi.advanceTimersByTimeAsync(1500); await settle();
    expect(onconnected).toHaveBeenCalledWith('claude');
  });
  it('cancels the managed login and stops polling', async () => {
    render(); click('Connect Codex'); await settle(); click('Cancel sign-in'); await settle();
    expect(api.providerLoginCancel).toHaveBeenCalledWith('codex');
    await vi.advanceTimersByTimeAsync(6000);
    expect(api.providerLoginStatus).not.toHaveBeenCalled();
    expect(onconnected).not.toHaveBeenCalled();
  });
  it('keeps connection errors retryable without false success', async () => {
    api.providerLoginStart.mockRejectedValueOnce(new Error('internal sensitive error'));
    render(); click('Connect Claude'); await settle();
    expect(document.body.textContent).toContain('Could not open sign-in');
    expect(document.body.textContent).not.toContain('internal sensitive error');
    click('Try again'); await settle();
    expect(api.providerLoginStart).toHaveBeenCalledTimes(2);
    expect(onconnected).not.toHaveBeenCalled();
  });
  it('offers the connected alternative and does not start login for it', async () => {
    render({codexConnected:true}); click('Use Codex'); await settle();
    expect(onchoose).toHaveBeenCalledWith('codex');
    expect(api.providerLoginStart).not.toHaveBeenCalled();
  });
  it('discards results after navigating away', async () => {
    let resolve!: (v:unknown)=>void;
    api.providerLoginStart.mockReturnValue(new Promise(r=>resolve=r));
    render(); click('Connect Claude'); unmount(component); component=undefined!;
    resolve({state:'connected'}); await settle(); expect(onconnected).not.toHaveBeenCalled();
  });
  it('links a missing provider to the desktop app that carries its CLI instead of a dead end', async () => {
    render({ claudeAvailable: false, codexAvailable: false });
    const links = [...document.querySelectorAll('a')];
    expect(links.map(a => a.getAttribute('href'))).toEqual(['https://claude.ai/download', 'https://chatgpt.com/download']);
    expect(document.body.textContent).toContain('Install the Claude app (it includes Claude Code), then check again.');
    expect(document.body.textContent).toContain('Install the ChatGPT app (it includes Codex), then check again.');
    links[0].click(); await settle();
    expect(shell.open).toHaveBeenCalledWith('https://claude.ai/download');
    expect(api.providerLoginStart).not.toHaveBeenCalled();
  });
});

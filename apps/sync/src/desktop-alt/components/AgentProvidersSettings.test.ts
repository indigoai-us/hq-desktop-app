// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('svelte', async () => {
  // @ts-expect-error Browser entry needed by mounted tests.
  return await import('../../../node_modules/svelte/src/index-client.js');
});
const api = vi.hoisted(() => ({
  preflight: vi.fn(),
  slashCommands: vi.fn(),
  installProvider: vi.fn(),
  providerLoginStart: vi.fn(),
  providerLoginStatus: vi.fn(),
  invalidatePreflight: vi.fn(),
}));
vi.mock('../lib/live-session-store.svelte', () => ({ liveSessionStore: api }));
import { flushSync, mount, unmount } from 'svelte';
import AgentProvidersSettings from './AgentProvidersSettings.svelte';

const PREFLIGHT = {
  hqRoot: '/hq',
  hooksReady: true,
  hooksError: null,
  claudeAvailable: true,
  claudeLoggedIn: true,
  codexAvailable: false,
  codexLoggedIn: false,
  grokAvailable: true,
  grokLoggedIn: false,
  companies: [],
};

let component: ReturnType<typeof mount>;

async function settle() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    flushSync();
  }
}

describe('Settings → Agents', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.preflight.mockResolvedValue(PREFLIGHT);
    api.slashCommands.mockImplementation(async (tool: string) => {
      if (tool === 'claude') {
        return { commands: [], models: [{ value: 'claude-fable-5-1[1m]', displayName: 'Fable' }] };
      }
      if (tool === 'grok') {
        return { commands: [], models: [{ value: 'grok-4.6', displayName: 'Grok 4.6' }] };
      }
      return { commands: [], models: [] };
    });
    component = mount(AgentProvidersSettings, { target: document.body });
  });
  afterEach(() => {
    if (component) unmount(component);
    document.body.innerHTML = '';
  });

  it('lists each provider with signed-in state and live models for ready agents', async () => {
    await settle();
    expect(document.querySelector('[data-testid="settings-agents"]')).not.toBeNull();
    expect(document.body.textContent).toContain('Signed in on this device');
    expect(document.body.textContent).toContain('Installed, not signed in');
    expect(document.body.textContent).toContain('Not installed');
    expect(document.querySelector('[data-testid="settings-agent-claude-models"]')?.textContent).toContain('Fable');
    expect(document.body.textContent).toContain('Usage stays with this provider');
    expect(document.body.textContent).toContain('Install Codex');
    expect(document.body.textContent).toContain('Connect Grok');
  });

  it('installs a missing CLI from Settings', async () => {
    api.installProvider.mockResolvedValue('ok');
    await settle();
    const button = [...document.querySelectorAll('button')].find((el) => el.textContent?.trim() === 'Install Codex');
    expect(button).toBeTruthy();
    button!.click();
    await settle();
    expect(api.installProvider).toHaveBeenCalledWith('codex', expect.any(Function));
    expect(api.invalidatePreflight).toHaveBeenCalled();
  });
});

// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error client entry has no public type export.
  return await import('../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import V4TitleBar from '../../src/desktop-alt/v4/V4TitleBar.svelte';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const normalize = (source: string) => source.replace(/\s+/g, ' ');

describe('desktop sync failure recovery', () => {
  const titleBar = normalize(read('src/desktop-alt/v4/V4TitleBar.svelte'));
  const desktop = normalize(read('src/desktop-alt/DesktopApp.svelte'));

  it('replaces the failed title bar with the established recovery message and actions', () => {
    expect(titleBar).toContain("syncState === 'error' ? 'Sync initialized' : model.sentence");
    expect(titleBar).toContain('Click the button to finish sync in Claude Code.');
    expect(titleBar).toContain('label="Finish sync in Claude Code"');
    expect(titleBar).toContain('label="Copy prompt"');
  });

  it('hands the full failure context and HQ folder to the shared prompt controls', () => {
    expect(titleBar).toContain(
      "issue={{ kind: 'sync-failed', payload: { message: errorMessage, company: errorCompany } }}",
    );
    expect(titleBar).toContain("syncState === 'error' && errorMessage");
    expect(titleBar).toContain("folder={hqFolderPath ?? ''}");
    expect(desktop).toContain('errorMessage={syncErrorMessage}');
    expect(desktop).toContain('errorCompany={syncErrorCompany}');
    expect(desktop).toContain('{hqFolderPath}');
  });

  it('uses the shared Claude launcher, which retains clipboard fallback', () => {
    const launcher = normalize(read('src/components/OpenInClaudeCodeButton.svelte'));
    expect(titleBar).toContain(
      "import OpenInClaudeCodeButton from '../../components/OpenInClaudeCodeButton.svelte'",
    );
    expect(launcher).toContain("await invoke('open_claude_code_link', { url })");
    expect(launcher).toContain('await navigator.clipboard.writeText(prompt)');
  });
});

describe('rendered desktop sync failure recovery', () => {
  let host: HTMLDivElement;
  let component: ReturnType<typeof mount> | null = null;
  const writeText = vi.fn();

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    invoke.mockReset();
    writeText.mockReset();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
  });

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    host.remove();
    vi.useRealTimers();
  });

  function renderFailure() {
    component = mount(V4TitleBar, {
      target: host,
      props: {
        syncState: 'error',
        watchedCount: 16,
        errorSummary: 'Runner exited with code 2',
        errorMessage: 'hq-sync-runner exited with code 2',
        errorCompany: 'indigo',
        hqFolderPath: '/Users/test/HQ',
      },
    });
    flushSync();
  }

  it('renders Retry alongside both agent-assisted recovery actions', () => {
    renderFailure();
    expect(host.textContent).toContain('Sync initialized');
    expect(host.textContent).toContain('Click the button to finish sync in Claude Code.');
    expect(host.textContent).toContain('Finish sync in Claude Code');
    expect(host.textContent).toContain('Copy prompt');
    expect(host.textContent).toContain('Retry');
  });

  it('retries sync from the failed-state title bar', () => {
    const onretry = vi.fn();
    component = mount(V4TitleBar, {
      target: host,
      props: {
        syncState: 'error',
        watchedCount: 16,
        errorMessage: 'hq-sync-runner exited with code 2',
        hqFolderPath: '/Users/test/HQ',
        onretry,
      },
    });
    flushSync();
    const retry = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Retry',
    );
    retry?.click();
    expect(onretry).toHaveBeenCalledOnce();
  });

  it('copies the diagnostic prompt from the explicit Copy prompt action', async () => {
    renderFailure();
    const button = host.querySelector<HTMLButtonElement>('[aria-label="Copy prompt for an HQ agent"]');
    button?.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0]).toContain('while syncing "indigo"');
    expect(writeText.mock.calls[0][0]).toContain('hq-sync-runner exited with code 2');
  });

  it('falls back to the clipboard when Claude cannot open', async () => {
    invoke.mockRejectedValueOnce(new Error('Claude Code is not installed'));
    renderFailure();
    const button = host.querySelector<HTMLButtonElement>(
      '[aria-label^="Finish sync in Claude Code"]',
    );
    button?.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(host.textContent).toContain('Prompt copied');
    expect(writeText.mock.calls[0][0]).toContain('hq-sync-runner exited with code 2');
  });
});

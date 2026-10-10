// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));

import { flushSync, mount, tick, unmount } from 'svelte';
import ConnectorImportStep from './ConnectorImportStep.svelte';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await tick();
  flushSync();
}

function mountStep(
  oncomplete = vi.fn(),
  company: string | null = 'acme',
): ReturnType<typeof vi.fn> {
  component = mount(ConnectorImportStep, {
    target: host,
    props: { company, oncomplete },
  });
  return oncomplete;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  tauri.invoke.mockReset();
});

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  host.remove();
  vi.restoreAllMocks();
});

describe('ConnectorImportStep', () => {
  it('records the precise zero-server detection result and its only inspected source', async () => {
    tauri.invoke.mockResolvedValue({
      present: true,
      count: 0,
      outcome: 'config_invalid',
      inspectedSources: 'claude_desktop_config',
    });
    const onTelemetry = vi.fn();
    component = mount(ConnectorImportStep, {
      target: host,
      props: { company: 'acme', oncomplete: vi.fn(), onTelemetry },
    });

    await flush();

    expect(onTelemetry).toHaveBeenLastCalledWith({
      action: 'skipped',
      detectedToolCount: 0,
      detectedSourceSet: 'claude_desktop_config',
      outcome: 'config_invalid',
    });
  });

  it('auto-skips when Claude Desktop has no connectors', async () => {
    tauri.invoke.mockResolvedValue({ present: false, count: 0, path: '/config' });
    const oncomplete = mountStep();

    await flush();

    expect(oncomplete).toHaveBeenCalledOnce();
    expect(host.querySelector('[data-testid="connector-import-offer"]')).toBeNull();
  });

  it('offers to import detected Claude Desktop connectors', async () => {
    tauri.invoke.mockResolvedValue({ present: true, count: 2, path: '/config' });
    const oncomplete = mountStep();

    await flush();

    expect(host.textContent).toContain('We found 2 Claude Desktop connectors.');
    expect(host.querySelector('[data-testid="connector-import-import"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="connector-import-skip"]')).not.toBeNull();
    expect(oncomplete).not.toHaveBeenCalled();
  });

  it('runs the CLI importer when Import is selected', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'detect_claude_desktop_connectors') {
        return { present: true, count: 1, path: '/config' };
      }
      return { ok: true, message: 'Imported connector.' };
    });
    mountStep();
    await flush();

    host.querySelector<HTMLButtonElement>('[data-testid="connector-import-import"]')?.click();
    await flush();

    expect(tauri.invoke).toHaveBeenCalledWith('import_claude_desktop_connectors', {
      company: 'acme',
    });
    expect(host.querySelector('[data-testid="connector-import-success"]')?.textContent).toContain(
      'available in HQ integrations',
    );
  });

  it('shows a plain failure with Try again and Skip for now, and no command text', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'detect_claude_desktop_connectors') {
        return { present: true, count: 1, path: '/config' };
      }
      return {
        ok: false,
        message: 'hq: No active company memberships found. Use --company <slug> to specify.',
        errorCategory: 'exit-nonzero',
      };
    });
    const oncomplete = mountStep();
    await flush();

    host.querySelector<HTMLButtonElement>('[data-testid="connector-import-import"]')?.click();
    await flush();

    const failure = host.querySelector('[data-testid="connector-import-failure"]');
    expect(failure?.textContent).toContain("We couldn't bring in your Claude Desktop connectors.");
    expect(host.querySelector('[data-testid="connector-import-retry"]')?.textContent).toContain(
      'Try again',
    );
    expect(host.querySelector('[data-testid="connector-import-skip"]')?.textContent).toContain(
      'Skip for now',
    );
    expect(host.querySelector('[data-testid="connector-import-continue"]')).toBeNull();
    expect(host.querySelector('code')).toBeNull();
    const text = host.textContent ?? '';
    expect(text).not.toMatch(/\bhq /);
    expect(text).not.toContain('--company');
    expect(text).not.toContain('memberships');
    expect(text).not.toMatch(/[\u2013\u2014]/);

    host.querySelector<HTMLButtonElement>('[data-testid="connector-import-skip"]')?.click();
    expect(oncomplete).toHaveBeenCalledOnce();
  });

  it('runs the import again from Try again and reaches success', async () => {
    let attempts = 0;
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'detect_claude_desktop_connectors') {
        return { present: true, count: 1, path: '/config' };
      }
      attempts += 1;
      return attempts === 1
        ? { ok: false, message: 'temporary', errorCategory: 'exit-nonzero' }
        : { ok: true, message: 'Imported connector.' };
    });
    const oncomplete = mountStep();
    await flush();

    host.querySelector<HTMLButtonElement>('[data-testid="connector-import-import"]')?.click();
    await flush();
    host.querySelector<HTMLButtonElement>('[data-testid="connector-import-retry"]')?.click();
    await flush();

    expect(attempts).toBe(2);
    expect(
      tauri.invoke.mock.calls.filter(([command]) => command === 'import_claude_desktop_connectors'),
    ).toEqual([
      ['import_claude_desktop_connectors', { company: 'acme' }],
      ['import_claude_desktop_connectors', { company: 'acme' }],
    ]);
    expect(host.querySelector('[data-testid="connector-import-success"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="connector-import-failure"]')).toBeNull();
    expect(oncomplete).not.toHaveBeenCalled();
  });

  it('does nothing for a Personal setup: no detection, no import, no screen', async () => {
    tauri.invoke.mockResolvedValue({ present: true, count: 3, path: '/config' });
    const onTelemetry = vi.fn();
    const oncomplete = vi.fn();
    component = mount(ConnectorImportStep, {
      target: host,
      props: { company: null, oncomplete, onTelemetry },
    });
    await flush();

    expect(oncomplete).toHaveBeenCalledOnce();
    expect(tauri.invoke).not.toHaveBeenCalled();
    expect(onTelemetry).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="connector-import-offer"]')).toBeNull();
    expect(host.querySelector('[data-testid="connector-import-failure"]')).toBeNull();
    expect(host.textContent?.trim()).toBe('');
  });

  it('reports an import failure with its bounded category and never the importer message', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'detect_claude_desktop_connectors') {
        return {
          present: true,
          count: 1,
          outcome: 'servers_detected',
          inspectedSources: 'claude_desktop_config',
        };
      }
      return {
        ok: false,
        message: 'C:\\Users\\alice\\HQ\\hq integrations import failed',
        errorCategory: 'exit-nonzero',
      };
    });
    const onTelemetry = vi.fn();
    component = mount(ConnectorImportStep, {
      target: host,
      props: { company: 'acme', oncomplete: vi.fn(), onTelemetry },
    });
    await flush();

    host.querySelector<HTMLButtonElement>('[data-testid="connector-import-import"]')?.click();
    await flush();

    expect(onTelemetry).toHaveBeenLastCalledWith({
      action: 'failed',
      detectedToolCount: 1,
      detectedSourceSet: 'claude_desktop_config',
      outcome: 'import_failed',
      errorCategory: 'exit-nonzero',
    });
    expect(JSON.stringify(onTelemetry.mock.calls)).not.toContain('alice');
  });
});

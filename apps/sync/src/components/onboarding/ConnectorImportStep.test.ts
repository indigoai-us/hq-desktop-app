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

function mountStep(oncomplete = vi.fn()): ReturnType<typeof vi.fn> {
  component = mount(ConnectorImportStep, {
    target: host,
    props: { oncomplete },
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
      props: { oncomplete: vi.fn(), onTelemetry },
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

    expect(tauri.invoke).toHaveBeenCalledWith('import_claude_desktop_connectors');
    expect(host.querySelector('[data-testid="connector-import-success"]')?.textContent).toContain(
      'available in HQ integrations',
    );
  });

  it('keeps completion available when import fails', async () => {
    tauri.invoke.mockImplementation(async (command: string) => {
      if (command === 'detect_claude_desktop_connectors') {
        return { present: true, count: 1, path: '/config' };
      }
      return { ok: false, message: 'CLI failure' };
    });
    const oncomplete = mountStep();
    await flush();

    host.querySelector<HTMLButtonElement>('[data-testid="connector-import-import"]')?.click();
    await flush();

    expect(host.querySelector('[data-testid="connector-import-failure"]')?.textContent).toContain(
      'hq integrations import',
    );
    host.querySelector<HTMLButtonElement>('[data-testid="connector-import-continue"]')?.click();
    expect(oncomplete).toHaveBeenCalledOnce();
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
      props: { oncomplete: vi.fn(), onTelemetry },
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

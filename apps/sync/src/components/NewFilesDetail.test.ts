// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

interface NewFilePayload {
  path: string;
  bytes: number;
  addedBy: string | null;
}

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  listHandler: null as ((event: { payload: NewFilePayload[] }) => void) | null,
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));

import { flushSync, mount, unmount } from 'svelte';
import NewFilesDetail from './NewFilesDetail.svelte';

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  flushSync();
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  tauri.invoke.mockReset().mockResolvedValue(undefined);
  tauri.unlisten.mockReset();
  tauri.listHandler = null;
  tauri.listen.mockReset().mockImplementation(
    async (
      eventName: string,
      handler: (event: { payload: NewFilePayload[] }) => void,
    ) => {
      if (eventName === 'new-files:list') tauri.listHandler = handler;
      // Tauri returns one unlisten closure per registration. The shared spy is
      // kept only as the observable invocation counter.
      return vi.fn(() => tauri.unlisten());
    },
  );
});

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  host.remove();
  vi.restoreAllMocks();
});

describe('NewFilesDetail native window', () => {
  it('registers the payload listener before completing the visible-window handshake', async () => {
    component = mount(NewFilesDetail, { target: host });
    await flush();

    expect(tauri.listen).toHaveBeenCalledWith('new-files:list', expect.any(Function));
    expect(tauri.invoke).toHaveBeenCalledWith('detail_window_ready');
    expect(tauri.listen.mock.invocationCallOrder[0]).toBeLessThan(
      tauri.invoke.mock.invocationCallOrder[0],
    );
  });

  it('renders file provenance and readable sizes from the native payload', async () => {
    component = mount(NewFilesDetail, { target: host });
    await flush();

    tauri.listHandler?.({
      payload: [
        {
          path: 'companies/indigo/knowledge/brief.md',
          bytes: 1536,
          addedBy: 'maya@getindigo.ai',
        },
        {
          path: 'companies/indigo/knowledge/context.md',
          bytes: 12,
          addedBy: null,
        },
      ],
    });
    flushSync();

    expect(host.querySelector('[data-testid="new-files-count"]')?.textContent).toContain(
      '2 files',
    );
    const rows = host.querySelectorAll('[data-testid="new-file-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('companies/indigo/knowledge/brief.md');
    expect(rows[0]?.textContent).toContain('maya@getindigo.ai');
    expect(rows[0]?.textContent).toContain('1.5 KB');
    expect(rows[1]?.textContent).toContain('Unknown contributor');
  });

  it('unregisters the native listener when the detail window unmounts', async () => {
    component = mount(NewFilesDetail, { target: host });
    await flush();
    await unmount(component);
    component = null;

    expect(tauri.unlisten).toHaveBeenCalledOnce();
  });
});

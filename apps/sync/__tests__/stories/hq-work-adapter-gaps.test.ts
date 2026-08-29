import { describe, expect, it, vi } from 'vitest';
import {
  createSyncPlatformAdapter,
  type SyncInvokeFn,
} from '../../src/lib/hq-work-adapter';

interface Invocation {
  command: string;
  args?: Record<string, unknown>;
}

function makeAdapter(settings: Record<string, unknown> = { untouched: true }) {
  const calls: Invocation[] = [];
  const invoke: SyncInvokeFn = async (command, args) => {
    calls.push({ command, args });
    if (command === 'get_settings') return settings;
    return null;
  };
  return { adapter: createSyncPlatformAdapter({ invoke }), calls };
}

function expectOk(result: { ok: boolean }): void {
  expect(result.ok).toBe(true);
}

describe('Sync PlatformAdapter mapped HQ Work actions', () => {
  it('maps marketplace.installPack with its selected typed scope', async () => {
    const { adapter, calls } = makeAdapter();

    expectOk(
      await adapter.marketplace.installPack({
        slug: 'starter-pack',
        version: '1.2.3',
        scope: { kind: 'company', slug: 'indigo' },
      }),
    );

    expect(calls).toEqual([
      {
        command: 'install_marketplace_pack',
        args: {
          slug: 'starter-pack',
          version: '1.2.3',
          scope: { kind: 'company', slug: 'indigo' },
        },
      },
    ]);
  });

  it('maps marketplace.recordInstall into Rust InstallScope', async () => {
    const { adapter, calls } = makeAdapter();

    expectOk(
      await adapter.marketplace.recordInstall('lst_1', {
        scope: 'company',
        companySlug: 'indigo',
      }),
    );

    expect(calls).toEqual([
      {
        command: 'record_marketplace_install',
        args: {
          listingId: 'lst_1',
          scope: { kind: 'company', slug: 'indigo' },
        },
      },
    ]);
  });

  it('maps marketplace.uploadCreatorAvatar file paths', async () => {
    const { adapter, calls } = makeAdapter();

    expectOk(await adapter.marketplace.uploadCreatorAvatar('/tmp/avatar.png'));

    expect(calls).toEqual([
      {
        command: 'upload_creator_avatar',
        args: { filePath: '/tmp/avatar.png' },
      },
    ]);
  });

  it('maps marketplace.yank with its audit reason', async () => {
    const { adapter, calls } = makeAdapter();

    expectOk(await adapter.marketplace.yank('lst_1', 'DMCA takedown'));

    expect(calls).toEqual([
      {
        command: 'yank_marketplace_listing',
        args: { id: 'lst_1', reason: 'DMCA takedown' },
      },
    ]);
  });

  it('maps shell.pickFile(image) to the native avatar picker', async () => {
    const { adapter, calls } = makeAdapter();

    expectOk(await adapter.shell.pickFile('image'));

    expect(calls).toEqual([{ command: 'pick_avatar_file', args: undefined }]);
  });

  it('decodes the board-scoped project reference before setting its status', async () => {
    const { adapter, calls } = makeAdapter();

    expectOk(
      await adapter.projects.setProjectStatus(
        JSON.stringify({
          boardPath: 'companies/indigo/projects/board.json',
          projectId: 'project_1',
          prdPath: 'companies/indigo/projects/project_1/prd.json',
        }),
        'done',
      ),
    );

    expect(calls).toEqual([
      {
        command: 'set_local_project_status',
        args: {
          boardPath: 'companies/indigo/projects/board.json',
          projectId: 'project_1',
          prdPath: 'companies/indigo/projects/project_1/prd.json',
          status: 'done',
        },
      },
    ]);
  });

  it('persists dock visibility before reusing the native apply command', async () => {
    const { adapter, calls } = makeAdapter({ untouched: true, dockIcon: true });

    expectOk(await adapter.appShell.setDockVisible(false));

    expect(calls).toEqual([
      { command: 'get_settings', args: undefined },
      {
        command: 'save_settings',
        args: { prefs: { untouched: true, dockIcon: false } },
      },
      { command: 'apply_dock_icon', args: undefined },
    ]);
  });

  it('persists widget visibility before reusing the native apply command', async () => {
    const { adapter, calls } = makeAdapter({ untouched: true, widgetEnabled: false });

    expectOk(await adapter.appShell.setDesktopWidget(true));

    expect(calls).toEqual([
      { command: 'get_settings', args: undefined },
      {
        command: 'save_settings',
        args: { prefs: { untouched: true, widgetEnabled: true } },
      },
      { command: 'apply_widget_settings', args: undefined },
    ]);
  });

  it('serializes concurrent dock and widget preference writes through the shared queue', async () => {
    let persisted = { untouched: true, dockIcon: true, widgetEnabled: false };
    let saveCount = 0;
    let inFlightSaves = 0;
    let maxInFlightSaves = 0;
    let releaseFirstSave = () => {};
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    const savedSnapshots: Record<string, unknown>[] = [];
    const calls: Invocation[] = [];
    const invoke: SyncInvokeFn = async (command, args) => {
      calls.push({ command, args });
      if (command === 'get_settings') return { ...persisted };
      if (command === 'save_settings') {
        saveCount += 1;
        inFlightSaves += 1;
        maxInFlightSaves = Math.max(maxInFlightSaves, inFlightSaves);
        const prefs = { ...((args?.prefs ?? {}) as Record<string, unknown>) };
        savedSnapshots.push(prefs);
        if (saveCount === 1) await firstSaveGate;
        inFlightSaves -= 1;
        persisted = prefs;
        return undefined;
      }
      if (command === 'apply_dock_icon' || command === 'apply_widget_settings') {
        return undefined;
      }
      throw new Error(`Unexpected command: ${command}`);
    };
    const adapter = createSyncPlatformAdapter({ invoke });

    const dock = adapter.appShell.setDockVisible(false);
    await vi.waitFor(() => expect(savedSnapshots).toHaveLength(1));
    const widget = adapter.appShell.setDesktopWidget(true);

    await vi.waitFor(() => expect(maxInFlightSaves).toBe(1));
    expect(savedSnapshots).toHaveLength(1);
    releaseFirstSave();

    expectOk(await dock);
    expectOk(await widget);
    expect(persisted).toEqual({
      untouched: true,
      dockIcon: false,
      widgetEnabled: true,
    });
    expect(savedSnapshots[1]).toEqual({
      untouched: true,
      dockIcon: false,
      widgetEnabled: true,
    });
    expect(calls.filter(({ command }) => command.startsWith('apply_'))).toEqual([
      { command: 'apply_dock_icon', args: undefined },
      { command: 'apply_widget_settings', args: undefined },
    ]);
  });

  it('returns an invoke failure without applying the stale app-shell preference', async () => {
    const calls: Invocation[] = [];
    const invoke: SyncInvokeFn = async (command, args) => {
      calls.push({ command, args });
      if (command === 'get_settings') return { dockIcon: true };
      if (command === 'save_settings') throw new Error('disk unavailable');
      throw new Error(`Unexpected command: ${command}`);
    };
    const adapter = createSyncPlatformAdapter({ invoke });

    await expect(adapter.appShell.setDockVisible(false)).resolves.toMatchObject({
      ok: false,
      reason: 'error',
      code: 'invoke',
      message: 'disk unavailable',
    });
    expect(calls).toEqual([
      { command: 'get_settings', args: undefined },
      { command: 'save_settings', args: { prefs: { dockIcon: false } } },
    ]);
  });
});

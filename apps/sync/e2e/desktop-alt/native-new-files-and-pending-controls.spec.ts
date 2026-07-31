import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

describe('native new-files detail and pending-control contracts', () => {
  const main = readRepoFile('src/main.ts');
  const detail = readRepoFile('src/components/NewFilesDetail.svelte');
  const native = readRepoFile('src-tauri/src/commands/new_files.rs');
  const capability = readRepoFile('src-tauri/capabilities/new-files-detail.json');
  const harness = readRepoFile('dev-harness/Harness.svelte');
  const settings = readRepoFile('src/desktop-alt/pages/SettingsPage.svelte');
  const meetings = readRepoFile('src/desktop-alt/pages/MeetingsPage.svelte');
  const agenda = readRepoFile('src/desktop-alt/components/MeetingsAgenda.svelte');
  const installed = readRepoFile('src/desktop-alt/panels/InstalledPacksPanel.svelte');

  it('mounts the typed detail renderer for the registered native window', () => {
    expect(main).toContain(
      "import NewFilesDetail from './components/NewFilesDetail.svelte';",
    );
    expect(main).toContain("else if (windowLabel === 'new-files-detail')");
    expect(main).toContain(
      'Component = NewFilesDetail as unknown as typeof App',
    );
    expect(native).toContain('pub const WINDOW_LABEL: &str = "new-files-detail"');
    expect(capability).toContain('"windows": ["new-files-detail"]');
    expect(harness).toContain("view === 'new-files'");
    expect(harness).toContain('<NewFilesDetail');
    expect(harness).toContain("emit('new-files:list', newFilesPreview)");
  });

  it('keeps the hidden-window handshake race-free and visibly completes it', () => {
    const listenIndex = detail.indexOf("listen<NewFile[]>('new-files:list'");
    const readyIndex = detail.indexOf("invoke('detail_window_ready')");
    expect(listenIndex).toBeGreaterThan(-1);
    expect(readyIndex).toBeGreaterThan(listenIndex);
    expect(native).toContain('.visible(false)');
    expect(native).toContain('app.emit_to(WINDOW_LABEL, "new-files:list", &files)');
    expect(native).toContain('window.show()');
    expect(native).toContain('window.set_focus()');
    expect(detail).toContain('data-testid="new-files-detail"');
    expect(detail).toContain('data-testid="new-file-row"');
  });

  it('uses the neutral liquid-glass detail-window treatment', () => {
    expect(detail).toContain(
      ":global(html[data-window='new-files-detail'] body)",
    );
    expect(detail).toContain('background: var(--compact-glass-bg)');
    expect(detail).toContain('backdrop-filter: var(--glass-filter');
    expect(detail).not.toMatch(/(?:blue|indigo|yellow|amber|#(?:[0-9a-f]{3})?ff[0-9a-f]*)/i);
    expect(native).toContain('.transparent(true)');
    expect(native).toContain('apply_compact_communications_glass_window');
  });

  it('labels every audited Settings and Meetings pending action', () => {
    expect(settings).toContain('data-testid="settings-update-packs"');
    expect(settings).toContain('aria-busy={packsUpdating}');
    expect(settings).toContain(
      "aria-label={packsUpdating ? 'Updating installed packs' : 'Update installed packs'}",
    );

    expect(meetings).toContain('data-testid="meetings-report-problem"');
    expect(meetings).toContain('aria-busy={reporting}');
    expect(meetings).toContain(
      "aria-label={reporting ? 'Reporting refresh problem' : 'Report refresh problem'}",
    );
    expect(meetings).toContain('data-testid="meetings-refresh"');
    expect(meetings).toContain('aria-busy={loading}');
    expect(meetings).toContain(
      "aria-label={loading ? 'Refreshing meetings' : 'Refresh meetings'}",
    );
    expect(meetings).toContain('data-testid="meetings-url-invite"');
    expect(meetings).toContain('aria-busy={urlInviting}');
    expect(meetings).toContain(
      "aria-label={urlInviting ? 'Inviting recording bot' : 'Invite recording bot'}",
    );

    expect(agenda).toContain('aria-busy={invitePending}');
    expect(agenda).toContain('aria-busy={uninvitePending}');
    expect(agenda).toContain('aria-busy={joinNowPending}');
    expect(agenda).not.toContain('aria-busy={pending}');
    expect(agenda).toContain(
      "aria-label={invitePending ? 'Inviting bot' : recurring ? 'Invite bot to series' : 'Invite bot'}",
    );
  });

  it('keeps pack mutation feedback attached to the exact affected control', () => {
    expect(installed).toContain(
      "function isPackBusy(op: 'install' | 'update' | 'uninstall', id: string)",
    );
    expect(installed).toContain(
      "aria-busy={isPackBusy('update', p.name)}",
    );
    expect(installed).toContain(
      "aria-label={isPackBusy('update', p.name) ? `Updating ${p.name}` : `Update ${p.name}`}",
    );
    expect(installed).toContain(
      "aria-busy={isPackBusy('uninstall', p.name)}",
    );
    expect(installed).toContain(
      "aria-label={isPackBusy('uninstall', p.name) ? `Removing ${p.name}` : `Remove ${p.name}`}",
    );
    expect(installed).toContain(
      "aria-busy={isPackBusy('install', a.source)}",
    );
    expect(installed).toContain(
      "aria-busy={isPackBusy('install', r.slug)}",
    );
    expect(installed).toContain(
      "busy = { op: 'install', id: source, label: shortSource(source) }",
    );
  });
});

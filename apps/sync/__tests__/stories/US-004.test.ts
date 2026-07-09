import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const popoverSource = readFileSync(
  resolve(process.cwd(), 'src/components/Popover.svelte'),
  'utf8',
);

function normalize(source: string): string {
  return source.replace(/\s+/g, ' ');
}

function getDesktopAltGate(source = popoverSource): string {
  const footer = source.indexOf('<div class="mbp-foot">');
  expect(footer).toBeGreaterThanOrEqual(0);

  const start = source.lastIndexOf('{#if desktopAltEnabled}', footer);
  expect(start).toBeGreaterThanOrEqual(0);

  const end = source.indexOf('{/if}', start);
  expect(end).toBeGreaterThan(start);

  return source.slice(start, end);
}

function getDesktopAltButton(source = popoverSource): string {
  const gate = getDesktopAltGate(source);
  const start = gate.indexOf('<button');
  expect(start).toBeGreaterThanOrEqual(0);

  const end = gate.indexOf('</button>', start);
  expect(end).toBeGreaterThan(start);

  return gate.slice(start, end);
}

describe('US-004: Desktop view affordance in the redesigned popover', () => {
  it('renders the desktop view CTA as the mbpop footer while the overflow menu + Sync live in the header', () => {
    const gate = getDesktopAltGate();
    const compactGate = normalize(gate);
    const compactSource = normalize(popoverSource);
    const toggleIndex = gate.indexOf('data-testid="desktop-alt-toggle"');

    // The desktop-alt toggle keeps its existing test id, but moved from the
    // header icon cluster to the prototype footer CTA.
    expect(toggleIndex).toBeGreaterThanOrEqual(0);
    expect(compactGate).toContain('<button class="mbp-open"');
    expect(compactGate).toContain('onclick={openDesktopAltWindow}');
    expect(compactGate).toContain('data-testid="popover-open-desktop-view"');
    expect(compactGate).toContain('Open desktop view');

    // Notifications-first redesign header: HQ mark, overflow ("More"), Sync.
    // Settings moved OUT of the header (no standalone gear) and into the More
    // menu, which stays wired to openSettings.
    expect(compactSource).toContain('class="mbp-head"');
    expect(compactSource).not.toContain('data-testid="popover-settings-gear"');
    expect(compactSource).toContain('data-testid="popover-overflow-button"');
    expect(compactSource).toContain('data-testid="popover-sync-button"');
    expect(compactSource).toContain('onclick={openSettings}');
    expect(compactSource).not.toContain('class="header-icon-button desktop-alt-toggle"');
    expect(compactSource).not.toContain('<button class="footer-action" onclick={onsettings}>');
  });

  it('wires the toggle click to invoke open_desktop_alt_window exactly once', () => {
    const button = normalize(getDesktopAltButton());
    const handler = normalize(
      popoverSource.slice(
        popoverSource.indexOf('async function openDesktopAltWindow()'),
        popoverSource.indexOf('$effect(() => {', popoverSource.indexOf('async function openDesktopAltWindow()')),
      ),
    );
    const invokeMatches = handler.match(/invoke\('open_desktop_alt_window'\)/g) ?? [];

    expect(button).toContain('onclick={openDesktopAltWindow}');
    expect(invokeMatches).toHaveLength(1);
    expect(handler).toContain("await invoke('open_desktop_alt_window')");
  });

  it('keeps the desktop-alt toggle absent from the non-Indigo DOM path', () => {
    const gate = getDesktopAltGate();
    const sourceWithoutGate = popoverSource.replace(gate, '');

    expect(sourceWithoutGate).not.toContain('data-testid="desktop-alt-toggle"');
    expect(normalize(popoverSource)).toContain('desktopAltEnabled = false');
  });

  it('surfaces failures as a compact inline notice and auto-dismisses within 5s', () => {
    const compactSource = normalize(popoverSource);

    expect(compactSource).toContain("console.error('open_desktop_alt_window failed:', e)");
    expect(compactSource).toContain("showDesktopAltError('Could not open desktop view.')");
    // The failure notice folds into the notifications feed as a pinned
    // system-notice row (alert glyph + preview) instead of a separate banner.
    expect(compactSource).toContain('<div class="notif-row" role="status">');
    expect(compactSource).toContain('<div class="notif-summary">{desktopAltError}</div>');
    expect(compactSource).toContain('desktopAltErrorTimer = setTimeout(() => {');
    expect(compactSource).toContain("desktopAltError = ''");
    expect(compactSource).toMatch(/},\s*5000\)/);
    expect(compactSource).toContain('clearDesktopAltErrorTimer()');
  });

  it('keeps the redesigned header on a single mbp row and removes the legacy action cluster', () => {
    const compactSource = normalize(popoverSource);

    expect(compactSource).toContain('<header class="mbp-head" data-tauri-drag-region>');
    expect(compactSource).not.toContain('has-desktop-alt-controls');
    expect(compactSource).toContain('<span class="mbp-mark" data-tauri-drag-region>');
    expect(compactSource).not.toContain('class="header-spacer"');
    expect(compactSource).not.toContain('<div class="header-text">');
    expect(compactSource).not.toContain('<div class="header-actions">');
  });
});

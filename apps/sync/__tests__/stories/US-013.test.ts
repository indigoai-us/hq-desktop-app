import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopApp = readFileSync(
  resolve(process.cwd(), 'src/desktop-alt/DesktopApp.svelte'),
  'utf8',
);
const trayApp = readFileSync(resolve(process.cwd(), 'src/App.svelte'), 'utf8');
const statusBar = readFileSync(
  resolve(process.cwd(), 'src/desktop-alt/DesktopStatusBar.svelte'),
  'utf8',
);
const commandPalette = readFileSync(
  resolve(process.cwd(), 'src/desktop-alt/components/CommandPalette.svelte'),
  'utf8',
);

function normalize(source: string): string {
  return source.replace(/\s+/g, ' ');
}

describe('US-013: Status bar + global ⌘K command surface', () => {
  it('DESKTOP-001: status bar component remains intact but is unmounted from the shell', () => {
    const app = normalize(desktopApp);
    const tray = normalize(trayApp);
    const bar = normalize(statusBar);

    // Tray still uses the shared effective-total helper for its own progress.
    expect(tray).toContain('computeEffectiveTotalFiles({ planReceived: syncPlanReceived,');
    // Shell no longer mounts the bottom status bar (titlebar owns sync chrome).
    expect(desktopApp).not.toContain('<DesktopStatusBar');
    expect(app).toContain('computeEffectiveTotalFiles({ planReceived: syncPlanReceived,');
    // Component still implements the live strip for potential reuse / version popout.
    expect(bar).toContain('<div class="ls-left">');
    expect(bar).toContain('<div class="ls-right">');
    expect(bar).toContain('Idle · all safe');
    expect(bar).toContain('v{version}');
    expect(desktopApp).toContain('loadMeetingsCache<MeetingEvent, ScheduledBot, GoogleAccount, GoogleCalendar>()');
  });

  it('opens a modal command palette on cmd/ctrl-K with Sync now as the first row', () => {
    const app = normalize(desktopApp);
    const palette = normalize(commandPalette);

    expect(app).toContain("event.key.toLowerCase() === 'k'");
    expect(app).toContain('commandPaletteOpen = true');
    expect(app).toMatch(/const commandItems = \$derived<CommandPaletteItem\[]>\(\[\s*\{\s*id: 'command-sync-now',\s*label: 'Sync now'/);
    expect(app).toContain("label: 'Sync now'");
    expect(app).toContain('action: handleSyncAll');
    expect(app).toContain("label: 'Open settings'");
    expect(app).toContain('action: handleOpenSettings');
    // V4 IA (US-002): the first navigation entry is Home (the old Sync surface).
    expect(app).toContain("label: 'Go to Home'");
    expect(app).toContain("action: () => navigate({ kind: 'home' })");
    expect(app).toContain("label: 'Go to Meetings'");
    expect(app).toContain("action: () => navigate({ kind: 'meetings' })");
    expect(app).toContain('label: `Go to ${row.label}`');
    expect(app).toContain("action: () => navigate({ kind: 'company', slug: row.slug })");
    expect(app).toContain('<CommandPalette commands={commandItems} onclose={() => (commandPaletteOpen = false)} />');
    expect(palette).toContain('role="dialog"');
    expect(palette).toContain('aria-modal="true"');
    expect(palette).toContain('bind:value={query}');
    expect(palette).toContain('role="listbox"');
    expect(palette).toContain('role="option"');
    expect(palette).toContain('button');
    expect(palette).toContain('function fuzzyMatch');
  });

  it('fuzzy-filters meet to Go to Meetings, executes Enter, switches the main pane, and closes on Enter or Esc', () => {
    const app = normalize(desktopApp);
    const palette = normalize(commandPalette);

    expect(palette).toContain('fuzzyMatch(`${command.label} ${command.detail} ${command.shortcut ?? \'\'}`, query)');
    expect(app).toMatch(/label: 'Go to Meetings'[\s\S]*detail: 'Show calendar and recordings'[\s\S]*action: \(\) => navigate\(\{ kind: 'meetings' \}\)/);
    expect(app).toContain("{:else if route.kind === 'meetings'}");
    expect(app).toContain('<MeetingsPage />');

    expect(palette).toContain("if (event.key === 'ArrowDown')");
    expect(palette).toContain("if (event.key === 'ArrowUp')");
    expect(palette).toContain("if (event.key === 'Enter')");
    expect(palette).toContain('void execute(filteredCommands[highlightedIndex])');
    expect(palette).toContain('await command.action();');
    expect(palette).toContain('onclose();');
    expect(palette).toContain('onfocus={() => { highlightedIndex = index; }}');
    expect(palette).toContain("if (event.key === 'Escape')");
    expect(palette).toContain('onkeydown={handleKeydown}');
    expect(palette).toContain('bind:this={inputEl}');
    expect(palette).toContain('onclick={() => void execute(command)}');
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// OWNER-R3: clicking a "meeting detected" banner opens Meetings in the HQ
// window, where the detected meeting shows Start recording. It used to only
// reveal the menubar popover. Record on the banner still starts recording
// directly, and the popover stays the fallback when the window can't open.
const app = readFileSync(resolve(process.cwd(), 'src/App.svelte'), 'utf8');
const norm = (s: string): string => s.replace(/\s+/g, ' ');

describe('meeting-detected banner body click opens Meetings', () => {
  const a = norm(app);
  const meetingBranch = a.slice(
    a.indexOf("} else if (kind === 'meeting') {"),
    a.indexOf("throw new Error('Unsupported notification action')"),
  );

  it('opens the HQ window on the Meetings route', () => {
    expect(meetingBranch).toContain(
      "await invoke('open_desktop_alt_window', { route: bannerOpenRoute('meeting', data) ?? 'meetings' });",
    );
  });

  it('falls back to the popover when the window cannot open', () => {
    expect(meetingBranch).toMatch(/catch \(err\) \{ console\.warn\([^)]*\); await invoke\('show_main_window'\); \}/);
  });

  it('keeps Record starting the recording only on the explicit click', () => {
    expect(meetingBranch).toContain("if (action === 'record' && windowId) { await handleStartRecording(windowId, true);");
  });
});

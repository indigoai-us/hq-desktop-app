import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Source-contract gate for the ad-hoc "paste a meeting URL" invite bar on the
// desktop-alt Meetings page. The classic MeetingsWindow has always had this
// affordance; the desktop-alt page shipped without it (only per-calendar-row
// invite/join buttons), so a user with a meeting NOT on their calendar had no
// way to send the bot from the new view. These assertions lock the parity in.
const root = process.cwd();

const meetingsPage = readFileSync(
  join(root, 'src/desktop-alt/pages/MeetingsPage.svelte'),
  'utf8',
);
const meetingsStore = readFileSync(
  join(root, 'src/desktop-alt/lib/meetings-store.svelte.ts'),
  'utf8',
);

describe('desktop-alt meetings url-invite', () => {
  it('the Meetings page renders the paste-a-URL bar', () => {
    expect(meetingsPage).toContain('Paste a Zoom or Google Meet URL');
  });

  it('the page wires the bar to the store URL-invite path (stays invoke-free of the bot call)', () => {
    // The page delegates the network call to the store, mirroring how the
    // per-row invite/join buttons already work.
    expect(meetingsPage).toContain('meetingsStore.inviteBotByUrl');
    // It gates the Invite button/Enter key on a plausible link so a bogus paste
    // can't schedule a bot.
    expect(meetingsPage).toContain('isPlausibleMeetingUrl');
    // A destination picker (Personal default + companies) must be present.
    expect(meetingsPage).toContain('>Personal<');
  });

  it('the store defines and exposes inviteBotByUrl', () => {
    expect(meetingsStore).toMatch(/async function inviteBotByUrl\s*\(/);
    // Exposed on the reactive read surface so the page can call it.
    expect(meetingsStore).toMatch(/\n\s*inviteBotByUrl,/);
  });

  it('inviteBotByUrl schedules an ad-hoc bot with NO calendar event behind it', () => {
    // The defining contract of a URL-invite: calendarEventId + calendarSeriesId
    // are null (there is no calendar event), which is what distinguishes it from
    // the per-row inviteBot. Assert the null payload lives inside the function.
    const fnStart = meetingsStore.indexOf('async function inviteBotByUrl');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = meetingsStore.slice(fnStart, fnStart + 900);
    expect(fnBody).toContain("invoke<ScheduledBot>('meetings_invite_bot'");
    expect(fnBody).toContain('calendarEventId: null');
    expect(fnBody).toContain('calendarSeriesId: null');
  });
});

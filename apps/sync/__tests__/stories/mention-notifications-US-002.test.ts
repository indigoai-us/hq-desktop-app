import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { bannerOpenRoute } from '../../src/lib/bannerActionRouter';
import { routeForNotificationPayload } from '../../src/lib/notificationRoutes';

const read = (...parts: string[]) =>
  readFileSync(resolve(process.cwd(), ...parts), 'utf8');

describe('US-002: mention notification opens the exact message', () => {
  it('maps kind mention onto inbox:channel:<channelId>:<messageId>', () => {
    const payload = {
      channelId: 'chn_eng',
      eventId: 'evt_mention',
      fromPersonUid: 'prs_ada',
    };
    expect(routeForNotificationPayload(payload)).toBe(
      'inbox:channel:chn_eng:evt_mention',
    );
    expect(bannerOpenRoute('mention', payload)).toBe(
      'inbox:channel:chn_eng:evt_mention',
    );
  });

  it('App.svelte mention open fronts the main window on the mapped route', () => {
    const app = read('src/App.svelte').replace(/\s+/g, ' ');
    const mentionBranch = app.slice(
      app.indexOf("} else if (kind === 'mention')"),
      app.indexOf("} else if (kind === 'share')"),
    );
    expect(mentionBranch).toContain("invoke('open_desktop_alt_window'");
    expect(mentionBranch).toContain("bannerOpenRoute('mention', data)");
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { routeForNotificationPayload } from '../../src/lib/notificationRoutes';
import { bannerOpenRoute } from '../../src/lib/bannerActionRouter';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const read = (...parts: string[]) => readFileSync(root(...parts), 'utf8');
const norm = (s: string): string => s.replace(/\s+/g, ' ');

const app = read('src/App.svelte');
const unNotify = read('src-tauri/src/commands/un_notify.rs');
const dmNotify = read('src-tauri/src/commands/dm_notify.rs');
const shareNotify = read('src-tauri/src/commands/share_notify.rs');
const tray = read('src-tauri/src/tray.rs');
const trayHelper = read('src-tauri/src/tray_helper.rs');
const swift = read('src-tauri/helper/hq-tray-helper.swift');

describe('US-002: notification clicks open the exact thread while the app is running', () => {
  it('maps native DM body-click payloads onto inbox:dm:<fromPersonUid>', () => {
    expect(
      routeForNotificationPayload({ fromPersonUid: 'prs_ada', eventId: 'evt_1' }),
    ).toBe('inbox:dm:prs_ada');
    expect(bannerOpenRoute('dm', { fromPersonUid: 'prs_ada' })).toBe(
      'inbox:dm:prs_ada',
    );
  });

  it('maps native share body-click payloads onto inbox:dm:<issuerUid>', () => {
    expect(routeForNotificationPayload({ issuerUid: 'prs_izzy' })).toBe(
      'inbox:dm:prs_izzy',
    );
    expect(bannerOpenRoute('share', { issuerPersonUid: 'prs_maya' })).toBe(
      'inbox:dm:prs_maya',
    );
  });

  it('App.svelte open actions front the main window on the mapped route, not the quick detail windows', () => {
    const a = norm(app);
    const dmBranch = a.slice(
      a.indexOf("if (kind === 'dm')"),
      a.indexOf("} else if (kind === 'share')"),
    );
    const shareBranch = a.slice(
      a.indexOf("} else if (kind === 'share')"),
      a.indexOf("} else if (kind === 'update')"),
    );

    expect(dmBranch).toContain("invoke('open_desktop_alt_window'");
    expect(dmBranch).toContain("bannerOpenRoute('dm', data)");
    expect(dmBranch).not.toContain("invoke('open_dm_detail'");

    expect(shareBranch).toContain("invoke('open_desktop_alt_window'");
    expect(shareBranch).toContain("bannerOpenRoute('share', data)");
    expect(shareBranch).not.toContain("invoke('open_share_detail'");
  });

  it('keeps share dropdown Open in Claude and Copy on the templated prompt', () => {
    const a = norm(app);
    const shareBranch = a.slice(
      a.indexOf("} else if (kind === 'share')"),
      a.indexOf("} else if (kind === 'update')"),
    );
    expect(shareBranch).toContain("if (action === 'claude')");
    expect(shareBranch).toContain("invoke('open_claude_code_link'");
    expect(shareBranch).toContain('buildSharedPrompt(data)');
    expect(shareBranch).toContain("if (action === 'copy')");
    expect(shareBranch).toContain('navigator.clipboard.writeText(prompt)');
  });

  it('keeps the quick Inbox reachable from the tray menu', () => {
    expect(app).toContain("listen('tray:open-inbox'");
    expect(app).toContain("route: 'inbox'");
    expect(tray).toContain('MENU_OPEN_INBOX');
    expect(tray).toContain('Open Inbox');
    expect(tray).toContain('tray:open-inbox');
    expect(trayHelper).toContain('"inbox"');
    expect(swift).toContain('Open Inbox');
    expect(swift).toContain('writeCommand("inbox")');
  });

  it('posts DM/share thread ids on UN userInfo so a native body-click can name the route', () => {
    expect(unNotify).toContain('fromPersonUid');
    expect(unNotify).toContain('channelId');
    expect(unNotify).toContain('eventId');
    expect(unNotify).toContain('issuerUid');
    expect(unNotify).toContain('fn click_destination_route');
    expect(unNotify).toContain('inbox:dm:');
    expect(unNotify).toContain('inbox:channel:');
    expect(dmNotify).toContain('from_person_uid');
    expect(dmNotify).toContain('MessageUserInfo');
    expect(shareNotify).toContain('issuer_uid');
    expect(shareNotify).toContain('MessageUserInfo');
  });
});

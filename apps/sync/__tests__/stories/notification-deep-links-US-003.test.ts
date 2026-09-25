import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const read = (...parts: string[]) => readFileSync(root(...parts), 'utf8');

const unNotify = read('src-tauri/src/commands/un_notify.rs');
const dmNotify = read('src-tauri/src/commands/dm_notify.rs');
const shareNotify = read('src-tauri/src/commands/share_notify.rs');
const desktopAlt = read('src-tauri/src/commands/desktop_alt.rs');
const app = read('src/App.svelte');

describe('US-003: cold-start notification clicks land on the thread', () => {
  it('posts an explicit route string on DM/share UN userInfo', () => {
    expect(unNotify).toContain('set_user_info_string(user_info, "route"');
    expect(unNotify).toContain('fn resolve_click_route');
    expect(unNotify).toContain('inbox:dm:');
    expect(dmNotify).toContain('encode_action_payload');
    expect(shareNotify).toContain('encode_action_payload');
  });

  it('didReceive prefers the explicit route and still falls back to kind+ids', () => {
    expect(unNotify).toContain('explicit_route');
    expect(unNotify).toContain('resolve_click_route(');
    expect(unNotify).toContain('open_desktop_alt_window_inner');
    expect(unNotify).toContain('explicit_route_in_user_info_wins_over_kind_and_ids');
    expect(unNotify).toContain('missing_route_falls_back_to_kind_and_ids');
  });

  it('registers Copy prompt, Open details, and Open in Claude on UN categories', () => {
    expect(unNotify).toContain('Copy prompt');
    expect(unNotify).toContain('Open details');
    expect(unNotify).toContain('Open in Claude');
    expect(unNotify).toContain('setCategoryIdentifier');
    expect(unNotify).toContain('setNotificationCategories');
    expect(unNotify).toContain('hq-dm');
    expect(unNotify).toContain('hq-share');
  });

  it('dropdown actions emit the existing frontend events with the same action ids', () => {
    expect(unNotify).toContain('notification:dm-action');
    expect(unNotify).toContain('notification:share-action');
    expect(unNotify).toContain('ACTION_COPY');
    expect(unNotify).toContain('ACTION_OPEN');
    expect(unNotify).toContain('ACTION_CLAUDE');
    expect(app).toContain("action === 'copy'");
    expect(app).toContain("action === 'claude'");
    expect(app).toContain("action === 'open'");
  });

  it('cold start still queues the route on the pending-route cell', () => {
    expect(desktopAlt).toContain('set_pending_route(route)');
    expect(desktopAlt).toContain('desktop_alt_consume_pending_route');
    expect(unNotify).toContain('open_desktop_alt_window_inner');
  });

  it('never logs raw userInfo or a URL verbatim from the UN click path', () => {
    expect(unNotify).toContain('route_label_for_log');
    expect(unNotify).not.toMatch(/log!\([^)]*userInfo/);
    expect(unNotify).not.toMatch(/logfile::log\(\s*"notify",\s*&format!\([^)]*user_info/);
  });
});

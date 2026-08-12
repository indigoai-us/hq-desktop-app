/**
 * US-004 — Single-window activation and navigation
 *
 * Source-contract coverage for the WindowRouter activation matrix, typed
 * desktop destinations, tray/taskbar → compact popover, Open HQ → one desktop,
 * and legacy open_* wrappers that no longer spawn top-level windows.
 *
 * Note: apps/sync/__tests__/stories/US-004.test.ts is a legacy chrome-free
 * menubar story — do not overwrite it. This file is the acceptance suite for
 * hq-desktop-windows-reliability / US-004.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePendingDesktopRoute } from '../../src/desktop-alt/route';

const repoRoot = join(process.cwd());

function readRepo(...parts: string[]): string {
  const path = join(repoRoot, ...parts);
  expect(existsSync(path), `missing ${parts.join('/')}`).toBe(true);
  return readFileSync(path, 'utf8');
}

function readTray(): string {
  return readRepo('src-tauri/src/tray.rs');
}

function readMain(): string {
  return readRepo('src-tauri/src/main.rs');
}

function readDesktopAlt(): string {
  return readRepo('src-tauri/src/commands/desktop_alt.rs');
}

describe('US-004: Single-window activation and navigation', () => {
  describe('typed WindowRouter policy', () => {
    it('declares ActivationSource, ActivationAction, DesktopDestination, and open_destination', () => {
      const src = readDesktopAlt();
      expect(src).toMatch(/enum\s+ActivationSource/);
      expect(src).toMatch(/TrayLeftClick/);
      expect(src).toMatch(/TaskbarSecondProcess/);
      expect(src).toMatch(/OpenHqMenu/);
      expect(src).toMatch(/DesktopShortcut/);
      expect(src).toMatch(/CompactShortcut/);
      expect(src).toMatch(/enum\s+ActivationAction/);
      expect(src).toMatch(/ToggleCompact/);
      expect(src).toMatch(/ShowCompact/);
      expect(src).toMatch(/ShowDesktop/);
      expect(src).toMatch(/fn\s+activation_policy/);
      expect(src).toMatch(/enum\s+DesktopDestination/);
      expect(src).toMatch(/Inbox/);
      expect(src).toMatch(/Messages/);
      expect(src).toMatch(/Meetings/);
      expect(src).toMatch(/Activity/);
      expect(src).toMatch(/CoreDrift/);
      expect(src).toMatch(/Library/);
      expect(src).toMatch(/fn\s+open_destination/);
      expect(src).toMatch(/open_desktop_alt_window_inner/);
    });

    it('maps destinations to pending-route strings the frontend understands', () => {
      const src = readDesktopAlt();
      // route_str arms for the top-level destinations.
      expect(src).toMatch(/Self::Home\s*\|\s*Self::Activity\s*\|\s*Self::CoreDrift\s*=>\s*"home"/);
      expect(src).toMatch(/Self::Inbox\s*=>\s*"inbox"/);
      expect(src).toMatch(/Self::Messages\s*=>\s*"messages"/);
      expect(src).toMatch(/Self::Meetings\s*=>\s*"meetings"/);
      expect(src).toMatch(/Self::Library\s*=>\s*"library"/);
      expect(src).toMatch(/Self::LibraryInstalled\s*=>\s*"library:installed"/);
    });

    it('frontend resolvePendingDesktopRoute accepts WindowRouter aliases (US-018 remaps)', () => {
      // Backend DesktopDestination::Inbox still emits "inbox"; the frontend
      // remaps the retired InboxPage deep link onto the Notifications feed.
      expect(resolvePendingDesktopRoute('inbox')).toEqual({ kind: 'notifications' });
      expect(resolvePendingDesktopRoute('notifications')).toEqual({ kind: 'notifications' });
      expect(resolvePendingDesktopRoute('messages')).toEqual({ kind: 'messages' });
      expect(resolvePendingDesktopRoute('meetings')).toEqual({ kind: 'meetings' });
      expect(resolvePendingDesktopRoute('library')).toEqual({ kind: 'library' });
      expect(resolvePendingDesktopRoute('library:installed')).toEqual({
        kind: 'library',
        tab: 'installed',
      });
      expect(resolvePendingDesktopRoute('activity')).toEqual({ kind: 'home' });
      expect(resolvePendingDesktopRoute('core-drift')).toEqual({ kind: 'home' });
      expect(resolvePendingDesktopRoute('drift')).toEqual({ kind: 'home' });
      // US-018: Mission Control page retired → Home.
      expect(resolvePendingDesktopRoute('mission-control')).toEqual({ kind: 'home' });
    });
  });

  describe('tray left-click and taskbar → compact popover', () => {
    it('Given HQ is running, when the tray icon is activated, then one compact popover is toggled and no desktop window is created', () => {
      const tray = readTray();
      expect(tray).toMatch(
        /TrayIconEvent::Click\s*\{[\s\S]*?MouseButton::Left[\s\S]*?toggle_popover_window/,
      );
      // Left-click must not open the full desktop.
      const clickBlock = tray.match(
        /on_tray_icon_event[\s\S]*?\.build\(app\)/,
      )?.[0];
      expect(clickBlock).toBeTruthy();
      expect(clickBlock).toContain('toggle_popover_window');
      expect(clickBlock).not.toContain('toggle_desktop_window');
    });

    it('Given a second-process / taskbar activation, when single-instance fires, then the compact popover is shown (not desktop-alt)', () => {
      const main = readMain();
      expect(main).toMatch(/TaskbarSecondProcess/);
      expect(main).toMatch(/single-instance[\s\S]*?show_window_at_tray|show_window_at_tray/);
      // Must not prefer focusing desktop-alt on second launch.
      expect(main).not.toMatch(
        /single_instance::init[\s\S]*?get_webview_window\("desktop-alt"\)[\s\S]*?set_focus/,
      );
    });
  });

  describe('Open HQ + desktop shortcut → one full desktop', () => {
    it('Given Open HQ menu action, when invoked, then open_desktop_alt is used', () => {
      const tray = readTray();
      expect(tray).toContain('MENU_OPEN_DESKTOP');
      expect(tray).toContain('tray:open-desktop');

      const app = readRepo('src/App.svelte');
      expect(app).toMatch(/tray:open-desktop[\s\S]*?open_desktop_alt_window/);
    });

    it('Given the desktop shortcut, when pressed, then one full desktop is shown/focused', () => {
      const main = readMain();
      expect(main).toMatch(/desktop_shortcut[\s\S]*?open_desktop_alt_window_inner/);
      expect(main).toContain('hide_desktop_alt');
    });
  });

  describe('destinations route existing desktop (no new top-level windows)', () => {
    const wrappers: Array<{ file: string; name: string; dest: string }> = [
      {
        file: 'src-tauri/src/commands/dm_notify.rs',
        name: 'open_inbox_window',
        dest: 'DesktopDestination::Inbox',
      },
      {
        file: 'src-tauri/src/commands/messages.rs',
        name: 'open_messages_window',
        dest: 'DesktopDestination::Messages',
      },
      {
        file: 'src-tauri/src/commands/meetings.rs',
        name: 'open_meetings_window',
        dest: 'DesktopDestination::Meetings',
      },
      {
        file: 'src-tauri/src/commands/activity.rs',
        name: 'open_activity_log',
        dest: 'DesktopDestination::Activity',
      },
      {
        file: 'src-tauri/src/commands/packages.rs',
        name: 'open_packages_window',
        dest: 'DesktopDestination::LibraryInstalled',
      },
    ];

    for (const w of wrappers) {
      it(`${w.name} wraps open_destination(${w.dest}) without WebviewWindowBuilder`, () => {
        const src = readRepo(w.file);
        expect(src).toContain(w.name);
        expect(src).toContain('open_destination');
        expect(src).toContain(w.dest);
        // The open_* command body must not build a new top-level webview.
        // (Other helpers in the same file may still build detail windows.)
        const cmdIdx = src.indexOf(`pub async fn ${w.name}`);
        expect(cmdIdx).toBeGreaterThan(-1);
        const body = src.slice(cmdIdx, cmdIdx + 900);
        expect(body).not.toContain('WebviewWindowBuilder');
      });
    }

    it('open_desktop_alt_window_inner reuses an existing desktop (show + focus + desktop:navigate)', () => {
      const src = readDesktopAlt();
      const idx = src.indexOf('pub async fn open_desktop_alt_window_inner');
      expect(idx).toBeGreaterThan(-1);
      const body = src.slice(idx, idx + 2500);
      expect(body).toMatch(/get_webview_window\(WINDOW_LABEL\)/);
      expect(body).toMatch(/window\.show\(\)/);
      expect(body).toMatch(/set_focus\(\)/);
      expect(body).toContain('desktop:navigate');
      expect(body).toContain('set_pending_route');
      // Single builder path uses the fixed desktop-alt label.
      expect(body).toContain('WINDOW_LABEL');
      expect(src).toMatch(/const WINDOW_LABEL:\s*&str\s*=\s*"desktop-alt"/);
    });
  });

  describe('no duplicate compact/desktop windows + deep links', () => {
    it('showing popover hides desktop-alt; opening desktop hides main popover', () => {
      const tray = readTray();
      expect(tray).toContain('pub fn hide_desktop_alt');
      expect(tray).toMatch(/show_popover_window[\s\S]*?hide_desktop_alt|hide_desktop_alt\(app\)/);

      const desktop = readDesktopAlt();
      expect(desktop).toMatch(
        /get_webview_window\("main"\)[\s\S]*?\.hide\(\)/,
      );
    });

    it('Given an already-mounted desktop and a deep link, when the link opens, then desktop:navigate focuses the route', () => {
      const desktop = readDesktopAlt();
      // Already mounted path emits live navigate instead of building again.
      expect(desktop).toMatch(
        /get_webview_window\(WINDOW_LABEL\)[\s\S]*?desktop:navigate/,
      );

      const app = readRepo('src/desktop-alt/DesktopApp.svelte');
      expect(app).toMatch(/desktop:navigate[\s\S]*?resolvePendingDesktopRoute/);
      expect(app).toContain('desktop_alt_consume_pending_route');
    });

    it('window labels for primary surfaces stay unique (main + desktop-alt only for top-level nav)', () => {
      const desktop = readDesktopAlt();
      expect(desktop).toMatch(/const WINDOW_LABEL:\s*&str\s*=\s*"desktop-alt"/);
      const tray = readTray();
      expect(tray).toContain('get_webview_window("main")');
      expect(tray).toContain('get_webview_window("desktop-alt")');
    });
  });
});

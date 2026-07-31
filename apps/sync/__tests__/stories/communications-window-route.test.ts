import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = (rel: string) =>
  fileURLToPath(new URL(`../../${rel}`, import.meta.url));

const dmNotify = readFileSync(
  root('src-tauri/src/commands/dm_notify.rs'),
  'utf8',
);
const dmDetail = readFileSync(root('src/components/DmDetail.svelte'), 'utf8');
const glass = readFileSync(root('src-tauri/src/glass.rs'), 'utf8');
const main = readFileSync(root('src-tauri/src/main.rs'), 'utf8');
const dmDetailCapability = JSON.parse(
  readFileSync(root('src-tauri/capabilities/dm-detail.json'), 'utf8'),
) as { windows: string[]; permissions: string[] };

function sourceBetween(startNeedle: string, endNeedle: string): string {
  const start = dmNotify.indexOf(startNeedle);
  const end = dmNotify.indexOf(endNeedle, start + 1);
  expect(start, `${startNeedle} must exist`).toBeGreaterThanOrEqual(0);
  expect(end, `${endNeedle} must follow ${startNeedle}`).toBeGreaterThan(start);
  return dmNotify.slice(start, end);
}

function commandBody(name: string, nextName: string): string {
  return sourceBetween(`pub async fn ${name}`, `pub async fn ${nextName}`);
}

describe('dedicated mini communications native route', () => {
  it('keeps the legacy Inbox command routed to the full desktop destination', () => {
    const body = commandBody('open_inbox_window', 'open_communications_window');

    expect(body).toContain('DesktopDestination::Inbox');
    expect(body).toContain('open_destination');
    expect(body).not.toContain('ensure_communications_window');
    expect(body).not.toContain('WebviewWindowBuilder');
  });

  it('opens the existing dm-detail shell and carries a warm channel target', () => {
    const body = commandBody('open_communications_window', 'open_dm_detail');

    expect(body).toContain('channel: Option<Channel>');
    expect(body).toContain('PendingDmEvents');
    expect(body).toContain('= Vec::new()');
    expect(body).toContain('set_pending_communications_channel');
    expect(body).toContain('ensure_communications_window(&app)');
    expect(body).toContain('take_communications_target_if_ready');
    expect(body).toContain('emit_communications_target');
    expect(body).not.toContain('DesktopDestination::Inbox');
    expect(body).not.toContain('open_destination');
  });

  it('does not mistake a created native window for a ready renderer', () => {
    const state = sourceBetween(
      'struct CommunicationsWindowState',
      '// ── Wire types',
    );
    const body = commandBody(
      'open_communications_window',
      'open_dm_detail',
    );

    expect(state).toContain('renderer_ready: bool');
    expect(state).toContain('fn take_if_ready');
    expect(state).toContain('fn mark_ready_and_take');
    expect(body).toMatch(
      /if existed \{[\s\S]*?take_communications_target_if_ready\(\)[\s\S]*?show_focus_communications_window/,
    );
  });

  it('uses the ready handshake to deliver a cold channel target before falling back to inbox', () => {
    const body = sourceBetween(
      'pub async fn dm_detail_window_ready',
      '#[cfg(test)]',
    );

    expect(body).toMatch(
      /if let Some\(event\)[\s\S]*?else if let Some\(target\)[\s\S]*?emit_communications_target[\s\S]*?else \{[\s\S]*?EVENT_DM_INBOX_OPEN/,
    );
    expect(dmNotify).toMatch(
      /fn emit_communications_target[\s\S]*?EVENT_COMMUNICATIONS_CHANNEL_OPEN/,
    );
    expect(body).toContain('window.show()');
    expect(body).toContain('window.set_focus()');
  });

  it('mounts the channel listener before the ready handshake and selects its payload', () => {
    const listener = dmDetail.search(
      /listen<Channel>\(\s*'communications:open-channel'/,
    );
    const ready = dmDetail.indexOf("invoke('dm_detail_window_ready')");

    expect(listener).toBeGreaterThanOrEqual(0);
    expect(ready).toBeGreaterThan(listener);
    expect(dmDetail.slice(listener, ready)).toContain(
      'selectChannel(channelEvent.payload)',
    );
  });

  it('presents the compact native surface as Messages, never legacy Inbox', () => {
    const builder = sourceBetween(
      'fn ensure_communications_window',
      'fn show_focus_communications_window',
    );
    const focus = sourceBetween(
      'fn show_focus_communications_window',
      '/// Open Inbox as a typed desktop destination',
    );

    expect(builder).toContain('.title("Messages")');
    expect(builder).not.toContain('.title("Inbox")');
    expect(focus).toContain('set_title("Messages")');
    expect(focus).not.toContain('set_title("Inbox")');
    expect(dmNotify).not.toContain('set_title("Direct Message")');
  });

  it('backs compact Messages with its higher-presence native material', () => {
    const builder = sourceBetween(
      'fn ensure_communications_window',
      'fn show_focus_communications_window',
    );

    expect(builder).toContain('.transparent(true)');
    expect(builder).toContain('setUnderPageBackgroundColor');
    expect(builder).toContain(
      'apply_compact_communications_glass_window',
    );
    expect(builder).not.toContain(
      'crate::glass::apply_liquid_glass_window(&glass_window)',
    );
    expect(builder).toContain('refresh_liquid_glass_window');
    expect(builder).not.toContain('TitleBarStyle::Overlay');
  });

  it('uses Regular Tahoe glass with role-specific pre-Tahoe materials', () => {
    expect(glass).toContain(
      'pub fn apply_compact_communications_glass_window',
    );
    expect(glass).toMatch(
      /GlassWindowRole::LargeWindow\s*=>\s*0[\s\S]*GlassWindowRole::CompactCommunications\s*=>\s*0/,
    );
    expect(glass).toMatch(
      /GlassWindowRole::LargeWindow\s*=>\s*NSVisualEffectMaterial::UnderWindowBackground/,
    );
    expect(glass).toMatch(
      /GlassWindowRole::CompactCommunications\s*=>\s*NSVisualEffectMaterial::Popover/,
    );

    const largeWindowHelper = glass.slice(
      glass.indexOf('pub fn apply_liquid_glass_window'),
      glass.indexOf(
        'pub fn apply_compact_communications_glass_window',
      ),
    );
    const compactHelper = glass.slice(
      glass.indexOf(
        'pub fn apply_compact_communications_glass_window',
      ),
      glass.indexOf('fn apply_macos_glass_window'),
    );
    expect(largeWindowHelper).toContain('GlassWindowRole::LargeWindow');
    expect(compactHelper).toContain(
      'GlassWindowRole::CompactCommunications',
    );
  });

  it('registers the command and retains event plus native drag capabilities', () => {
    expect(main).toContain('commands::dm_notify::open_communications_window');
    expect(dmDetailCapability.windows).toContain('dm-detail');
    expect(dmDetailCapability.permissions).toContain('core:event:default');
    expect(dmDetailCapability.permissions).toContain(
      'core:window:allow-start-dragging',
    );
  });
});

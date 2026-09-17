import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = (rel: string) =>
  fileURLToPath(new URL(`../../${rel}`, import.meta.url));

const dmNotify = readFileSync(
  root('src-tauri/src/commands/dm_notify.rs'),
  'utf8',
);
const glass = readFileSync(root('src-tauri/src/glass.rs'), 'utf8');
const main = readFileSync(root('src-tauri/src/main.rs'), 'utf8');
const mainTs = readFileSync(root('src/main.ts'), 'utf8');

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

describe('messaging entry points route into the embedded desktop', () => {
  it('keeps the legacy Inbox command routed to the full desktop destination', () => {
    const body = commandBody('open_inbox_window', 'open_communications_window');

    expect(body).toContain('DesktopDestination::Inbox');
    expect(body).toContain('open_destination');
    expect(body).not.toContain('WebviewWindowBuilder');
  });

  it('sends a channel open to the desktop workspace and builds no window', () => {
    const body = commandBody('open_communications_window', 'open_dm_detail');

    expect(body).toContain('channel: Option<Channel>');
    expect(body).toContain('maybe_intercept_conversation_open(&app, channel_id, None)');
    expect(body).not.toContain('WebviewWindowBuilder');
    expect(body).not.toContain('get_webview_window');
  });

  it('sends a DM open to the desktop workspace on the sender person route', () => {
    const body = sourceBetween('pub async fn open_dm_detail', '#[cfg(test)]');

    expect(body).toContain('event.from_person_uid.as_str()');
    expect(body).toContain('maybe_intercept_dm_open(&app, Some(person), None)');
    expect(body).not.toContain('WebviewWindowBuilder');
    expect(body).not.toContain('get_webview_window');
  });

  it('leaves no dm-detail window behind in Rust, the renderer, or the ACL', () => {
    // The dm-detail webview was unreachable — both open paths intercept
    // unconditionally — so it was deleted. Nothing may resurrect the label
    // without also restoring a capability file for it.
    expect(dmNotify).not.toContain('dm-detail');
    expect(dmNotify).not.toContain('dm_detail_window_ready');
    expect(dmNotify).not.toContain('CommunicationsWindowState');
    expect(main).not.toContain('dm_detail_window_ready');
    expect(main).not.toContain('PendingDmEvents');
    expect(mainTs).not.toContain('dm-detail');
  });

  it('keeps the compact-communications glass material its live windows still use', () => {
    // new_files.rs and permissions.rs both back their windows with this role;
    // it outlived the dm-detail window that introduced it.
    expect(glass).toContain('pub fn apply_compact_communications_glass_window');
    expect(glass).toMatch(
      /GlassWindowRole::LargeWindow\s*=>\s*0[\s\S]*GlassWindowRole::CompactCommunications\s*=>\s*0/,
    );
    expect(glass).toMatch(
      /GlassWindowRole::LargeWindow\s*=>\s*NSVisualEffectMaterial::UnderWindowBackground/,
    );
    expect(glass).toMatch(
      /GlassWindowRole::CompactCommunications\s*=>\s*NSVisualEffectMaterial::Popover/,
    );
  });

  it('keeps both entry-point commands registered for their frontend callers', () => {
    expect(main).toContain('commands::dm_notify::open_communications_window');
    expect(main).toContain('commands::dm_notify::open_dm_detail');
  });
});

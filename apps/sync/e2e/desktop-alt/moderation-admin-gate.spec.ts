import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Source-contract regression guard for the Moderation admin gate.
//
// Bug fixed here: the Moderation nav row (DesktopApp) and the ModerationPanel
// self-gate both gated on `desktop_alt_enabled`, which is the GA gate (true for
// EVERY signed-in user), not the `@getindigo.ai` admin gate. The result was the
// reviewer surface showing for normal HQ users (the server's 403 prevented an
// actual data leak, but the whole admin UI was visible). The fix adds a
// dedicated `desktop_alt_is_admin` command (→ feature_gate::is_indigo_user) and
// points both UX gates at it. These assertions ensure the gates never regress
// back to the GA gate.

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const adapter = read('../../../../packages/platform/src/tauri/sync-adapter.ts');
const moderationPanel = read('../../../../packages/ui/src/marketplace/ModerationPanel.svelte');
const desktopAltRs = read('../../src-tauri/src/commands/desktop_alt.rs');
const mainRs = read('../../src-tauri/src/main.rs');

describe('desktop-alt Moderation admin gate', () => {
  // Repointed at the @hq/ui shell when the Sessions removal deleted the
  // unreachable desktop-alt DesktopApp.svelte tree. The gate did not move —
  // the panel now reaches it through the platform adapter's identity seam
  // rather than invoking Tauri directly, which is what lets the same panel
  // render on web.

  it('the adapter maps the admin seam to the admin command, not the GA gate', () => {
    expect(adapter).toMatch(/isAdmin: \(\) => call<boolean>\('desktop_alt_is_admin'\)/);
    expect(adapter).not.toMatch(/isAdmin: \(\) => call<boolean>\('desktop_alt_enabled'\)/);
  });

  it('ModerationPanel self-gates via the admin seam, not the GA gate', () => {
    expect(moderationPanel).toContain('adapter.identity.isAdmin()');
    // The panel's doc comment names the GA gate to explain why it is NOT
    // used, so match a CALL rather than a mention — a substring check here
    // would fail on the very comment that documents the distinction.
    expect(moderationPanel).not.toMatch(/call<boolean>\('desktop_alt_enabled'\)/);
    expect(moderationPanel).not.toMatch(/invoke<boolean>\('desktop_alt_enabled'\)/);
    expect(moderationPanel).not.toMatch(/hasFeature\(['"]desktop_alt_enabled['"]\)/);
    // A non-admin gets the LOCKED surface rather than the queue.
    expect(moderationPanel).toContain('{#if isAdmin !== true}');
  });

  it('the admin command maps to the @getindigo.ai gate, distinct from the GA gate', () => {
    // desktop_alt_is_admin → is_indigo_user (@getindigo.ai)
    expect(desktopAltRs).toMatch(
      /fn desktop_alt_is_admin\(\)[\s\S]*?feature_gate::is_indigo_user\(\)/,
    );
    // desktop_alt_enabled stays the GA gate (the two must not be swapped)
    expect(desktopAltRs).toMatch(
      /fn desktop_alt_enabled\(\)[\s\S]*?feature_gate::desktop_features_enabled\(\)/,
    );
  });

  it('registers the admin command in the Tauri invoke handler', () => {
    expect(mainRs).toMatch(/commands::desktop_alt::desktop_alt_is_admin/);
  });
});

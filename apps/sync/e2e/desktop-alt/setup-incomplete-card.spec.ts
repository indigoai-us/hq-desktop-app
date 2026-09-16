import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * Regression guard for the "Finish setting up HQ" card (#432).
 *
 * The card's frontend files were dropped as collateral by #454, which reverted
 * the whole `src/desktop-alt` tree to the v0.10.109 shape to unwind the V2 chat
 * shell. Its Rust backing (`get_setup_status`) survived in src-tauri, which was
 * excluded from that revert — so the app kept answering "is setup finished?"
 * with no surface left to ask. Nothing failed, and the regression shipped in
 * every release from v0.10.114 on. #525 restored it.
 *
 * Repointed at the @hq/ui copy when the in-app Sessions subsystem was removed:
 * the desktop window mounts HqWorkWorkShell -> the @hq/ui shell, and the
 * `src/desktop-alt/DesktopApp.svelte` tree this used to read had been
 * unreachable for some time. The live card reaches its backend through the
 * platform adapter rather than a raw `invoke`, so the launch assertions below
 * name the adapter methods.
 *
 * ── KNOWN GAP, tracked in #830 ─────────────────────────────────────────────
 * This file no longer asserts that the card is MOUNTED, because in the live
 * shell it is not. Verified against origin/main before the Sessions removal:
 * neither `packages/ui/src/shell/DesktopApp.svelte` nor
 * `packages/ui/src/home/HomePage.svelte` imports it. #432/#525 has silently
 * re-opened since the shell moved to packages/ui, and the old mount assertion
 * kept passing only because it was anchored in the dead copy — which is the
 * same way this bug hid the first two times.
 *
 * Asserting the mount here would fail on `main` too, so it belongs with the
 * fix, not with this removal. #830 asks for it explicitly, and asks that it
 * assert the card REACHES RENDERED OUTPUT rather than merely that a file
 * exists — a presence check is what failed twice.
 * ──────────────────────────────────────────────────────────────────────────
 */
describe('Finish setting up HQ card', () => {
  const card = readRepoFile('../../packages/ui/src/settings/SetupIncompleteCard.svelte');

  it('offers both launch paths and a copyable prompt', () => {
    expect(card).toContain('data-testid="setup-open-claude"');
    expect(card).toContain('Open in Claude Code');
    expect(card).toContain('data-testid="setup-open-codex"');
    expect(card).toContain('Open in Codex');
    expect(card).toContain('Copy /setup');
  });

  it('reuses the host launch commands rather than reimplementing them', () => {
    // Through the platform adapter — the @hq/ui copy has no direct Tauri
    // dependency, which is what lets the same card render on web.
    expect(card).toContain('openClaudeCodeLink');
    expect(card).toContain('launchClaudeCode');
    expect(card).toContain('launchCliInTerminal');
    expect(card).toContain('buildClaudeCodeUrl');
  });

  it('reads fresh setup status, not the startup-cached lifecycle verdict', () => {
    expect(card).toContain('settings.getSetupStatus()');
    // The doc comment names the lifecycle verdict to explain the choice; the
    // contract is that it is never actually read here.
    expect(card).not.toContain('getLifecycleState()');
    expect(card).not.toContain("invoke('get_lifecycle_state')");
  });

  it('still has a backend to ask, so the surface and its command cannot drift apart', () => {
    // The half that survived #454. If this command is ever removed, the card
    // above becomes decorative and this fails rather than going quiet.
    const commands = readRepoFile('src-tauri/src/commands/lifecycle.rs');
    expect(commands).toContain('pub fn get_setup_status');
  });
});

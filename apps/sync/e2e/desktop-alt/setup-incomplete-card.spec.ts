import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * Regression guard for the "Finish setting up HQ" card (#432).
 *
 * The card's three frontend files were dropped as collateral by #454, which
 * reverted the whole `src/desktop-alt` tree to the v0.10.109 shape to unwind
 * the V2 chat shell. Its Rust backing (`get_setup_status`) survived in
 * src-tauri, which was excluded from that revert — so the app kept answering
 * "is setup finished?" with no surface left to ask. Nothing failed, and the
 * regression shipped in every release from v0.10.114 on.
 *
 * These are source contracts, not behaviour tests: a whole-tree revert never
 * breaks a behaviour test for code it deletes, it just stops running it. Only
 * an assertion anchored in DesktopApp.svelte — a file such a revert keeps —
 * can fail loudly when the card goes missing again.
 */
describe('Finish setting up HQ card', () => {
  const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
  const card = readRepoFile('src/desktop-alt/components/SetupIncompleteCard.svelte');

  it('is mounted on the Home route', () => {
    expect(desktopApp).toContain(
      "import SetupIncompleteCard from './components/SetupIncompleteCard.svelte';",
    );

    const home = desktopApp.indexOf("route.kind === 'home'");
    const mount = desktopApp.indexOf('<SetupIncompleteCard />');
    const homePage = desktopApp.indexOf('<HomePage', home);

    expect(home).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(home);
    // Above HomePage: the card is the reason an unset-up Home isn't empty.
    expect(mount).toBeLessThan(homePage);
  });

  it('offers both launch paths and a copyable prompt', () => {
    expect(card).toContain('data-testid="setup-open-claude"');
    expect(card).toContain('Open in Claude Code');
    expect(card).toContain('data-testid="setup-open-codex"');
    expect(card).toContain('Open in Codex');
    expect(card).toContain('Copy /setup');
  });

  it('reuses the installer launch commands rather than reimplementing them', () => {
    expect(card).toContain("invoke('open_claude_code_link'");
    expect(card).toContain("invoke('launch_claude_code'");
    expect(card).toContain("invoke('launch_cli_in_terminal'");
    expect(card).toContain('buildClaudeCodeUrl');
  });

  it('reads fresh setup status, not the startup-cached lifecycle verdict', () => {
    expect(card).toContain("invoke<SetupStatus>('get_setup_status')");
    // The doc comment names get_lifecycle_state to explain the choice; the
    // contract is that it is never actually invoked here.
    expect(card).not.toContain("invoke('get_lifecycle_state')");
    expect(card).not.toContain("invoke<string>('get_lifecycle_state')");
  });
});

import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

// Source-contract assertions locking the audit-batch-2 fixes (adversarially
// confirmed findings). These wire behaviors that can't be unit-tested without a
// DOM/Tauri runtime, so we assert the contract in source — a dropped wire fails
// fast without a macOS build. Mirrors the US-* / cli-update-notice story tests.

describe('audit batch 2: confirmed-finding fixes', () => {
  it('treats setup-needed as a normal zero-company run and lets all-complete settle idle', () => {
    const app = readRepoFile('src/desktop-alt/DesktopApp.svelte');
    // The current runner emits setup-needed only after personal provisioning,
    // when a brand-new account simply has no companies yet. Rust then emits a
    // synthetic all-complete, so this stays in progress until that event and
    // must not strand the desktop behind a fake setup problem.
    expect(app).toContain("listen('sync:setup-needed'");
    const setupListener = app.slice(
      app.indexOf("listen('sync:setup-needed'"),
      app.indexOf("listen<{ message: string }>('sync:auth-error'"),
    );
    expect(setupListener).toContain("syncState = 'syncing'");
    expect(setupListener).not.toContain("syncState = 'setup-needed'");
    expect(app).not.toContain("syncState !== 'setup-needed'");
  });

  it('invited channel renders a read-only preview, not a fake working composer', () => {
    const view = readRepoFile('src/components/messaging/ChannelView.svelte');
    // The invited Conversation must be readonly so a typed message can't silently
    // vanish through a no-op onsend.
    const invitedBlock = view.slice(view.indexOf('{#if invited}'));
    expect(invitedBlock).toContain('readonly={true}');
  });

  it.skip('messages rail load errors offer a retry instead of a dead-end', () => {
    const shell = readRepoFile('src/components/messaging/MessagesShell.svelte');
    expect(shell).toContain('class="rail-retry"');
    expect(shell).toContain('onclick={() => loadContacts()}');
    expect(shell).toContain('onclick={() => loadRequests()}');
  });

  it.skip('CreateChannel company dropdown never shows a raw cmp_ UID', () => {
    const create = readRepoFile('src/components/messaging/CreateChannel.svelte');
    expect(create).not.toContain('|| co.companyUid}</option>');
    expect(create).toContain("co.companyName?.trim() || 'Company'");
  });

  it('command palette always closes even if a command action throws', () => {
    const palette = readRepoFile('src/desktop-alt/components/CommandPalette.svelte');
    // try/finally so a throwing action can't leave the modal palette stuck open.
    expect(palette).toContain('try {');
    expect(palette).toContain('await command.action();');
    expect(palette).toContain('} finally {');
    expect(palette).toContain('onclose();');
  });

  it('deployments counts read as "unknown" (—) on a load error, not a fake empty', () => {
    const panel = readRepoFile('src/desktop-alt/panels/DeploymentsPanel.svelte');
    expect(panel).toContain('{#if !error}');
    expect(panel).toContain('{activeCount}');
    expect(panel).toContain('error ? "Couldn\'t load"');
  });
});

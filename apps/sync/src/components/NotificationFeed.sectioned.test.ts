import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const feedSource = readFileSync(
  new URL('./NotificationFeed.svelte', import.meta.url),
  'utf8',
);
const rowSource = readFileSync(
  new URL('./NotificationRow.svelte', import.meta.url),
  'utf8',
);
const popoverSource = readFileSync(
  new URL('./Popover.svelte', import.meta.url),
  'utf8',
);

// Source-contract coverage for the tray-popover redesign (fix/tray-notifications-
// redesign): the menubar popover's notification feed adopts the desktop Messages
// panel's sectioned layout (Conversations / Activity), stays narrow, and keeps
// long rows truncating with ellipsis rather than forcing the popover wide.
describe('NotificationFeed sectioned popover layout', () => {
  it('exposes a `sectioned` prop that groups rows into Conversations / Activity', () => {
    expect(feedSource).toContain('sectioned?: boolean;');
    expect(feedSource).toContain('sectioned = false,');
    // The two calm sections the desktop Messages panel uses.
    expect(feedSource).toContain('{:else if sectioned}');
    expect(feedSource).toContain('id="notif-conversations-label">Conversations<');
    expect(feedSource).toContain('id="notif-activity-label">Activity<');
    expect(feedSource).toContain('class="notif-section"');
  });

  it('partitions rows by kind (DMs = Conversations, everything else = Activity)', () => {
    expect(feedSource).toContain('function rowIsConversation(row: Row)');
    expect(feedSource).toContain("return row.item.kind === 'dm';");
    expect(feedSource).toContain("return row.clusterKind === 'repeated-message';");
    expect(feedSource).toContain('const conversationRows = $derived(');
    expect(feedSource).toContain('const activityRows = $derived(');
  });

  it('renders both sections through the shared NotificationRow snippet (handlers preserved)', () => {
    // Rows still route through the same snippet used by the day-grouped feed, so
    // openDm / openShare / openCompanyActivity / mark-all-read wiring is shared.
    expect(feedSource).toContain('{#snippet notifRow(row: Row)}');
    expect(feedSource).toContain('{@render notifRow(row)}');
    expect(feedSource).toContain('onopen={() => openDm(it)}');
    expect(feedSource).toContain('onopen={() => openShare(it)}');
  });

  it('styles section labels as calm uppercase muted headers with hairline dividers', () => {
    expect(feedSource).toContain('.notif-section-label {');
    expect(feedSource).toContain('text-transform: uppercase;');
    expect(feedSource).toContain('.notif-section + .notif-section {');
    expect(feedSource).toMatch(/\.notif-section \+ \.notif-section \{[^}]*border-top: 0\.5px solid/);
  });

  it('keeps rows truncating with ellipsis so a preview never forces width', () => {
    expect(rowSource).toContain('.nr-text {');
    expect(rowSource).toMatch(/\.nr-text \{[\s\S]*?text-overflow: ellipsis;/);
    expect(rowSource).toMatch(/\.nr-text \{[\s\S]*?white-space: nowrap;/);
  });
});

describe('Popover tray redesign chrome', () => {
  it('renders the feed in sectioned mode without day labels', () => {
    expect(popoverSource).toContain('showDayLabels={false}');
    expect(popoverSource).toContain('sectioned={true}');
  });

  it('stays narrow — an explicit max-width guard the Messages panel never widens', () => {
    expect(popoverSource).toMatch(/width: min\(100vw, 288px\);/);
    expect(popoverSource).toContain('max-width: 288px;');
  });

  it('keeps the sync-status line compact rather than a tall header block', () => {
    // ● All synced · 55m — a single calm chip line.
    expect(popoverSource).toContain('class="mbp-status"');
    expect(popoverSource).toMatch(/\.mbp-status \{[\s\S]*?padding: 8px 12px 6px;/);
  });

  it('keeps the actions (Mark all read, Open desktop) wired to their handlers', () => {
    expect(popoverSource).toContain('onclick={handleMarkAllRead}');
    expect(popoverSource).toContain('onclick={() => void openDesktop()}');
    expect(popoverSource).toContain('onclick={() => void openMessages()}');
  });
});

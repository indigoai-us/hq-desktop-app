import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8');

const agencyChat = source('./desktop-alt/panels/AgencyChatPanel.svelte');
const channelRoster = source('./components/messaging/ChannelRoster.svelte');
// US-018: SidebarSyncMode retired; Shared/All lives in SyncModeToggle.
const syncModeToggle = source('./components/SyncModeToggle.svelte');
const widgetSettings = source('./components/WidgetSettings.svelte');

describe('user-triggered async action feedback contracts', () => {
  it('keeps a failed agency message and retries the exact captured text', () => {
    expect(agencyChat).toContain('interface FailedSend');
    expect(agencyChat).toContain('company: string;');
    expect(agencyChat).toContain('team: string;');
    expect(agencyChat).toContain('if (draft.trim() === text) draft =');
    expect(agencyChat).toContain('company: target.company');
    expect(agencyChat).toContain('team: target.team');
    expect(agencyChat).toContain('send(visibleFailedSend!)');
    expect(agencyChat).toContain("sendingSource === 'retry'");
    expect(agencyChat).toContain('role="alert"');
  });

  it('keeps the channel roster mounted and retries removal for the failed member', () => {
    const removeBody = channelRoster.match(
      /async function remove\([\s\S]*?\n  \}\n\n  function memberLabel/,
    )?.[0];
    expect(removeBody).toBeTruthy();
    expect(removeBody).not.toContain('error =');
    expect(removeBody).toContain('channelId: targetChannelId');
    expect(removeBody).toContain('if (channelId !== targetChannelId) return;');
    expect(channelRoster).toContain('removeFailure.personUid === m.personUid');
    expect(channelRoster).toContain('remove(m.personUid, true)');
    expect(channelRoster).toContain('aria-busy={removing === m.personUid}');
  });

  it('retries the captured sync-mode mutation instead of only clearing its error', () => {
    // Live control is SyncModeToggle (US-018 retired SidebarSyncMode).
    expect(syncModeToggle).toContain('let failedMode = $state<WritableSyncMode | null>(null);');
    expect(syncModeToggle).toContain('function retrySave()');
    expect(syncModeToggle).toContain('if (!failedMode) return;');
    expect(syncModeToggle).toContain('void setMode(failedMode)');
    expect(syncModeToggle).toContain('data-testid="sync-mode-error"');
    expect(syncModeToggle).toContain('data-testid="sync-mode-retry"');
    expect(syncModeToggle).toContain('aria-busy={savingMode ===');
  });

  it('scopes widget saving feedback and retries the captured setting value', () => {
    expect(widgetSettings).toContain(
      "let pendingSetting = $state<WidgetMutation['setting'] | null>(null);",
    );
    expect(widgetSettings).toContain(
      'let mutationFailure = $state<WidgetMutationFailure | null>(null);',
    );
    expect(widgetSettings).toContain('const failure = mutationFailure;');
    expect(widgetSettings).toContain("{ setting: 'enabled', value: failure.value }");
    expect(widgetSettings).toContain("{ setting: 'display', value: failure.value }");
    expect(widgetSettings).toContain('data-testid="widget-setting-error"');
    expect(widgetSettings).toContain('aria-busy={pendingSetting ===');
  });
});

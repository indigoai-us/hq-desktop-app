import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const eventSource = read('../../crates/hq-desktop-core/src/events.rs');
const manualSyncSource = read('src-tauri/src/commands/sync.rs');
const daemonSource = read('src-tauri/src/commands/daemon.rs');
const workShellSource = read('src/desktop-alt/HqWorkWorkShell.svelte');
const meetingsWindowSource = read('src/components/MeetingsWindow.svelte');

describe('sync plan-limit event contract', () => {
  it('parses the server URL through the desktop event model', () => {
    expect(eventSource).toContain('pub struct SyncPlanLimitEvent');
    expect(eventSource).toContain('pub upgrade_url: String');
    expect(eventSource).toContain('PlanLimit(SyncPlanLimitEvent)');
    expect(eventSource).toContain('EVENT_SYNC_PLAN_LIMIT: &str = "sync:plan-limit"');
  });

  it('forwards the event from manual and background sync runs', () => {
    expect(manualSyncSource).toContain(
      'SyncEvent::PlanLimit(payload) => app.emit(EVENT_SYNC_PLAN_LIMIT, payload.clone())',
    );
    expect(daemonSource).toContain('if let SyncEvent::PlanLimit(payload) = &event');
    expect(daemonSource).toContain('app.emit(EVENT_SYNC_PLAN_LIMIT, payload.clone())');
  });

  it('renders a dismissible notice with a server-linked upgrade action', () => {
    expect(workShellSource).toContain("'sync:plan-limit'");
    expect(workShellSource).toContain('approvedExternalUrl(upgradeUrl)');
    expect(workShellSource).toContain('New files are paused for {notice.company}.');
    expect(workShellSource).toContain('testId="sync-plan-limit-upgrade"');
    expect(workShellSource).toContain('onUpgrade={openPlanLimitUpgrade}');
  });

  it('replaces the Meetings plan toast with the shared upgrade action', () => {
    expect(meetingsWindowSource).toContain('if (isPlanRequiredError(err))');
    expect(meetingsWindowSource).toContain('planRequiredUpgradeUrl(err)');
    expect(meetingsWindowSource).toContain(
      'Meeting bot recording requires a paid plan for this account.',
    );
    expect(meetingsWindowSource).toContain('testId="meetings-plan-upgrade"');
    expect(meetingsWindowSource).toContain('onUpgrade={openMeetingPlanUpgrade}');
  });
});

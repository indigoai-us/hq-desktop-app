import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const eventSource = read('../../crates/hq-desktop-core/src/events.rs');
const manualSyncSource = read('src-tauri/src/commands/sync.rs');
const daemonSource = read('src-tauri/src/commands/daemon.rs');
const workShellSource = read('src/desktop-alt/HqWorkWorkShell.svelte');
const planLimitNotificationsSource = read('src/desktop-alt/plan-limit-notifications.ts');
const meetingsWindowSource = read('src/components/MeetingsWindow.svelte');
const routedMeetingsStoreSource = read('../../packages/ui/src/meetings/meetings-store.svelte.ts');
const routedMeetingsPageSource = read('../../packages/ui/src/meetings/MeetingsPage.svelte');
const routedMeetingsErrorsSource = read('../../packages/ui/src/meetings/invite-errors.ts');

describe('sync plan-limit event contract', () => {
  it('parses the server URL through the desktop event model', () => {
    expect(eventSource).toContain('pub struct SyncPlanLimitEvent');
    expect(eventSource).toContain('pub upgrade_url: String');
    expect(eventSource).toContain('PlanLimit(SyncPlanLimitEvent)');
    expect(eventSource).toContain('EVENT_SYNC_PLAN_LIMIT: &str = "sync:plan-limit"');
  });

  it('records and forwards the event from manual and background sync runs', () => {
    // hard-stop US-019: the registry behind the status header and the menu
    // bar records the notice, then the desktop window hears it. The emit stays
    // targeted; the perf-budget ratchet caps broadcast emits.
    expect(manualSyncSource).toMatch(
      /SyncEvent::PlanLimit\(payload\)\s*=>\s*\{\s*crate::commands::uploads_paused::record_plan_limit\(app, hq_folder, payload\);\s*app\.emit_to\(\s*crate::commands::desktop_alt::WINDOW_LABEL,\s*EVENT_SYNC_PLAN_LIMIT,\s*payload\.clone\(\),?\s*\)/,
    );
    expect(daemonSource).toContain('if let SyncEvent::PlanLimit(payload) = &event');
    expect(daemonSource).toContain(
      'crate::commands::uploads_paused::record_plan_limit(app, hq_folder, payload);',
    );
    expect(daemonSource).toMatch(
      /app\.emit_to\(\s*crate::commands::desktop_alt::WINDOW_LABEL,\s*EVENT_SYNC_PLAN_LIMIT,\s*payload\.clone\(\),?\s*\)/,
    );
    for (const source of [manualSyncSource, daemonSource]) {
      expect(source).not.toMatch(/app\.emit\(EVENT_SYNC_PLAN_LIMIT/);
      // The pass end settles the pause and persists it in the journal.
      expect(source).toContain('crate::commands::uploads_paused::settle_pass(app, hq_folder, &uploads_pass)');
    }
  });

  it('routes the notice into notifications, never a stacked shell banner', () => {
    expect(workShellSource).toContain("'sync:plan-limit'");
    expect(workShellSource).toContain("'sync:uploads-paused'");
    expect(workShellSource).toContain("invokeFn('get_sync_status')");
    expect(workShellSource).toContain(
      'return approvedPlanUpgradeUrl(withDesktopLimitEntrySurface(approved));',
    );
    // v0.10.383: one banner per paused company stacked over the window. The
    // notice is a notification row now; the banner block must not return.
    expect(workShellSource).not.toContain('plan-limit-notices');
    expect(workShellSource).not.toContain('New files are paused for {notice.company}.');
    expect(workShellSource).not.toContain('PlanUpgradeAction');
    expect(workShellSource).toContain('hostNotifications={');
    expect(workShellSource).toContain('onopenhostnotification={');
    expect(planLimitNotificationsSource).toContain('New files are paused for ${company}.');
    expect(workShellSource).toContain("eventName: 'plan_limit_prompt_exposed'");
    expect(workShellSource).toContain("eventName: 'plan_limit_prompt_engaged'");
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

  it('shows the server upgrade URL in the routed desktop-alt Meetings page', () => {
    expect(routedMeetingsStoreSource).toContain('planRequiredUpgradeUrl(err)');
    expect(routedMeetingsStoreSource).toContain('upgradeUrl ? { upgradeUrl } : {}');
    expect(routedMeetingsPageSource).toContain('{#if toast.upgradeUrl}');
    expect(routedMeetingsPageSource).toContain('data-testid="meetings-plan-upgrade"');
    expect(routedMeetingsPageSource).toContain('openToastUpgrade');
    expect(routedMeetingsErrorsSource).toContain('url.protocol !== "https:"');
  });
});

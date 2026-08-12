import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('async desktop surfaces expose immediate, scoped feedback', () => {
  it('covers every meeting browser handoff without blocking unrelated rows', () => {
    const page = source('../../src/desktop-alt/pages/MeetingsPage.svelte');
    const agenda = source('../../src/desktop-alt/components/MeetingsAgenda.svelte');
    const live = source('../../src/desktop-alt/components/LiveNowCard.svelte');
    const window = source('../../src/components/MeetingsWindow.svelte');

    expect(page).toContain('let calendarOpening = $state(false)');
    expect(page).toContain('aria-busy={calendarOpening}');
    expect(page).toContain('let upNextJoining = $state(false)');
    expect(page).toContain('aria-busy={upNextJoining}');
    expect(page).toContain('let integrationsOpening = $state(false)');
    expect(page).toContain('aria-busy={integrationsOpening}');

    expect(agenda).toContain('let openingEventIds = $state(new Set<string>())');
    expect(agenda).toContain('aria-busy={openingEventIds.has(event.id)}');
    expect(agenda).toContain('let openingFailures = $state(new Map<string, string>())');
    expect(agenda).toContain('class="meeting-open-error" role="alert"');
    expect(agenda).toContain("{openingEventIds.has(event.id) ? 'Retrying…' : 'Retry'}");
    expect(live).toContain('let joining = $state(false)');
    expect(live).toContain('aria-busy={joining}');
    expect(live).toContain('let joinError = $state');
    expect(live).toContain('class="live-action-error" role="alert"');
    expect(live).toContain("{joining ? 'Retrying…' : 'Retry'}");

    expect(window).toContain('let integrationsOpening = $state(false)');
    expect(window).toContain('let openingMeetingIds = $state(new Set<string>())');
    expect(window).toContain('aria-busy={openingMeetingIds.has(evt.id)}');
    expect(window).toContain('let activeActionPending = $state');
    expect(window).toContain('let activeActionFailures = $state');
    expect(window).toContain("await emit('meetings-window:action'");
    expect(window).toContain('class="active-action-error" role="alert"');
    expect(window).toContain("{pendingActiveAction !== undefined ? 'Retrying…' : 'Retry'}");
  });

  it('covers conversation clipboard and Claude handoffs per message', () => {
    const conversation = source('../../src/components/messaging/Conversation.svelte');

    expect(conversation).toContain('let copyingKeys = $state(new Set<string>())');
    expect(conversation).toContain("aria-busy={isCopying(msg.eventId, 'body')}");
    expect(conversation).toContain("aria-busy={isCopying(msg.eventId, 'prompt')}");
    expect(conversation).toContain('let openingShareIds = $state(new Set<string>())');
    expect(conversation).toContain('aria-busy={openingShareIds.has(msg.eventId)}');
    expect(conversation).toContain('let actionFailures = $state(new Map<string, string>())');
    expect(conversation).toContain('class="dm-action-error" role="alert"');
    expect(conversation).toContain("actionPending(msg.eventId, actionKind)");
    expect(conversation).toContain("'Retrying…' : 'Retry'");
  });

  it('covers project creation and removes the duplicate company-level CTA', () => {
    const projects = source('../../src/desktop-alt/pages/CompanyProjectsPage.svelte');
    const company = source('../../src/desktop-alt/pages/CompanyPage.svelte');

    expect(projects).toContain('let newProjectPending = $state(false)');
    expect(projects).toContain('{#if onnewproject}');
    expect(projects).toContain('aria-busy={newProjectPending}');
    expect(company).toContain('<CompanyProjectsPage slug={company.slug} />');
  });

  it('covers Core popover + Home cards and the raw activity log handoff (titlebar is minimal)', () => {
    const titlebar = source('../../src/desktop-alt/v4/V4TitleBar.svelte');
    const core = source('../../src/desktop-alt/v4/CorePopover.svelte');
    const needsYou = source('../../src/desktop-alt/v4/NeedsYouCard.svelte');
    const activity = source('../../src/desktop-alt/v4/ActivityDigest.svelte');

    // D-04: recovery pending state lives in Core / Home, not titlebar chrome.
    expect(titlebar).toContain('data-testid="titlebar-core-pill"');
    expect(titlebar).not.toContain('let actionPending = $state(false)');
    expect(core).toContain('let updateInstalling = $state(false)');
    expect(core).toContain('aria-busy={updateInstalling}');
    expect(needsYou).toContain('let pendingActionId = $state<string | null>(null)');
    expect(needsYou).toContain('aria-busy={pendingActionId === action.id}');
    expect(needsYou).toContain('let actionFailure = $state');
    expect(needsYou).toContain('class="v4-card-error" role="alert"');
    expect(activity).toContain('let openingLog = $state(false)');
    expect(activity).toContain('aria-busy={openingLog}');
    expect(activity).toContain('let openLogError = $state');
    expect(activity).toContain('class="v4-digest-error" role="alert"');
  });

  it('renders scoped failures with the defined V4 error token', () => {
    const errorSurfaces = [
      source('../../src/desktop-alt/components/MeetingsAgenda.svelte'),
      source('../../src/desktop-alt/components/LiveNowCard.svelte'),
      source('../../src/desktop-alt/v4/NeedsYouCard.svelte'),
      source('../../src/desktop-alt/v4/ActivityDigest.svelte'),
    ];

    for (const surface of errorSurfaces) {
      expect(surface).toContain('color: var(--v4-error)');
      expect(surface).not.toContain('var(--v4-danger)');
    }
  });

  it('covers auxiliary-window external actions and recovery controls', () => {
    const popover = source('../../src/components/Popover.svelte');
    const drift = source('../../src/components/DriftDetail.svelte');
    const deployment = source('../../src/desktop-alt/components/DeploymentRow.svelte');
    const permissions = source('../../src/components/MeetingPermissionsWindow.svelte');
    const signIn = source('../../src/components/SignInPrompt.svelte');
    const globalError = source('../../src/components/GlobalErrorBoundary.svelte');

    expect(popover).toContain('let openingDesktop = $state(false)');
    expect(popover).toContain('aria-busy={openingDesktop}');
    expect(popover).toContain('let openingMessages = $state(false)');
    expect(popover).toContain('aria-busy={openingMessages}');
    expect(popover).toContain("invoke('open_communications_window')");
    expect(popover).toContain('data-testid="popover-messages-error"');
    expect(popover).toContain('data-testid="popover-desktop-error"');
    expect(popover).toContain('data-testid="popover-updates-error"');
    expect(popover).toContain('data-testid="popover-install-error"');
    expect(popover).toContain('aria-busy={updateInstalling}');
    expect(drift).toContain(
      "let openState = $state<Record<string, 'local' | 'upstream' | null>>({})",
    );
    expect(drift).toContain("aria-busy={openState[entry.path] === 'local'}");
    expect(drift).toContain("aria-busy={openState[entry.path] === 'upstream'}");
    expect(drift).toContain('let openFailures = $state<Record<string, DriftOpenFailure | undefined>>({})');
    expect(drift).toContain('class="drift-row-open-error" role="alert"');
    expect(drift).toContain('retryOpen(entry, failure.action)');
    expect(drift).toContain('let recheckError = $state<string | null>(null)');
    expect(drift).toContain('class="drift-recheck-error" role="alert"');
    expect(deployment).toContain('let openError = $state<string | null>(null)');
    expect(deployment).toContain('class="deployment-action-error" role="alert"');
    expect(deployment).toContain("{opening ? 'Retrying…' : 'Retry'}");
    expect(permissions).toContain('let prompting = $state(false)');
    expect(permissions).toContain('aria-busy={prompting}');
    expect(permissions).toContain('let actionError = $state');
    expect(permissions).toContain('class="permission-action-error" role="alert"');
    expect(permissions).toContain('loadMeetingPermissions({ throwOnError: true })');
    expect(signIn).toContain('let cancelling = $state(false)');
    expect(signIn).toContain('let quitting = $state(false)');
    expect(globalError).toContain('let revealingFolder = $state(false)');
    expect(globalError).toContain('aria-busy={revealingFolder}');
  });

  it('keeps workspace links recoverable and chronology visible without hover', () => {
    const workspaces = source('../../src/components/WorkspaceList.svelte');

    expect(workspaces).toContain(
      'let openState = $state<Record<string, true | string>>({})',
    );
    expect(workspaces).toContain('aria-busy={openState[w.slug] === true}');
    expect(workspaces).toContain('Couldn’t open HQ — select this row to retry');
    expect(workspaces).toContain('class="row-meta row-open-error" role="alert"');
    expect(workspaces).toContain('.row-meta-lastsync {');
    expect(workspaces).toContain('display: inline;');
    expect(workspaces).not.toContain('.workspace-row:hover .row-meta-lastsync');
    expect(workspaces).not.toMatch(
      /\.row-slug\s*\{[\s\S]*?border-radius:\s*999px/,
    );
  });

  it('covers onboarding clipboard operations and completion', () => {
    const onboarding = source('../../src/components/onboarding/OnboardingWizard.svelte');
    const setup = source('../../src/components/onboarding/SetupScreen.svelte');

    expect(onboarding).toContain(
      'let copyingAction = $state<CopyAction | null>(null)',
    );
    expect(onboarding).toContain('let copyFailure = $state<CopyAction | null>(null)');
    expect(onboarding).toContain('let finishing = $state(false)');
    expect(onboarding).toContain("aria-busy={copyingAction === 'path'}");
    expect(onboarding).toContain("aria-busy={copyingAction === 'command'}");
    expect(onboarding).toContain("aria-busy={copyingAction === 'import'}");
    expect(onboarding).toContain('data-testid="onboarding-copy-error"');
    expect(onboarding).toContain('onclick={() => void retryCopyAction()}');
    expect(onboarding).toContain("{copyingAction ? 'Retrying…' : 'Retry'}");
    expect(onboarding).toContain('aria-busy={privacyOpening}');
    expect(onboarding).toContain('onclick={() => void handleOpenPrivacy()}');
    expect(onboarding).toContain('class="consent-link-error" role="alert"');
    expect(onboarding).toContain('aria-busy={finishing}');
    expect(onboarding).toContain('data-testid="onboarding-finish-error"');
    expect(onboarding).toContain("finishing ? 'Finishing…' : finishError ? 'Retry' : 'Done'");
    expect(setup).toBeTruthy();
    expect(setup).toContain('let stagingSourceError = $state<string | null>(null)');
    expect(setup).toContain('class="staging-toggle-error" role="alert"');
    expect(setup).toContain("{stagingSourceSaving ? 'Retrying…' : 'Retry'}");
  });

  it('keeps command and installed-pack failures on their originating surfaces', () => {
    const palette = source('../../src/desktop-alt/components/CommandPalette.svelte');
    const installed = source('../../src/desktop-alt/panels/InstalledPacksPanel.svelte');

    expect(palette).toContain('let actionError = $state<CommandActionError | null>(null)');
    expect(palette).toContain('class="command-action-error" role="alert"');
    expect(palette).toContain('actionError = { command, message: errorMessage(err) }');
    expect(palette).toMatch(
      /await command\.action\(\);\s*onclose\(\);[\s\S]*?catch \(err\)[\s\S]*?actionError =/,
    );
    expect(palette).not.toMatch(/finally\s*\{\s*onclose\(\)/);

    expect(installed).toContain(
      'let clipboardFailures = $state<Record<string, ClipboardFailure | undefined>>({})',
    );
    expect(installed).toContain('let repairCommandError = $state<string | null>(null)');
    expect(installed).toContain('class="pack-action-error" role="alert"');
    expect(installed).toContain("retryClipboardAction(p, failure.action)");
    expect(installed).toContain('Couldn’t copy to the clipboard.');
  });

  it('keeps shared-file handoff failures visible and retryable', () => {
    const share = source('../../src/components/ShareMainPane.svelte');

    expect(share).toContain('let actionFailures = $state(new Map');
    expect(share).toContain('class="event-action-error" role="alert"');
    expect(share).toContain('retryAction(evt, failure.action)');
    expect(share).toContain("{pendingAction === `${evt.eventId}:${failure.action}` ? 'Retrying…' : 'Retry'}");
  });
});

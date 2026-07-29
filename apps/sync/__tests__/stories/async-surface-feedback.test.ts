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
    expect(live).toContain('let joining = $state(false)');
    expect(live).toContain('aria-busy={joining}');

    expect(window).toContain('let integrationsOpening = $state(false)');
    expect(window).toContain('let openingMeetingIds = $state(new Set<string>())');
    expect(window).toContain('aria-busy={openingMeetingIds.has(evt.id)}');
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

  it('covers titlebar recovery, Home cards, and the raw activity log handoff', () => {
    const titlebar = source('../../src/desktop-alt/v4/V4TitleBar.svelte');
    const needsYou = source('../../src/desktop-alt/v4/NeedsYouCard.svelte');
    const activity = source('../../src/desktop-alt/v4/ActivityDigest.svelte');

    expect(titlebar).toContain('let actionPending = $state(false)');
    expect(titlebar).toContain('aria-busy={actionPending}');
    expect(needsYou).toContain('let pendingActionId = $state<string | null>(null)');
    expect(needsYou).toContain('aria-busy={pendingActionId === action.id}');
    expect(activity).toContain('let openingLog = $state(false)');
    expect(activity).toContain('aria-busy={openingLog}');
  });

  it('covers auxiliary-window external actions and recovery controls', () => {
    const popover = source('../../src/components/Popover.svelte');
    const drift = source('../../src/components/DriftDetail.svelte');
    const permissions = source('../../src/components/MeetingPermissionsWindow.svelte');
    const signIn = source('../../src/components/SignInPrompt.svelte');
    const globalError = source('../../src/components/GlobalErrorBoundary.svelte');

    expect(popover).toContain('let openingHQ = $state(false)');
    expect(popover).toContain('aria-busy={openingHQ}');
    expect(popover).toContain('let openingMessages = $state(false)');
    expect(popover).toContain('aria-busy={openingMessages}');
    expect(popover).toContain("invoke('open_communications_window')");
    expect(drift).toContain(
      "let openState = $state<Record<string, 'local' | 'upstream' | null>>({})",
    );
    expect(drift).toContain("aria-busy={openState[entry.path] === 'local'}");
    expect(drift).toContain("aria-busy={openState[entry.path] === 'upstream'}");
    expect(permissions).toContain('let prompting = $state(false)');
    expect(permissions).toContain('aria-busy={prompting}');
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

    expect(onboarding).toContain(
      "let copyingAction = $state<'path' | 'command' | 'import' | null>(null)",
    );
    expect(onboarding).toContain('let finishing = $state(false)');
    expect(onboarding).toContain("aria-busy={copyingAction === 'path'}");
    expect(onboarding).toContain("aria-busy={copyingAction === 'command'}");
    expect(onboarding).toContain("aria-busy={copyingAction === 'import'}");
    expect(onboarding).toContain('aria-busy={finishing}');
  });
});

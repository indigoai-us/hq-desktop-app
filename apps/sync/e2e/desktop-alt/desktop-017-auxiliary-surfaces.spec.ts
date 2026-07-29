import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? '';
}

function expectOpenSection(source: string, selector: string, label: string): void {
  const block = rule(source, selector);
  expect(block, `${label} selector should exist`).not.toBe('');
  expect(block, `${label} should not paint a closed perimeter`).toMatch(
    /\bborder:\s*(?:0|none)\s*;/,
  );
  expect(block, `${label} should inherit the window material`).toContain(
    'background: transparent',
  );
  expect(block, `${label} should not read as a rounded card`).toMatch(
    /border-radius:\s*0(?:px)?\s*;/,
  );
}

describe('DESKTOP-017: auxiliary desktop surfaces', () => {
  const permissions = readRepoFile(
    'src/components/MeetingPermissionsWindow.svelte',
  );
  const permissionsCommand = readRepoFile(
    'src-tauri/src/commands/permissions.rs',
  );
  const onboarding = readRepoFile(
    'src/components/onboarding/OnboardingWizard.svelte',
  );
  const globalError = readRepoFile(
    'src/components/GlobalErrorBoundary.svelte',
  );
  const dmRequest = readRepoFile(
    'src/components/messaging/DmRequestCard.svelte',
  );
  const composeMessage = readRepoFile(
    'src/components/messaging/ComposeMessage.svelte',
  );
  const meetings = readRepoFile('src/components/MeetingsWindow.svelte');
  const drift = readRepoFile('src/components/DriftDetail.svelte');
  const shares = readRepoFile('src/components/ShareMainPane.svelte');
  const messages = readRepoFile(
    'src/components/messaging/MessagesShell.svelte',
  );
  const catchUp = readRepoFile(
    'src/components/messaging/v4/CatchUp.svelte',
  );
  const channelView = readRepoFile(
    'src/components/messaging/ChannelView.svelte',
  );
  const createChannel = readRepoFile(
    'src/components/messaging/CreateChannel.svelte',
  );
  const channelList = readRepoFile(
    'src/components/messaging/ChannelList.svelte',
  );
  const conversation = readRepoFile(
    'src/components/messaging/Conversation.svelte',
  );
  const channelRoster = readRepoFile(
    'src/components/messaging/ChannelRoster.svelte',
  );
  const systemEvent = readRepoFile(
    'src/components/messaging/v4/SystemEventCard.svelte',
  );
  const widget = readRepoFile('src/components/Widget.svelte');
  const main = readRepoFile('src/main.ts');
  const harness = readRepoFile('dev-harness/Harness.svelte');
  const mocks = readRepoFile('dev-harness/mocks/core.ts');
  const appMock = readRepoFile('dev-harness/mocks/app.ts');
  const previewConfig = readRepoFile('vite.preview.config.ts');

  it('uses open explanatory sections in the meeting-permissions window', () => {
    expectOpenSection(permissions, '.why-card', 'permissions explanation');
    expectOpenSection(permissions, '.quick-prompt', 'permissions quick path');

    expect(rule(permissions, '.why-card')).toContain(
      'border-top: 1px solid var(--c-divider)',
    );
    expect(rule(permissions, '.quick-prompt')).toContain(
      'border-top: 1px solid var(--c-divider)',
    );
  });

  it('gives the meeting-permissions window the same native neutral glass backing', () => {
    expect(
      rule(
        permissions,
        ":global(html[data-window='meeting-permissions'] body)",
      ),
    ).toContain('background: transparent');
    expect(rule(permissions, '.window')).toContain(
      'background: var(--compact-glass-bg)',
    );
    expect(permissionsCommand).toContain('.transparent(true)');
    expect(permissionsCommand).toContain('setUnderPageBackgroundColor: clear');
    expect(permissionsCommand).toContain(
      'apply_compact_communications_glass_window',
    );
  });

  it('keeps every onboarding step and the global fallback visually inspectable', () => {
    expect(harness).toContain("view === 'onboarding'");
    expect(harness).toContain('<OnboardingWizard');
    expect(harness).toContain('{onboardingStep}');
    expect(harness).toContain("view === 'global-error'");
    expect(harness).toContain('<GlobalErrorBoundary');
  });

  it('desaturates the onboarding hero instead of retaining the blue-pink artwork tint', () => {
    const hero = rule(onboarding, '.grad');
    expect(hero, 'onboarding hero selector should exist').not.toBe('');
    expect(hero).toContain('filter:grayscale(1) saturate(0%)');

    expect(rule(onboarding, '.macfolder-lg')).toContain(
      'filter:grayscale(1) saturate(0%)',
    );
    expect(rule(onboarding, '.loc .mf')).toContain(
      'filter:grayscale(1) saturate(0%)',
    );
  });

  it('keeps the ready-step caution open and neutral while retaining its compact warning cue', () => {
    expectOpenSection(onboarding, '.setup-caution', 'onboarding setup caution');
    expect(rule(onboarding, '.setup-caution')).toContain(
      'border-top:1px solid var(--c-divider)',
    );
    expect(rule(onboarding, '.setup-caution-icon')).toContain(
      'stroke:var(--c-muted)',
    );
    expect(rule(onboarding, '.setup-caution-icon')).not.toMatch(
      /(?:#a66b00|v4-warn|amber|yellow)/i,
    );
    expect(rule(onboarding, '.setup-caution-copy span')).toContain(
      'color:var(--c-muted)',
    );
  });

  it('provides deterministic onboarding data and a stable in-progress setup preview', () => {
    expect(mocks).toContain(
      "resolve_hq_path: () => '/Users/corey/Documents/HQ'",
    );
    expect(mocks).toContain('detect_ai_tools: () => ({');
    expect(mocks).toContain(
      "harnessScenario() === 'onboarding-progress'",
    );
    expect(mocks).toContain(
      "params.get('view') === 'onboarding' && params.get('step') === '2'",
    );
    expect(mocks).toContain('start_initial_cloud_sync:');
  });

  it('uses the package version as the single source of truth in every preview surface', () => {
    expect(previewConfig).toContain(
      "import pkg from './package.json' with { type: 'json' }",
    );
    expect(previewConfig).toContain(
      '__APP_VERSION__: JSON.stringify(pkg.version)',
    );
    expect(appMock).toContain('return __APP_VERSION__');
    expect(appMock).not.toMatch(/\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?/i);
  });

  it('keeps the global recovery screen adaptive and its recovery content unboxed', () => {
    expect(rule(globalError, '.error-shell')).toContain(
      'background: var(--page-bg)',
    );
    expect(rule(globalError, '.error-shell')).toContain(
      'color: var(--c-text)',
    );
    expectOpenSection(globalError, '.error-card', 'global recovery content');
    expectOpenSection(globalError, '.error-detail', 'global error detail');
    expect(rule(globalError, '.error-detail')).toContain(
      'border-top: 1px solid var(--c-divider)',
    );
  });

  it('keeps connection requests and compose guidance in the open message flow', () => {
    expectOpenSection(dmRequest, '.request-card', 'DM request');
    expect(rule(dmRequest, '.request-card')).toContain(
      'border-top: 1px solid var(--border)',
    );
    expectOpenSection(dmRequest, '.request-message', 'DM request message');

    expectOpenSection(composeMessage, '.compose-note', 'compose guidance');
    expect(rule(composeMessage, '.compose-note')).toContain(
      'border-top: 1px solid var(--border)',
    );
  });

  it('exposes every standalone main-window mount to the visual harness', () => {
    const standaloneMounts = [
      ['meetings-window', 'MeetingsWindow', 'meetings'],
      ['new-files-detail', 'NewFilesDetail', 'new-files'],
      ['drift-detail', 'DriftDetail', 'drift'],
      ['activity-log', 'ActivityLog', 'activity'],
      ['share-detail', 'ShareDetail', 'share-detail'],
      ['meeting-permissions', 'MeetingPermissionsWindow', 'permissions'],
      ['dm-detail', 'DmDetail', 'dm-detail'],
      ['dm-banner', 'BannerNotification', 'banner'],
      ['widget', 'Widget', 'widget'],
      ['messages', 'MessagesShell', 'messages'],
    ] as const;

    for (const [windowLabel, component, view] of standaloneMounts) {
      expect(main, `${windowLabel} should remain routed in main.ts`).toContain(
        `windowLabel === '${windowLabel}'`,
      );
      expect(main, `${component} should remain the ${windowLabel} mount`).toContain(
        `Component = ${component}`,
      );
      expect(harness, `${component} should have a dedicated harness route`).toContain(
        `view === '${view}'`,
      );
      expect(harness, `${component} should mount in its harness route`).toContain(
        `<${component}`,
      );
    }
  });

  it('starts the standalone meetings refresh outside reactive dependency tracking', () => {
    expect(meetings).toContain("import { untrack } from 'svelte'");
    expect(meetings).toContain('untrack(() => void refresh());');
  });

  it('uses compact status dots instead of colored permission pills', () => {
    expect(rule(permissions, '.pill')).toContain('background: transparent');
    expect(rule(permissions, '.pill')).toMatch(/padding:\s*0\s*;/);
    expect(rule(permissions, '.pill')).toMatch(/border-radius:\s*0\s*;/);
    expect(rule(permissions, '.pill::before')).toContain(
      'background: var(--status-dot)',
    );
    expect(rule(permissions, '.pill-prompt')).toContain(
      '--status-dot: var(--dot)',
    );
    expect(rule(permissions, '.optional-tag')).toContain(
      'background: transparent',
    );
  });

  it('keeps meeting warnings and focused rows open and neutral', () => {
    expectOpenSection(meetings, '.toast', 'meetings status message');
    expect(rule(meetings, '.toast')).toContain(
      'border-top: 1px solid var(--c-divider)',
    );
    expect(rule(meetings, '.toast-warn')).toContain(
      '--toast-dot: var(--v4-warn',
    );
    expect(rule(meetings, '.toast-warn')).not.toMatch(/\bbackground\s*:/);
    expect(rule(meetings, '.event-row')).toContain('border-radius: 0');
    expect(rule(meetings, '.event-row-focused')).toContain(
      'background: var(--pop-hover)',
    );
    expect(rule(meetings, '.event-row-focused')).not.toMatch(
      /(?:#facc15|250,\s*204,\s*21)/i,
    );
  });

  it('uses calendar dots rather than decorative event-edge rails', () => {
    expect(meetings).not.toContain('event-cal-bar');
    expect(meetings).toContain('class="event-cal-dot"');
    expect(rule(meetings, '.event-cal-dot')).toContain('width: 6px');
    expect(rule(meetings, '.event-cal-dot')).toContain('height: 6px');
    expect(rule(meetings, '.event-cal-dot')).toContain('border-radius: 50%');
  });

  it('renders drift classifications and share notes without inset boxes', () => {
    expect(rule(drift, '.drift-staging-badge')).toContain(
      'background: transparent',
    );
    expect(rule(drift, '.drift-staging-badge')).toMatch(/padding:\s*0\s*;/);
    expect(rule(drift, '.drift-staging-badge')).toContain('border-radius: 0');
    expect(rule(drift, '.drift-staging-badge::before')).toContain(
      'background: var(--status-dot)',
    );

    expectOpenSection(shares, '.event-note', 'shared event note');
    expect(rule(shares, '.event-note')).toContain(
      'border-top: 1px solid var(--pop-border, var(--border))',
    );
  });

  it('keeps widget fixtures deterministic and message selection rail-free', () => {
    expect(harness).toContain('WIDGET_RECENT_STORAGE_KEY');
    expect(harness).toContain(
      'localStorage.removeItem(WIDGET_RECENT_STORAGE_KEY)',
    );
    expect(messages).not.toContain('.contact-row.active::before');
    expect(rule(messages, '.contact-row')).toContain('border-radius: 0');
    expect(rule(messages, '.contact-row.active')).toContain(
      'background: transparent',
    );
    expect(rule(messages, '.contact-row.active')).toContain(
      'box-shadow: inset 0 -1px 0 var(--border)',
    );
  });

  it('renders catch-up entries as open rows instead of inset cards', () => {
    expectOpenSection(catchUp, '.ranked-card', 'message catch-up entry');
    expect(rule(catchUp, '.ranked-card')).toContain(
      'border-top: 1px solid var(--border)',
    );
    expect(rule(catchUp, '.ranked-list')).toContain('gap: 0');
    expect(catchUp).not.toContain('class="rank"');
  });

  it('uses message chrome only where it carries meaning', () => {
    const incoming = rule(
      conversation,
      ":global([data-window='messages']) .dm-msg-in .dm-bubble",
    );
    const outgoing = rule(
      conversation,
      ":global([data-window='messages']) .dm-msg-out .dm-bubble",
    );
    const sharedFile = rule(
      conversation,
      ":global([data-window='messages']) .dm-bubble-share",
    );
    const author = rule(
      conversation,
      ":global([data-window='messages']) .dm-msg-author",
    );

    expect(incoming).toContain('background: transparent');
    expect(incoming).toContain('border-radius: 0');
    expect(outgoing).toContain('background: var(--surface-raise)');
    expect(outgoing).toContain('border: 1px solid var(--border)');
    expect(sharedFile).toContain('background: var(--surface-raise)');
    expect(sharedFile).toContain('border: 1px solid var(--border)');
    expect(author).toContain('border-radius: 999px');
  });

  it('marks intentionally captured messaging props as untracked initial state', () => {
    expect(channelView).toContain("import { untrack } from 'svelte'");
    expect(channelView).toContain(
      'let current = $state<Channel>(untrack(() => channel));',
    );
    expect(channelView).toContain(
      'untrack(() => channel.memberCount ?? null)',
    );
    expect(createChannel).toContain("import { untrack } from 'svelte'");
    expect(createChannel).toContain(
      "untrack(() => presetCompanyUid ?? 'personal')",
    );
  });

  it('keeps routine messaging and meeting workflow metadata fully neutral', () => {
    for (const [source, selector, label] of [
      [channelList, '.invited-chip', 'channel invitation'],
      [conversation, '.dm-msg-pending', 'pending message'],
      [channelRoster, '.member-role.owner', 'channel owner'],
    ] as const) {
      const block = rule(source, selector);
      expect(block, `${label} selector should exist`).not.toBe('');
      expect(block, `${label} should not use warning colors`).not.toMatch(
        /(?:amber|v4-warn|#b45309|#fcd34d)/i,
      );
    }

    expect(rule(channelList, '.invited-chip')).toContain(
      'background: transparent',
    );
    expect(rule(channelList, '.invited-chip')).toContain('border-radius: 0');
    expect(rule(conversation, '.dm-msg-pending')).toContain(
      'background: transparent',
    );
    expect(rule(conversation, '.dm-msg-pending')).toContain(
      'border-radius: 0',
    );
    expect(rule(channelRoster, '.member-role.owner')).toContain(
      'color: var(--pop-muted)',
    );

    expect(rule(meetings, '.row-icon-joining')).toContain(
      'color: var(--c-muted)',
    );
    expect(rule(meetings, '.row-icon-bot-now')).toContain(
      'color: var(--c-text)',
    );
    expect(rule(meetings, '.row-icon-spinner-amber')).toContain(
      'color: var(--c-muted)',
    );
  });

  it('reserves the SystemEventCard warning color for its explicit compact attention dot', () => {
    expect(rule(systemEvent, '.dot')).toContain('width: 7px');
    expect(rule(systemEvent, '.dot')).toContain('height: 7px');
    expect(rule(systemEvent, "[data-tone='warn'] .dot")).toContain(
      'background: var(--amber)',
    );
    expect(rule(systemEvent, "[data-tone='warn'] .dot")).not.toMatch(
      /(?:border|box-shadow|padding)/,
    );
  });

  it('keeps the idle widget wordmark legible in forced light and dark visual previews', () => {
    expect(rule(widget, ":global(html[data-force-theme='light']) .wm")).toContain(
      '--wm-fg: #1d1d1d',
    );
    expect(rule(widget, ":global(html[data-force-theme='dark']) .wm")).toContain(
      '--wm-fg: #fff',
    );
  });
});

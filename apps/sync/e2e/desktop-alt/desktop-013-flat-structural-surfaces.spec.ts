import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

function rule(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? '';
}

describe('DESKTOP-013: flat structural surfaces', () => {
  const tokens = readRepoFile('src/desktop-alt/v4/tokens.css');
  const designSystem = readRepoFile('src/styles/design-system.css');
  const desktopCss = readRepoFile('src/desktop-alt/styles/desktop-alt.css');
  const titleBar = readRepoFile('src/desktop-alt/v4/V4TitleBar.svelte');
  // US-018: ChatSidebar is primary chrome (V4Sidebar retired).
  const sidebar = readRepoFile('src/desktop-alt/chat/ChatSidebar.svelte');
  const secondarySidebar = readRepoFile('src/desktop-alt/v4/V4SecondarySidebar.svelte');
  const filesSidebar = readRepoFile('src/desktop-alt/v4/FilesModeSidebar.svelte');
  const activityDigest = readRepoFile('src/desktop-alt/v4/ActivityDigest.svelte');
  const settings = readRepoFile('src/desktop-alt/pages/SettingsPage.svelte');
  const home = readRepoFile('src/desktop-alt/pages/HomePage.svelte');
  const marketplace = readRepoFile('src/desktop-alt/panels/MarketplacePanel.svelte');
  const library = readRepoFile('src/desktop-alt/components/LibraryList.svelte');
  const profile = readRepoFile('src/desktop-alt/panels/ProfilePanel.svelte');
  const installed = readRepoFile('src/desktop-alt/panels/InstalledPacksPanel.svelte');
  const moderation = readRepoFile('src/desktop-alt/panels/ModerationPanel.svelte');
  const submit = readRepoFile('src/desktop-alt/panels/SubmitPanel.svelte');
  const agencyChat = readRepoFile('src/desktop-alt/panels/AgencyChatPanel.svelte');
  const companyLibrary = readRepoFile('src/desktop-alt/panels/CompanyLibraryPanel.svelte');
  const projectRow = readRepoFile('src/desktop-alt/components/ProjectRow.svelte');
  const projectList = readRepoFile('src/desktop-alt/components/ProjectListView.svelte');
  const commandPalette = readRepoFile(
    'src/desktop-alt/components/CommandPalette.svelte',
  );
  const libraryBrowser = readRepoFile(
    'src/desktop-alt/components/LibraryBrowser.svelte',
  );
  const meetingsWindow = readRepoFile('src/components/MeetingsWindow.svelte');
  const widget = readRepoFile('src/components/Widget.svelte');
  const popoverCss = readRepoFile('src/styles/popover.css');
  // US-018: NotificationsView supersedes InboxPage.
  const notifications = readRepoFile('src/desktop-alt/chat/NotificationsView.svelte');
  const harness = readRepoFile('dev-harness/Harness.svelte');
  const team = readRepoFile('src/desktop-alt/panels/TeamPanel.svelte');
  const operations = readRepoFile(
    'src/desktop-alt/panels/CompanyOperationsPanel.svelte',
  );
  const channelList = readRepoFile(
    'src/components/messaging/ChannelList.svelte',
  );
  const recipientPicker = readRepoFile(
    'src/components/messaging/RecipientPicker.svelte',
  );
  const channelRoster = readRepoFile(
    'src/components/messaging/ChannelRoster.svelte',
  );

  it('defines a square structure token and restrains the remaining card and popover radii', () => {
    expect(designSystem).toContain('--radius-structure:0');
    expect(designSystem).toContain('--radius-card:6px');
    expect(designSystem).toContain('--radius-popover:8px');
    expect(tokens).toContain('--v4-radius-structure: var(--radius-structure, 0)');
    expect(tokens).toContain('--v4-radius-card: var(--radius-card, 6px)');
    expect(tokens).toContain('--v4-radius-popover: var(--radius-popover, 8px)');
  });

  it('keeps settings and dashboard grouping surfaces square', () => {
    for (const [name, source, selectors] of [
      ['settings', settings, ['.settings-card']],
      [
        'home',
        home,
        [
          '.home-stats',
          '.home-table',
          '.home-agenda',
          '.home-empty',
          '.home-progress',
          '.home-skeleton',
        ],
      ],
    ] as const) {
      for (const selector of selectors) {
        const block = rule(source, selector);
        expect(block, `${name} ${selector} is still a rounded container`).toMatch(
          /border-radius:\s*(?:0|var\(--v4-radius-structure\))/,
        );
        expect(block, `${name} ${selector} still floats like a card`).not.toContain(
          'box-shadow: var(--v4-shadow-card)',
        );
      }
    }
  });

  it('keeps empty, status, list, and form grouping surfaces square', () => {
    for (const [name, source, selectors] of [
      ['marketplace', marketplace, ['.your-listings', '.state-empty']],
      ['library', library, ['.empty-state']],
      ['profile', profile, ['.resolving', '.preview-empty']],
      ['installed packs', installed, ['.op', '.row', '.state-empty']],
      ['moderation', moderation, ['.section']],
      ['submit', submit, ['.picker', '.request-access']],
      ['agency chat', agencyChat, ['.thread']],
      ['company library', companyLibrary, ['.empty-state']],
    ] as const) {
      for (const selector of selectors) {
        const block = rule(source, selector);
        expect(block, `${name} ${selector} is still a rounded container`).toMatch(
          /border-radius:\s*(?:0|var\(--v4-radius-structure\))/,
        );
        expect(block, `${name} ${selector} still floats like a card`).not.toContain(
          'box-shadow: var(--v4-shadow-card)',
        );
      }
    }

    expect(rule(profile, '.edit')).toContain('border-radius: 0');
    expect(rule(activityDigest, '.v4-digest-empty')).toContain('border-radius: 0');
    expect(rule(activityDigest, '.v4-digest-group')).toContain('border-radius: 0');
  });

  it('never rounds edge-attached chrome, canvases, or list-detail scaffolding', () => {
    for (const [name, source, selectors] of [
      [
        'desktop scaffolding',
        desktopCss,
        [
          '.desktop-shell',
          '.desktop-body',
          '.desktop-content',
          '.desktop-main',
          '.desktop-main-scroll',
          '.list-detail',
        ],
      ],
      ['title bar', titleBar, ['.v4-titlebar']],
      // ChatSidebar root has no border-radius declaration (square by default).
      ['primary sidebar', sidebar, ['.chat-sidebar']],
      ['secondary sidebar', secondarySidebar, ['.v4-secondary']],
      ['files sidebar', filesSidebar, ['.files-sidebar']],
    ] as const) {
      for (const selector of selectors) {
        expect(rule(source, selector), `${name} ${selector} has nonzero structural rounding`).not.toMatch(
          /border-radius:\s*(?!0(?:px)?\s*;|var\(--v4-radius-structure\))/,
        );
      }
    }
  });

  it('keeps navigation and list-selection rows square', () => {
    for (const [name, source, selectors] of [
      ['primary sidebar', sidebar, ['.chat-row']],
      ['secondary sidebar', secondarySidebar, ['.v4-row']],
      ['files sidebar', filesSidebar, ['.fs-company-row']],
      ['team', team, ['.team-member-row', '.team-member-row.is-selected']],
      ['operations', operations, ['.ops-nav-item', '.ops-nav-item.is-selected']],
      ['message channels', channelList, ['.channel-row']],
      ['recipient suggestions', recipientPicker, ['.suggestion']],
      ['channel roster', channelRoster, ['.invite-row', '.member-row']],
    ] as const) {
      for (const selector of selectors) {
        expect(
          rule(source, selector),
          `${name} ${selector} still presents a list row as a rounded card`,
        ).toContain('border-radius: 0');
      }
    }

    expect(rule(channelRoster, '.invite-row')).toContain('background: transparent');
    expect(rule(channelRoster, '.invite-row')).toContain('border-top:');
  });

  it('preserves modest rounding for genuine entity cards', () => {
    expect(rule(projectRow, '.project-card')).toContain('border-radius: 6px');
    expect(rule(marketplace, '.card')).toContain('border-radius: var(--v4-radius-card)');
    expect(rule(library, '.lib-card')).toContain('border-radius: var(--v4-radius-card)');
    expect(rule(marketplace, '.card')).toContain('box-shadow: var(--v4-shadow-card)');
    expect(rule(library, '.lib-card')).toContain('box-shadow: var(--v4-shadow-card)');
  });

  it('uses open project filters while keeping restrained corners on actual buttons', () => {
    expect(rule(projectList, '.status-pill')).toContain('border-radius: 0');
    expect(rule(projectList, '.status-pill')).toContain('background: transparent');
    expect(rule(profile, '.preview-tip')).toContain(
      'border-radius: var(--v4-radius-button)',
    );

    for (const [name, source] of [
      ['desktop aliases', desktopCss],
      ['title bar', titleBar],
      ['notifications', notifications],
    ] as const) {
      expect(source, `${name} retains an inflated 8px button fallback`).not.toContain(
        'var(--v4-radius-button, 8px)',
      );
    }
  });

  it('keeps every audited structural, state, note, and content frame square', () => {
    const auditedStructuralSurfaces: Array<[string, string[]]> = [
      [
        'src/desktop-alt/components/FilePreviewPane.svelte',
        ['.image-frame img', '.pdf-frame', '.markdown-body :global(pre)'],
      ],
      ['src/desktop-alt/components/LibraryBrowser.svelte', ['.browser-error']],
      [
        'src/desktop-alt/components/LibraryDetailPanel.svelte',
        ['.detail-error', '.markdown-body :global(pre)'],
      ],
      ['src/desktop-alt/components/ProjectListView.svelte', ['.list-error']],
      ['src/desktop-alt/components/StatTile.svelte', ['.stat-tile']],
      ['src/desktop-alt/components/StoryDetailPanel.svelte', ['.meta-grid']],
      ['src/desktop-alt/pages/CompanyGoalsPage.svelte', ['.goals-error']],
      ['src/desktop-alt/pages/HomePage.svelte', ['.home-tech-body']],
      ['src/desktop-alt/pages/MeetingsPage.svelte', ['.next-strip']],
      [
        'src/desktop-alt/pages/ProjectDetailView.svelte',
        [
          '.kpi-tile',
          '.info-card',
          '.drill-error',
          '.markdown-body :global(pre)',
          '.overview-task-rail',
        ],
      ],
      ['src/desktop-alt/panels/ActivityPanel.svelte', ['.activity-error']],
      ['src/desktop-alt/panels/DeploymentsPanel.svelte', ['.deployments-error']],
      [
        'src/desktop-alt/panels/InstalledPacksPanel.svelte',
        [
          '.log',
          '.setup-prompt',
          '.setup-prompt-text',
          '.confirm',
          '.state-error',
          '.card-skeleton',
        ],
      ],
      ['src/desktop-alt/panels/LiveSessionsPanel.svelte', ['.ls-outpost-note']],
      [
        'src/desktop-alt/panels/MarketplacePanel.svelte',
        ['.state-error', '.consent-note', '.install-log'],
      ],
      [
        'src/desktop-alt/panels/ModerationPanel.svelte',
        [
          '.queue-note',
          '.review-block',
          '.init-prompt-banner',
          '.doc-text',
          '.injection-banner',
          '.limitation-note',
          '.confirm-row',
          '.result-note',
        ],
      ],
      ['src/desktop-alt/panels/SecretsPanel.svelte', ['.secrets-error']],
      ['src/desktop-alt/panels/SubmitPanel.svelte', ['.state-success', '.state-error']],
    ];

    for (const [path, selectors] of auditedStructuralSurfaces) {
      const source = readRepoFile(path);
      for (const selector of selectors) {
        const block = rule(source, selector);
        expect(block, `${path} ${selector} is still rounded`).toMatch(
          /border-radius:\s*(?:0|var\(--v4-radius-structure\))/,
        );
        expect(block, `${path} ${selector} still has a card shadow`).not.toContain(
          'box-shadow: var(--v4-shadow-card)',
        );
      }
    }
  });

  it('uses only modest popover rounding on the visual harness window frame', () => {
    expect(rule(harness, '.window')).toContain(
      'border-radius: var(--radius-popover, 8px)',
    );
    expect(rule(harness, '.window')).not.toMatch(/border-radius:\s*(?:1[0-9]|[2-9][0-9])px/);
  });

  it('keeps command, notification, filter, and scope rows free of card perimeters', () => {
    const commandShape = rule(
      commandPalette,
      '.command-list button,\n  .command-empty',
    );
    expect(commandShape).toContain('border-radius: 0');

    const commandRow = rule(commandPalette, '.command-list button');
    expect(commandRow).toContain('border: 0');
    expect(commandRow).toContain('background: transparent');

    const commandHighlight = rule(
      commandPalette,
      '.command-list button.highlighted,\n  .command-list button:focus-visible',
    );
    expect(commandHighlight).toContain('outline: none');
    expect(commandHighlight).toContain(
      'box-shadow: inset 0 -1px 0 var(--pop-border)',
    );
    expect(commandHighlight).not.toContain('transform:');

    const popoverRow = rule(popoverCss, '.notif-row');
    expect(popoverRow).toContain('border-radius: 0');
    expect(popoverRow).not.toMatch(/\bborder:\s*1px/);
    expect(rule(popoverCss, '.notif-row.clickable:focus-visible')).toContain(
      'box-shadow: inset 0 -1px 0 var(--pop-focus-ring, var(--pop-text))',
    );

    const meetingFilter = rule(meetingsWindow, '.filter-option');
    expect(meetingFilter).toContain('border-radius: 0');
    expect(meetingFilter).not.toMatch(/\bborder:\s*1px/);

    const scopeOption = rule(libraryBrowser, '.scope-option');
    expect(scopeOption).toContain('border: 0');
    expect(scopeOption).toContain('border-radius: 0');
    expect(scopeOption).toContain('background: transparent');
  });

  it('renders widget notifications and loading placeholders as open ruled rows', () => {
    const widgetHistoryRow = rule(widget, '.hl-row :global(.nr)');
    expect(widgetHistoryRow).toContain('border-radius: 0');
    expect(widgetHistoryRow).toContain('background: transparent');
    expect(
      rule(widget, '.hl-row :global(.nr-message.nr-expanded)'),
    ).toContain('box-shadow: inset 0 -1px 0 var(--row-border)');

    expect(rule(widget, '.frost :global(.nr)')).toContain(
      'background: transparent',
    );
    expect(
      rule(widget, '.frost :global(.nr-message.nr-expanded)'),
    ).toContain('box-shadow: inset 0 -1px 0 var(--row-border)');

    for (const [source, selector, divider, raisedFill, label] of [
      [
        projectList,
        '.skeleton-row',
        'border-bottom: 1px solid var(--border)',
        'background: var(--row-active)',
        'project loading row',
      ],
      [
        installed,
        '.card-skeleton',
        'border-bottom: 1px solid var(--v4-hairline)',
        'background: var(--v4-raised)',
        'installed-pack loading row',
      ],
    ] as const) {
      const block = rule(source, selector);
      expect(block, `${label} selector should exist`).not.toBe('');
      expect(block).toContain('border: 0');
      expect(block).toContain(divider);
      expect(block).toContain('border-radius: 0');
      expect(block).not.toContain(raisedFill);
      expect(block).toContain('linear-gradient(');
    }
  });

  it('uses open layout instead of nested bounding boxes in moderation', () => {
    for (const selector of [
      '.section',
      '.subnav',
      '.queue-row',
      '.request-card',
      '.review-block',
      '.queue-note',
      '.result-note',
    ]) {
      const block = rule(moderation, selector);
      expect(block, `${selector} still has a closed structural border`).toContain('border: 0');
      expect(block, `${selector} still paints a boxed structural fill`).toContain(
        'background: transparent',
      );
    }

    for (const selector of [
      '.limitation-note',
      '.init-prompt-banner',
      '.injection-banner',
      '.confirm-row',
    ]) {
      const block = rule(moderation, selector);
      expect(block, `${selector} should use an open row, not a bounding box`).toContain(
        'border: 0',
      );
      expect(block).toContain('border-top: 1px solid var(--v4-rowline)');
      expect(block).not.toContain('border-left:');
      expect(block).toContain('background: transparent');
    }

    expect(rule(moderation, '.section')).toContain('padding: 0');
    expect(rule(moderation, '.subnav-tab.active')).toContain('background: transparent');
    expect(moderation).toContain('.section + .section');
    expect(moderation).toContain('.queue-list > li + li');
  });
});

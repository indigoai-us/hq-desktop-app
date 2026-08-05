<script lang="ts">
  import SettingsPage from '../src/desktop-alt/pages/SettingsPage.svelte';
  import Popover from '../src/components/Popover.svelte';
  import SignInPrompt from '../src/components/SignInPrompt.svelte';
  import BannerNotification from '../src/components/BannerNotification.svelte';
  import CompanyPage from '../src/desktop-alt/pages/CompanyPage.svelte';
  import HomePage from '../src/desktop-alt/pages/HomePage.svelte';
  import DesktopApp from '../src/desktop-alt/DesktopApp.svelte';
  import DaybookApp from './v2/DaybookApp.svelte';
  import ActivityLog from '../src/components/ActivityLog.svelte';
  import NewFilesDetail from '../src/components/NewFilesDetail.svelte';
  import DriftDetail from '../src/components/DriftDetail.svelte';
  import ShareDetail from '../src/components/ShareDetail.svelte';
  import DmDetail from '../src/components/DmDetail.svelte';
  import Widget from '../src/components/Widget.svelte';
  import MeetingsWindow from '../src/components/MeetingsWindow.svelte';
  import MeetingPermissionsWindow from '../src/components/MeetingPermissionsWindow.svelte';
  import OnboardingWizard from '../src/components/onboarding/OnboardingWizard.svelte';
  import GlobalErrorBoundary from '../src/components/GlobalErrorBoundary.svelte';
  import GlobalErrorPreview from './GlobalErrorPreview.svelte';
  import Conversation, {
    type ConversationMessage,
  } from '../src/components/messaging/Conversation.svelte';
  import MessagesShell from '../src/components/messaging/MessagesShell.svelte';
  import CreateChannel from '../src/components/messaging/CreateChannel.svelte';
  import {
    WIDGET_RECENT_STORAGE_KEY,
    type WidgetStackItem,
  } from '../src/stores/widgetNotifications';
  import '../src/desktop-alt/styles/desktop-alt.css';
  import { popoverProps, bannerFixtures, workspaces } from './fixtures';
  import { emit } from '@tauri-apps/api/event';
  import wallpaperLight from './assets/wallpaper-light.jpg';
  import wallpaperDark from './assets/wallpaper-dark.jpg';

  // Fixture thread for ?view=conversation — exercises the copy-message toolbar
  // and the copy-prompt button (the last inbound message carries an agent
  // prompt). Times are passed in via ISO strings so the harness stays
  // deterministic without Date.now().
  const conversationMessages: ConversationMessage[] = [
    {
      eventId: 'm1',
      fromPersonUid: 'prs_maya',
      fromDisplayName: 'Maya Chen',
      body: 'Morning! Did the conflict-versioning branch land?',
      createdAt: '2026-06-10T16:02:00Z',
      direction: 'in',
    },
    {
      eventId: 'm2',
      fromPersonUid: 'prs_me',
      fromDisplayName: 'Corey Epstein',
      body: 'Just merged it — running the e2e suite now.',
      createdAt: '2026-06-10T16:04:00Z',
      direction: 'out',
    },
    {
      eventId: 'm3',
      fromPersonUid: 'prs_maya',
      fromDisplayName: 'Maya Chen',
      body: 'Nice. Can you kick off the audit on the indigo repo?',
      details: 'Repo: repos/private/indigo-app · branch: main',
      prompt: '/run-project indigo-app --story audit-pass --headless',
      createdAt: '2026-06-10T16:06:00Z',
      direction: 'in',
    },
  ];

  // The Indigo workspace fixture drives the ?view=company desktop board preview.
  const indigoWorkspace = workspaces.find((w) => w.slug === 'indigo') ?? workspaces[0];

  // ?view=home — the merged Home in isolation (DesktopApp is auth-gated). Real
  // local-data sections only: portfolio stat strip + company table + today's
  // meetings + the activity digest. Projects/meetings are inline fixtures.
  const homeProjects = [
    { id: 'p1', title: 'Native CRM', name: 'Native CRM', description: '', company: 'indigo', status: 'in-progress', prdPath: '', createdAt: null, updatedAt: null, storiesTotal: 8, storiesComplete: 3 },
    { id: 'p2', title: 'Docs site refresh', name: 'Docs site refresh', description: '', company: 'indigo', status: 'done', prdPath: '', createdAt: null, updatedAt: null, storiesTotal: 5, storiesComplete: 5 },
    { id: 'p3', title: 'Recovery flows', name: 'Recovery flows', description: '', company: 'liverecover', status: 'in-progress', prdPath: '', createdAt: null, updatedAt: null, storiesTotal: 6, storiesComplete: 1 },
    { id: 'p4', title: 'Field sync', name: 'Field sync', description: '', company: 'moonflow', status: 'planning', prdPath: '', createdAt: null, updatedAt: null, storiesTotal: 0, storiesComplete: 0 },
  ];
  const todayISO = (h: number, m: number) => {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.toISOString();
  };
  const homeMeetings = [
    { id: 'mtg1', summary: 'Creative Ops kickoff', start: { dateTime: todayISO(10, 0) }, end: { dateTime: todayISO(10, 30) }, status: 'confirmed', sourceCompanyUid: 'cmp_indigo' },
    { id: 'mtg2', summary: 'Indigo standup', start: { dateTime: todayISO(11, 30) }, end: { dateTime: todayISO(11, 45) }, status: 'confirmed', sourceCompanyUid: 'cmp_indigo' },
    { id: 'mtg3', summary: 'Field sync', start: { dateTime: todayISO(16, 0) }, end: { dateTime: todayISO(16, 30) }, status: 'confirmed' },
  ];
  const homeCompanyNames = new Map([['cmp_indigo', 'Indigo']]);

  const driftPreviewReport = {
    count: 3,
    modified: [
      {
        path: 'core/policies/desktop-design.md',
        size: 1840,
        gitShaLocal: 'local-design',
        gitShaUpstream: 'upstream-design',
        stagingStatus: 'unaccounted',
      },
    ],
    missing: [
      {
        path: 'core/knowledge/public/hq-core/desktop.md',
        size: 2650,
        gitShaLocal: null,
        gitShaUpstream: 'upstream-desktop',
      },
    ],
    added: [
      {
        path: 'core/workers/public/desktop-auditor.md',
        size: 1320,
        gitShaLocal: 'local-auditor',
        gitShaUpstream: null,
        stagingStatus: 'pr:412',
      },
    ],
    scannedAt: '2026-07-26T12:00:00.000Z',
    hqVersion: '15.0.16',
    targetRepo: 'indigoai-us/hq-core',
    targetRef: 'v15.0.16',
  };

  const sharePreviewEvents = [
    {
      eventId: 'share-preview-1',
      issuerEmail: 'maya@getindigo.ai',
      issuerDisplayName: 'Maya Chen',
      issuerPersonUid: 'prs_maya',
      paths: [
        'companies/indigo/projects/hq-desktop-app/README.md',
        'companies/indigo/projects/hq-desktop-app/prd.json',
      ],
      note: 'The desktop recovery notes and acceptance criteria are ready for review.',
      permission: 'read',
      createdAt: '2026-07-26T17:30:00.000Z',
    },
  ];

  const newFilesPreview = [
    {
      path: 'companies/indigo/projects/hq-desktop-app/README.md',
      bytes: 6842,
      addedBy: 'maya@getindigo.ai',
    },
    {
      path: 'companies/indigo/knowledge/desktop-release-checklist.md',
      bytes: 2140,
      addedBy: 'corey@getindigo.ai',
    },
    {
      path: 'companies/indigo/meetings/2026-07-28-desktop-review.md',
      bytes: 932,
      addedBy: null,
    },
  ];

  const dmPreviewEvent = {
    eventId: 'dm-preview-1',
    fromPersonUid: 'prs_maya',
    fromEmail: 'maya@getindigo.ai',
    fromDisplayName: 'Maya Chen',
    body: 'The auxiliary desktop pass is ready for a final visual review.',
    details: 'Includes recovery, permissions, meetings, shares, and the widget.',
    prompt: '/review hq-desktop-app --surface auxiliary',
    createdAt: '2026-07-26T17:42:00.000Z',
  };

  const widgetPreviewItems: WidgetStackItem[] = [
    {
      id: 'widget-preview-message',
      type: 'message',
      actor: 'Maya',
      text: 'The desktop recovery pass is ready for review.',
      ts: Date.now() - 90_000,
      kind: 'dm',
      clickActionId: 'open',
      actionId: 'open',
      actionLabel: 'Open',
      data: { fromPersonUid: 'prs_maya' },
      expiresAt: Date.now() + 60 * 60_000,
      unread: true,
    },
    {
      id: 'widget-preview-share',
      type: 'share',
      actor: 'Indigo',
      text: 'Shared the HQ Desktop acceptance criteria.',
      ts: Date.now() - 8 * 60_000,
      kind: 'share',
      clickActionId: 'open',
      actionId: 'open',
      actionLabel: 'Open',
      data: {},
      expiresAt: Date.now() + 60 * 60_000,
      unread: false,
    },
  ];

  const widgetUpdatePreviewItems: WidgetStackItem[] = [
    {
      id: 'widget-preview-update',
      type: 'system',
      actor: 'HQ',
      text: 'Version 0.10.36-beta.1 is ready to install.',
      ts: Date.now() - 30_000,
      kind: 'update',
      clickActionId: 'open',
      actionId: 'update',
      actionLabel: 'Update now',
      data: {
        version: '0.10.36-beta.1',
        body: 'Desktop surface repairs and updater recovery.',
        date: '2026-07-26',
        detectedAt: new Date(Date.now() - 30_000).toISOString(),
      },
      expiresAt: Date.now() + 60 * 60_000,
      unread: true,
    },
  ];

  // View + theme driven by URL query so screenshots target a known state:
  //   ?view=settings|popover|signin|banner   ?theme=light|dark
  //   banner view also takes ?kind=share|meeting|dm|update (default share)
  // For the popover view, size the browser viewport to ~320x440 (the real
  // window size) — the popover root fills 100vw/100vh. For settings, any
  // viewport works; it renders centered on a desktop-ish backdrop.
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view') ?? 'settings';
  // Theme is reactive for the desktop stage's Light/Dark toggle. The desktop
  // view previews light-first (the redesign target); the v2 concept previews
  // dark-first (its home appearance); everything else keeps the historical
  // dark default so existing ?view= links render unchanged.
  let theme = $state(params.get('theme') ?? (params.get('view') === 'desktop' ? 'light' : 'dark'));

  // V1 ↔ V2 stage switcher (design-review affordance on the mac stage).
  function switchVersion(v: 'desktop' | 'v2') {
    if (view === v) return;
    const next = new URLSearchParams(window.location.search);
    next.set('view', v);
    // Each version opens on its home appearance unless the user re-toggles.
    next.delete('theme');
    window.location.search = next.toString();
  }
  const bannerKind = params.get('kind') ?? 'share';
  const scenario = params.get('scenario');
  const requestedOnboardingStep = Number.parseInt(params.get('step') ?? '0', 10);
  const onboardingStep =
    Number.isInteger(requestedOnboardingStep) &&
    requestedOnboardingStep >= 0 &&
    requestedOnboardingStep <= 3
      ? requestedOnboardingStep
      : 0;
  // ?state=error renders the "Sync initialized" notice banner.
  // ?state=auth-error renders the calm reconnect state without red styling.
  // Otherwise the popover mounts in its idle fixture state.
  // (CLI-update overflow preview retired with US-001 chrome strip.)
  const stateOverride = params.get('state');
  if (view === 'widget') {
    localStorage.removeItem(WIDGET_RECENT_STORAGE_KEY);
  }
  const previewPopoverProps =
    stateOverride === 'error'
      ? { ...popoverProps, syncState: 'error' as const, errorMessage: 'failed to push indigo: exit 1', errorCompany: 'indigo' }
      : stateOverride === 'auth-error'
        ? {
            ...popoverProps,
            syncState: 'auth-error' as const,
            errorMessage: 'Sign in once and HQ will resume automatically.',
          }
      : popoverProps;

  // The banner reads its transparent-window CSS off html[data-window=dm-banner]
  // and renders only after a `banner:event`. Set the attr + emit the fixture
  // once the component's listener has mounted (next tick).
  document.documentElement.setAttribute(
    'data-window',
    view === 'banner'
      ? 'dm-banner'
      : view === 'company' || view === 'desktop' || view === 'home' || view === 'v2'
        ? 'desktop-alt'
        : view === 'meetings'
          ? 'meetings-window'
          : view === 'drift'
            ? 'drift-detail'
            : view === 'activity'
              ? 'activity-log'
              : view === 'new-files'
                ? 'new-files-detail'
              : view === 'share-detail'
                ? 'share-detail'
                : view === 'dm-detail'
                  ? 'dm-detail'
                  : view === 'widget'
                    ? 'widget'
        : view === 'permissions'
          ? 'meeting-permissions'
          : view === 'messages' || view === 'conversation' || view === 'createchannel'
            ? 'messages'
            : 'main'
  );
  $effect(() => {
    document.documentElement.dataset.forceTheme = theme;
  });

  if (view === 'banner') {
    const payload = bannerFixtures[bannerKind] ?? bannerFixtures.share;
    setTimeout(() => void emit('banner:event', payload), 50);
  }

  if (view === 'drift') {
    setTimeout(() => void emit('drift:report', driftPreviewReport), 75);
  } else if (view === 'new-files') {
    setTimeout(() => void emit('new-files:list', newFilesPreview), 75);
  } else if (view === 'share-detail') {
    setTimeout(() => void emit('share:events-list', sharePreviewEvents), 75);
  } else if (view === 'dm-detail') {
    setTimeout(() => void emit('dm:detail-event', dmPreviewEvent), 75);
  }

  // Deterministic safety-state previews for the full desktop shell. The delay
  // lets DesktopApp register native-event listeners before the fixture fires.
  if (view === 'desktop') {
    setTimeout(() => {
      if (scenario === 'conflict') {
        void emit('sync:conflict', {
          path: 'companies/indigo/projects/hq-desktop-app/prd.json',
          localHash: 'local-preview',
          remoteHash: 'remote-preview',
          canAutoResolve: false,
        });
      } else if (scenario === 'sync-error') {
        void emit('sync:error', {
          company: 'indigo',
          path: 'companies/indigo/projects/hq-desktop-app/prd.json',
          message: 'The cloud connection closed before the desktop audit could finish.',
        });
      }
    }, 250);
  }
</script>

{#if view === 'activity'}
  <!-- Recent Changes at its native 560x460 size. -->
  <ActivityLog />
{:else if view === 'new-files'}
  <!-- Newly synced files at its native 500x400 size. -->
  <NewFilesDetail />
{:else if view === 'drift'}
  <!-- Core Drift at its native 560x480 size. -->
  <DriftDetail />
{:else if view === 'share-detail'}
  <!-- Shared-with-me quick window at its native 640x560 size. -->
  <ShareDetail />
{:else if view === 'dm-detail'}
  <!-- Inbox / direct-message quick window at its native 820x640 size. -->
  <DmDetail />
{:else if view === 'widget'}
  <!-- Floating widget: inspect idle at 66x43, or use ?state=stack at
       the dynamic 340x480 maximum to exercise notification + mini-inbox UI. -->
  <Widget
    queued={scenario === 'update-available' || stateOverride === 'idle' ? 0 : 2}
    initialItems={scenario === 'update-available'
      ? widgetUpdatePreviewItems
      : stateOverride === 'idle'
        ? []
        : widgetPreviewItems}
  />
{:else if view === 'meetings'}
  <!-- Upcoming Meetings at its native 460x600 size. -->
  <MeetingsWindow />
{:else if view === 'permissions'}
  <!-- The Meeting Permissions wizard. Resize the preview viewport to ~620x720. -->
  <MeetingPermissionsWindow />
{:else if view === 'onboarding'}
  <!-- First-run onboarding at its real 780x620 transparent-window size.
       Pass ?step=0..3 to inspect every reachable lifecycle screen directly. -->
  <OnboardingWizard initialStep={onboardingStep} onfinish={() => {}} />
{:else if view === 'global-error'}
  <!-- Deterministic render failure for visually verifying the production
       Svelte error boundary without breaking any other harness route. -->
  <GlobalErrorBoundary component={GlobalErrorPreview} windowLabel="preview" />
{:else if view === 'desktop'}
  <!-- Real-life stage: the full desktop-alt window floating over a macOS
       wallpaper, with emulated window glass (the browser has no native
       NSGlassEffectView backing) and a Light/Dark toggle for design review. -->
  <div
    class="mac-stage"
    style={`background-image: url(${theme === 'dark' ? wallpaperDark : wallpaperLight})`}
  >
    <div class="mac-window">
      <DesktopApp />
    </div>
    <div class="stage-controls">
      <div class="stage-theme-toggle" role="group" aria-label="Preview version">
        <button type="button" class="active">V1</button>
        <button type="button" onclick={() => switchVersion('v2')}>V2</button>
      </div>
      <div class="stage-theme-toggle" role="group" aria-label="Preview appearance">
        <button
          type="button"
          class:active={theme === 'light'}
          onclick={() => (theme = 'light')}
        >Light</button>
        <button
          type="button"
          class:active={theme === 'dark'}
          onclick={() => (theme = 'dark')}
        >Dark</button>
      </div>
    </div>
  </div>
{:else if view === 'v2'}
  <!-- V2 concept ("Daybook", from Corey's draft) on the same real-life stage.
       Dark is its home appearance; the toggle still previews light. -->
  <div
    class="mac-stage"
    style={`background-image: url(${theme === 'dark' ? wallpaperDark : wallpaperLight})`}
  >
    <div class="mac-window v2-window">
      <DaybookApp {theme} />
    </div>
    <div class="stage-controls">
      <div class="stage-theme-toggle" role="group" aria-label="Preview version">
        <button type="button" onclick={() => switchVersion('desktop')}>V1</button>
        <button type="button" class="active">V2</button>
      </div>
      <div class="stage-theme-toggle" role="group" aria-label="Preview appearance">
        <button
          type="button"
          class:active={theme === 'light'}
          onclick={() => (theme = 'light')}
        >Light</button>
        <button
          type="button"
          class:active={theme === 'dark'}
          onclick={() => (theme = 'dark')}
        >Dark</button>
      </div>
    </div>
  </div>
{:else if view === 'banner'}
  <!-- The banner fills 100vw/100vh (tight native window). Resize the preview
       viewport to ~366x104 to see it at real proportions. -->
  <BannerNotification />
{:else if view === 'popover'}
  <Popover {...previewPopoverProps} />
{:else if view === 'signin'}
  <!-- Auth-expiry recovery at the native 320x440 popover size. -->
  <SignInPrompt reauth={true} />
{:else if view === 'conversation'}
  <!-- The shared messaging Conversation (desktop Messages styling via
       data-window='messages'). Hover a bubble to reveal the copy-message
       button; the last message carries an agent prompt → Copy prompt. -->
  <div class="conversation-stage">
    <Conversation
      messages={conversationMessages}
      showAuthors={true}
      onsend={() => {}}
      ontogglereaction={() => {}}
    />
  </div>
{:else if view === 'messages'}
  <!-- Full standalone Messages window: unified recency rail with DMs, channels,
       connection requests, and shared-path notifications. -->
  <MessagesShell />
{:else if view === 'createchannel'}
  <!-- The New-channel modal (font-size pass). data-window='messages' so the
       desktop tokens resolve. Companies/contacts come from Tauri commands that
       the harness doesn't fully mock, so the dropdown + picker may be empty —
       the type scale is what this view is for. -->
  <div class="conversation-stage" style="justify-content: center; background: var(--bg, #161616);">
    <CreateChannel onclose={() => {}} oncreated={() => {}} />
  </div>
{:else if view === 'company'}
  <!-- The desktop window's company page (default Board tab). Sized to the
       real desktop content area; data-window='desktop-alt' activates the
       desktop token aliases. -->
  <div class="desktop-stage">
    <CompanyPage company={indigoWorkspace} />
  </div>
{:else if view === 'home'}
  <!-- The merged Home in isolation. Resize the viewport to ~1180x760. -->
  <div class="desktop-stage">
    <HomePage
      syncState={stateOverride === 'auth-error' ? 'auth-error' : 'idle'}
      ready={true}
      {workspaces}
      progress={null}
      companies={[]}
      statsBySlug={{}}
      status={null}
      daemon={null}
      activity={[]}
      syncErrorMessage={stateOverride === 'auth-error' ? 'Sign in once and HQ will resume automatically.' : ''}
      syncFilesProgressed={0}
      syncTotalFiles={0}
      transferredBytes={0}
      autoSyncOn={true}
      hqVersion="15.0.16"
      conflicts={[]}
      coreState={null}
      projects={homeProjects}
      meetingEvents={homeMeetings}
      companyNamesByUid={homeCompanyNames}
      onopencompany={() => {}}
    />
  </div>
{:else}
  <!-- Settings now live in the desktop-alt window (US-005). Preview the V4
       SettingsPage rather than the retired popover Settings.svelte. -->
  <div class="desktop-stage" class:light={theme === 'light'}>
    <SettingsPage activeTab="sync" />
  </div>
{/if}

<style>
  :global(html[data-window='desktop-alt']),
  :global(html[data-window='desktop-alt'] body) {
    width: 100%;
    height: 100vh;
    min-height: 0;
    margin: 0;
  }

  :global(html[data-window='desktop-alt'] body) {
    overflow: hidden;
  }

  :global(html[data-window='desktop-alt'] #app) {
    width: 100%;
    height: 100vh;
    min-height: 0;
    overflow: hidden;
  }

  /* ---- Real-life desktop stage (?view=desktop) ---- */

  .mac-stage {
    position: fixed;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 44px 44px 92px;
    box-sizing: border-box;
    background-size: cover;
    background-position: center;
  }

  /* Figma 2578:934 window material: 26px corners, white/80 over 50px
     backdrop blur, 1px ring + soft drop shadow. */
  .mac-window {
    position: relative;
    width: min(1180px, 100%);
    height: min(800px, 100%);
    border-radius: 18px;
    overflow: hidden;
    background: rgba(255, 255, 255, 0.8);
    -webkit-backdrop-filter: blur(50px);
    backdrop-filter: blur(50px);
    box-shadow:
      0 0 0 1px rgba(0, 0, 0, 0.23),
      0 16px 48px rgba(0, 0, 0, 0.35);
  }

  :global(html[data-force-theme='dark']) .mac-window {
    background: rgba(28, 28, 30, 0.8);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.14),
      0 16px 48px rgba(0, 0, 0, 0.55);
  }


  /* V2 concept window: darker, colder glass than the v1 material. */
  .mac-window.v2-window {
    background: rgba(250, 250, 252, 0.78);
  }

  :global(html[data-force-theme='dark']) .mac-window.v2-window {
    background: rgba(14, 14, 18, 0.82);
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.12),
      0 16px 48px rgba(0, 0, 0, 0.55);
  }

  .stage-controls {
    position: fixed;
    bottom: 28px;
    left: 50%;
    transform: translateX(-50%);
    display: inline-flex;
    gap: 10px;
  }

  .stage-controls .stage-theme-toggle {
    position: static;
    transform: none;
  }

  .stage-theme-toggle {
    position: fixed;
    bottom: 28px;
    left: 50%;
    transform: translateX(-50%);
    display: inline-flex;
    gap: 2px;
    padding: 3px;
    border-radius: 999px;
    background: rgba(20, 20, 22, 0.35);
    -webkit-backdrop-filter: blur(20px) saturate(1.4);
    backdrop-filter: blur(20px) saturate(1.4);
    box-shadow: 0 4px 18px rgba(0, 0, 0, 0.25);
  }

  .stage-theme-toggle button {
    appearance: none;
    border: 0;
    margin: 0;
    padding: 7px 18px;
    border-radius: 999px;
    background: transparent;
    color: rgba(255, 255, 255, 0.72);
    font: 500 13px/1 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    cursor: pointer;
  }

  .stage-theme-toggle button.active {
    background: #ffffff;
    color: #111113;
  }

  .stage {
    min-height: 100vh;
    display: grid;
    place-items: start center;
    padding: 32px;
    box-sizing: border-box;
    background: radial-gradient(120% 120% at 30% 10%, #3a3a3a 0%, #1a1a1a 55%, #0c0c0c 100%);
  }
  .stage.light {
    background: radial-gradient(120% 120% at 30% 10%, #ededed 0%, #d4d4d4 55%, #bcbcbc 100%);
  }
  .window {
    border-radius: var(--radius-popover, 8px);
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45), 0 2px 8px rgba(0, 0, 0, 0.3);
  }

  /* Desktop window content area (company page). desktop-alt.css paints the
     body background under html[data-window='desktop-alt']; this just insets
     the page like the real window's main pane. */
  .desktop-stage {
    box-sizing: border-box;
    min-height: 100vh;
    padding: 28px 32px;
  }

  /* Conversation preview: a fixed-width column with the messages-window
     surface, so the thread + composer render at realistic proportions. The
     component is column-flex and fills height, so the stage pins it. */
  .conversation-stage {
    box-sizing: border-box;
    width: 460px;
    height: 100vh;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    background: var(--bg, #161616);
  }

  /* Banner preview: the real window is 366x104, pinned top-right over the
     desktop. The browser harness can't show native NSVisualEffectView vibrancy,
     so a busy wallpaper-ish backdrop stands in to judge tint + the HQ mark.
     (True liquid glass must be confirmed in the Tauri runtime.) */
  :global(html[data-window='dm-banner']),
  :global(html[data-window='dm-banner'] body) {
    background: radial-gradient(120% 120% at 75% 10%, #565656 0%, #292929 55%, #0c0c0c 100%) !important;
  }
  .banner-stage {
    width: 366px;
    height: 104px;
    margin: 40px auto;
  }
</style>

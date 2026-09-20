<script lang="ts">
  import SignInPrompt from '../src/components/SignInPrompt.svelte';
  import BannerNotification from '../src/components/BannerNotification.svelte';
  import HqWorkWorkShell from '../src/desktop-alt/HqWorkWorkShell.svelte';
  import { createLifecycleInvoke, resolveLifecycleOptions } from './lifecycle-scenario';
  import ActivityLog from '../src/components/ActivityLog.svelte';
  import NewFilesDetail from '../src/components/NewFilesDetail.svelte';
  import DriftDetail from '../src/components/DriftDetail.svelte';
  import ShareDetail from '../src/components/ShareDetail.svelte';
  import MeetingsWindow from '../src/components/MeetingsWindow.svelte';
  import MeetingPermissionsWindow from '../src/components/MeetingPermissionsWindow.svelte';
  import OnboardingWizard from '../src/components/onboarding/OnboardingWizard.svelte';
  import CinematicIntro from '../src/components/onboarding/CinematicIntro.svelte';
  import { WIZARD_STEPS } from '../src/lib/onboarding-wizard';
  import GlobalErrorBoundary from '../src/components/GlobalErrorBoundary.svelte';
  import GlobalErrorPreview from './GlobalErrorPreview.svelte';
  import Conversation, {
    type ConversationMessage,
  } from '../src/components/messaging/Conversation.svelte';
  import '../src/desktop-alt/styles/desktop-alt.css';
  import { bannerFixtures } from './fixtures';
  import { emit } from '@tauri-apps/api/event';

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

  // View + theme driven by URL query so screenshots target a known state:
  //   ?view=shell|signin|banner   ?theme=light|dark
  //   banner view also takes ?kind=share|meeting|dm|update (default share)
  //   shell view takes ?persona=empty-inbox|personal-only|multi-company|indigo
  //   lifecycle view (channel-native company lifecycle, stateful mock) takes
  //     ?role=member (viewer.canAct=false everywhere) and ?state=blocked
  // For the signin view, size the browser viewport to ~320x440 (the real
  // `main` window size) — the sign-in root fills 100vw/100vh. The default
  // view is the production HQ Work shell; size that one to ~1180x760.
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view') ?? 'shell';
  const theme = params.get('theme') ?? 'dark';
  const bannerKind = params.get('kind') ?? 'share';
  const requestedOnboardingStep = Number.parseInt(params.get('step') ?? '0', 10);
  // Bound by the wizard's real step count rather than a hand-written ceiling.
  // The literal `3` this replaced predated every step added after Consent, so
  // `?step=4` upward — including this harness's own default entry point, and
  // the Ready screen at 5 — silently fell back to Welcome.
  const LAST_ONBOARDING_STEP = WIZARD_STEPS[WIZARD_STEPS.length - 1].index;
  // ?beat=0..N opens the intro directly on one scene for design work.
  const introBeatParam = params.get('beat');
  const introBeat =
    introBeatParam === null ? null : Number.parseInt(introBeatParam, 10);

  const onboardingStep =
    Number.isInteger(requestedOnboardingStep) &&
    requestedOnboardingStep >= 0 &&
    requestedOnboardingStep <= LAST_ONBOARDING_STEP
      ? requestedOnboardingStep
      : 0;
  // The banner reads its transparent-window CSS off html[data-window=dm-banner]
  // and renders only after a `banner:event`. Set the attr + emit the fixture
  // once the component's listener has mounted (next tick).
  document.documentElement.setAttribute(
    'data-window',
    view === 'banner'
      ? 'dm-banner'
      : view === 'shell' || view === 'lifecycle'
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
        : view === 'permissions'
          ? 'meeting-permissions'
          : view === 'conversation'
            ? 'messages'
            : 'main'
  );
  document.documentElement.dataset.forceTheme = theme;

  // Stateful lifecycle backend — created once per page load so clicks persist.
  const lifecycleInvoke =
    view === 'lifecycle'
      ? createLifecycleInvoke(resolveLifecycleOptions(window.location.search)).invokeFn
      : null;

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
{:else if view === 'meetings'}
  <!-- Upcoming Meetings at its native 460x600 size. -->
  <MeetingsWindow />
{:else if view === 'permissions'}
  <!-- The Meeting Permissions wizard. Resize the preview viewport to ~620x720. -->
  <MeetingPermissionsWindow />
{:else if view === 'intro'}
  <!-- The cinematic first-run intro. Resize the preview viewport to ~1100x740.
       In the real app the window is transparent with native frosted material,
       so what sits behind the intro is the person's blurred desktop. A browser
       cannot reproduce NSVisualEffectView, so the harness paints a stand-in
       "desktop" here purely so the iris takeover is visible during design
       work. This backdrop does NOT exist in the shipped app. -->
  <div class="fake-desktop" aria-hidden="true"></div>
  <CinematicIntro onfinish={() => {}} startAtBeat={introBeat} />
{:else if view === 'onboarding'}
  <!-- First-run onboarding at its real 780x620 transparent-window size.
       Pass ?step=0..3 to inspect every reachable lifecycle screen directly;
       continuation=on previews the verified-browser-account offer. -->
  <OnboardingWizard initialStep={onboardingStep} onfinish={() => {}} />
{:else if view === 'global-error'}
  <!-- Deterministic render failure for visually verifying the production
       Svelte error boundary without breaking any other harness route. -->
  <GlobalErrorBoundary component={GlobalErrorPreview} windowLabel="preview" />
{:else if view === 'shell'}
  <!-- Production HQ Work shell (HqWorkWorkShell). Pair with
       ?persona=empty-inbox|personal-only|multi-company|indigo so the mocked
       adapter is the same matrix CI mounts. -->
  <HqWorkWorkShell />
{:else if view === 'lifecycle' && lifecycleInvoke}
  <!-- Channel-native company lifecycle against an in-memory backend
       (dev-harness/lifecycle-scenario.ts). Start in #setup, create the
       company, walk cloud → plan → agent, then click the company tabs.
       Resize the viewport to ~1180x760. -->
  <HqWorkWorkShell invokeFn={lifecycleInvoke} />
{:else if view === 'banner'}
  <!-- The banner fills 100vw/100vh (tight native window). Resize the preview
       viewport to ~366x104 to see it at real proportions. -->
  <BannerNotification />
{:else if view === 'signin'}
  <!-- Auth-expiry recovery at the native 320x440 `main` window size. -->
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
{:else}
  <!-- Production HQ Work shell (HqWorkWorkShell) — the harness default. Pair
       with ?persona=empty-inbox|personal-only|multi-company|indigo. -->
  <HqWorkWorkShell />
{/if}

<style>
  .fake-desktop {
    position: fixed;
    inset: 0;
    z-index: 0;
    background:
      radial-gradient(40% 50% at 18% 22%, #3b4a63, transparent 70%),
      radial-gradient(45% 45% at 82% 30%, #5a4360, transparent 70%),
      radial-gradient(60% 55% at 50% 95%, #24303f, transparent 75%),
      linear-gradient(160deg, #2b3446, #171d28);
    filter: blur(26px) saturate(115%);
  }

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

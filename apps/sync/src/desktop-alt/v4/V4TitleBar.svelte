<script lang="ts">
  import type { SyncState } from '../lib/sync-model';
  import type { SettingsTab } from '../route';
  import { getV4TitleBarModel, type V4HydrationIssue } from './model';
  import { titlebarDayDate } from '../chat/sidebar-model';
  import type { HomeConflict } from './home-model';
  import CorePopover from './CorePopover.svelte';
  import { corePillDotTone } from './core-popover-model';
  import './tokens.css';
  import '../chat/chat-tokens.css';

  /**
   * Minimal native title bar (visual QA D-04): traffic-light inset, sidebar
   * toggle, HQ wordmark, DAY · DATE, meetings icon, bell with monochrome unread
   * dot, and Core pill. Sync/cloud/version/account live in Core + sidebar footer.
   * Liquid Glass lives on this chrome only. Tauri drag regions are limited to
   * noninteractive padded spacers — never the whole header and never controls.
   *
   * Extra props (syncState, watchedCount, …) remain accepted so DesktopApp can
   * keep a single wiring surface; they are no longer rendered as V1 chrome.
   */
  interface Props {
    version: string;
    syncState: SyncState;
    watchedCount: number;
    lastSyncLabel?: string | null;
    syncingCompany?: string | null;
    fanoutDone?: number;
    fanoutTotal?: number;
    errorSummary?: string | null;
    hydrationIssue?: V4HydrationIssue | null;
    hydrationRefreshing?: boolean;
    errorMessage?: string;
    errorCompany?: string | null;
    conflictCount?: number;
    conflictCompany?: string | null;
    hqFolderPath?: string | null;
    accountInitials?: string | null;
    sidebarCollapsed?: boolean;
    onsync?: () => void | Promise<void>;
    oncancel?: () => void | Promise<void>;
    onretry?: () => void | Promise<void>;
    onretryhydration?: () => void | Promise<void>;
    onresolveconflicts?: () => void | Promise<void>;
    ontogglesidebar?: () => void;
    oncommand?: () => void;
    onaccount?: () => void;
    onOpenSettings?: (tab?: SettingsTab) => void;
    onopenMeetings?: () => void;
    onopenNotifications?: () => void;
    /** Unread count drives monochrome bell dot only (no red pill). */
    unreadCount?: number;
    cloudPaused?: boolean;
    conflicts?: HomeConflict[];
    /** USER-EDIT drift count from the shell's core-state scan (G7 dot tone). */
    driftCount?: number;
    oncloudtoggle?: (paused: boolean) => void;
    onresolveconflict?: (
      path: string,
      strategy: 'keep-local' | 'keep-remote',
    ) => void | Promise<void>;
    onopenconflict?: (path: string) => void | Promise<void>;
    onopendrift?: () => void | Promise<void>;
    onopenLibrary?: () => void;
    onopenMarketplace?: () => void;
  }

  let {
    version,
    syncState,
    watchedCount,
    lastSyncLabel = null,
    syncingCompany = null,
    fanoutDone = 0,
    fanoutTotal = 0,
    errorSummary = null,
    hydrationIssue = null,
    hydrationRefreshing = false,
    conflictCount = 0,
    conflictCompany = null,
    onsync,
    oncancel,
    onretry,
    onretryhydration,
    onresolveconflicts,
    sidebarCollapsed = false,
    ontogglesidebar,
    onopenMeetings,
    onopenNotifications,
    unreadCount = 0,
    cloudPaused = false,
    conflicts = [],
    driftCount = 0,
    onresolveconflict,
    onopenconflict,
    onopendrift,
    onopenLibrary,
    onopenMarketplace,
  }: Props = $props();

  const dayDateLabel = $derived(titlebarDayDate());

  /**
   * Canonical status model. The minimal titlebar (D-04) hides idle sync
   * chrome, but recovery flows stay first-class: hydration Retry re-runs the
   * real hydration commands and conflicts route through the canonical
   * resolve-conflicts prompt — never a bare Sync.
   */
  const model = $derived(
    getV4TitleBarModel({
      syncState,
      watchedCount,
      lastSyncLabel,
      syncingCompany,
      fanoutDone,
      fanoutTotal,
      errorSummary,
      hydrationIssue,
    }),
  );
  let recoveryBusy = $state(false);

  async function handleRecoveryAction(): Promise<void> {
    if (recoveryBusy) return;
    recoveryBusy = true;
    try {
      if (model.recovery === 'hydration') await onretryhydration?.();
      else if (model.action.id === 'cancel') await oncancel?.();
      else if (model.action.id === 'retry') await onretry?.();
      else if (model.action.id === 'resolve') await onresolveconflicts?.();
      else await onsync?.();
    } catch (err) {
      console.error(`titlebar: ${model.action.id} action failed`, err);
    } finally {
      recoveryBusy = false;
    }
  }

  /**
   * Recovery card for the Core popover (D-04: no recovery chrome in the bar).
   * Hydration Retry re-runs the real hydration commands; conflicts route
   * through the canonical resolve-conflicts prompt — never a bare Sync.
   */
  const recoveryCard = $derived.by(() => {
    if (model.recovery === 'hydration') {
      return {
        sentence: model.sentence,
        label: hydrationRefreshing || recoveryBusy ? 'Retrying…' : 'Retry',
        busy: hydrationRefreshing || recoveryBusy,
        copyIssue: null,
      };
    }
    if (syncState === 'conflict' && model.action.id === 'resolve') {
      return {
        sentence: model.sentence,
        label: recoveryBusy ? 'Opening…' : 'Resolve conflicts',
        busy: recoveryBusy,
        copyIssue: {
          kind: 'sync-conflict' as const,
          payload: { count: conflictCount, company: conflictCompany },
        },
      };
    }
    if (syncState === 'error' || syncState === 'auth-error') {
      return {
        sentence: model.sentence,
        label: recoveryBusy ? 'Working…' : model.action.label,
        busy: recoveryBusy,
        copyIssue: null,
      };
    }
    return null;
  });

  /** Bell monochrome dot only — no red pill / count (D-04). */
  const hasUnread = $derived(
    Number.isFinite(unreadCount) && Math.floor(unreadCount) > 0,
  );
  let coreOpen = $state(false);
  let coreContainer: HTMLDivElement | null = $state(null);

  /** G7: amber dot while a conflict/attention item is pending; green when healthy. */
  const coreDotTone = $derived(
    corePillDotTone({
      conflictCount: Math.max(conflictCount, conflicts.length),
      syncState,
      driftCount,
      cloudPaused,
    }),
  );

  function openCore(): void {
    coreOpen = !coreOpen;
  }

  $effect(() => {
    if (!coreOpen) return;

    function onMouseDown(event: MouseEvent) {
      if (!(event.target instanceof Node)) return;
      if (coreContainer && !coreContainer.contains(event.target)) {
        coreOpen = false;
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') coreOpen = false;
    }

    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  });
</script>

<header class="v4-titlebar chat-shell" aria-label="Window chrome">
  <div class="v4-titlebar-leading">
    <!-- Padded dead space under the native traffic lights — safe drag only. -->
    <div class="v4-drag-pad v4-drag-lights" data-tauri-drag-region aria-hidden="true"></div>
    <button
      type="button"
      class="v4-icon-btn"
      class:active={!sidebarCollapsed}
      aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
      title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
      aria-pressed={!sidebarCollapsed}
      onclick={() => ontogglesidebar?.()}
    >
      <svg class="v4-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2" stroke="currentColor" stroke-width="1.2" />
        <path d="M5.25 2.5v11" stroke="currentColor" stroke-width="1.2" />
      </svg>
    </button>
    <span class="v4-wordmark" data-testid="titlebar-wordmark" aria-label="HQ">HQ</span>
    <span class="v4-day-date" data-testid="titlebar-day-date">{dayDateLabel}</span>
  </div>

  <!-- Flexible noninteractive pad — primary drag. -->
  <div class="v4-drag-pad v4-drag-flex" data-tauri-drag-region aria-hidden="true"></div>

  <div class="v4-title-actions">
    <button
      type="button"
      class="v4-icon-btn"
      data-testid="titlebar-meetings"
      aria-label="Meetings"
      title="Meetings"
      onclick={() => {
        coreOpen = false;
        onopenMeetings?.();
      }}
    >
      <svg class="v4-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2" y="4" width="12" height="8.5" rx="1.5" stroke="currentColor" stroke-width="1.2" />
        <circle cx="8" cy="8.25" r="2" stroke="currentColor" stroke-width="1.2" />
        <path d="M11.5 6.5l2-1.25v5.5L11.5 9.5" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
      </svg>
    </button>
    <button
      type="button"
      class="v4-icon-btn v4-notif-btn"
      data-testid="titlebar-notifications"
      aria-label={hasUnread ? 'Notifications, unread' : 'Notifications'}
      title="Notifications"
      onclick={() => {
        coreOpen = false;
        onopenNotifications?.();
      }}
    >
      <svg class="v4-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 2.25a3.5 3.5 0 0 0-3.5 3.5v2.1l-1.2 1.8h9.4l-1.2-1.8V5.75A3.5 3.5 0 0 0 8 2.25Z"
          stroke="currentColor"
          stroke-width="1.2"
          stroke-linejoin="round"
        />
        <path d="M6.5 12.25a1.5 1.5 0 0 0 3 0" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
      </svg>
      {#if hasUnread}
        <span
          class="v4-notif-dot"
          data-testid="titlebar-notifications-badge"
          aria-hidden="true"
        ></span>
      {/if}
    </button>
    <div class="v4-core-wrap" bind:this={coreContainer}>
      <button
        type="button"
        class="v4-core-pill"
        data-testid="titlebar-core-pill"
        title="Core"
        aria-expanded={coreOpen}
        aria-haspopup="dialog"
        aria-label="Open Core popover"
        onclick={openCore}
      >
        <span
          class="v4-core-dot"
          class:warn={coreDotTone === 'warn'}
          data-testid="titlebar-core-dot"
          data-tone={coreDotTone}
          aria-hidden="true"
        >●</span>
        Core
        <span class="v4-core-caret" aria-hidden="true">⌄</span>
      </button>
      {#if coreOpen}
        <CorePopover
          appVersion={version}
          {conflicts}
          {cloudPaused}
          recovery={recoveryCard}
          onrecovery={handleRecoveryAction}
          onclose={() => (coreOpen = false)}
          onresolve={onresolveconflict}
          onopeneditor={onopenconflict}
          {onopendrift}
          onopenLibrary={() => {
            onopenLibrary?.();
            coreOpen = false;
          }}
          onopenMarketplace={() => {
            onopenMarketplace?.();
            coreOpen = false;
          }}
        />
      {/if}
    </div>
  </div>
</header>

<style>
  .v4-titlebar {
    position: relative;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 48px;
    height: 48px;
    overflow: visible;
    padding: 0 16px 0 0;
    border-bottom: 1px solid var(--line);
    background: transparent;
    font: 400 13px/1.45 var(--font-ui);
  }

  .v4-titlebar-leading {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    gap: 8px;
    /* 78px left inset clears the overlay traffic lights (macOS). */
    padding-left: 78px;
  }

  .v4-wordmark {
    flex: 0 0 auto;
    color: var(--t1);
    font-size: 13px;
    font-weight: 600;
    line-height: 1;
  }

  .v4-day-date {
    flex: 0 0 auto;
    color: var(--t3);
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 400;
    letter-spacing: 0.08em;
    line-height: 1;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .v4-core-wrap {
    position: relative;
    flex: 0 0 auto;
  }

  .v4-core-pill {
    appearance: none;
    -webkit-appearance: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: var(--btn-bg);
    color: var(--t2);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
  }

  .v4-core-pill:hover,
  .v4-core-pill[aria-expanded='true'] {
    border-color: var(--line2);
    color: var(--t1);
  }

  .v4-core-pill:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: var(--v4-focus-offset, 2px);
  }

  .v4-core-dot {
    color: var(--ok);
    font-size: 7px;
    line-height: 1;
  }

  /* Attention pending (conflicts / sync error / paused): amber, tokens
     rgb(240,168,0) light / rgb(250,204,21) dark via --warn (G7). */
  .v4-core-dot.warn {
    color: var(--warn);
  }

  .v4-core-caret {
    color: var(--t3);
    font-size: 10px;
    line-height: 1;
  }

  /* Windows uses the native decorated title bar (system controls + Snap
     Layouts). The HQ toolbar sits below it — no macOS traffic-light gutter. */
  :global(html[data-platform='windows']) .v4-titlebar-leading {
    padding-left: 12px;
  }

  :global(html[data-platform='windows']) .v4-drag-lights {
    width: 0;
    display: none;
  }

  .v4-drag-pad {
    flex: 0 0 auto;
    align-self: stretch;
    min-height: 100%;
  }

  .v4-drag-lights {
    width: 8px;
  }

  .v4-drag-flex {
    flex: 1 1 auto;
    min-width: 12px;
  }

  .v4-title-actions {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    gap: 6px;
    border: 0;
    border-radius: 0;
    background: transparent;
  }

  .v4-icon-btn {
    appearance: none;
    -webkit-appearance: none;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    color: var(--t2);
    font: inherit;
    cursor: pointer;
    transition: color 0.12s, background 0.12s;
  }

  .v4-icon-btn:hover,
  .v4-icon-btn.active {
    background: var(--hover);
    color: var(--t1);
  }

  /* Pressed global controls stay visibly selected without inheriting the OS
     accent color. aria-pressed remains the semantic source of truth. */
  .v4-icon-btn[aria-pressed='true'] {
    border-color: var(--v4-control-border);
    background: color-mix(in srgb, var(--v4-text-1) 8%, transparent);
    box-shadow: inset 0 0 0 1px var(--v4-hairline);
    color: var(--v4-text-1);
  }

  .v4-icon-btn:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: var(--v4-focus-offset, 2px);
  }

  .v4-icon {
    width: 15px;
    height: 15px;
  }

  .v4-notif-btn {
    position: relative;
  }

  /* Plain monochrome unread DOT — no red pill/count (D-04). */
  .v4-notif-dot {
    position: absolute;
    top: 5px;
    right: 5px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ice-ink);
  }

  @media (prefers-reduced-transparency: reduce) {
    .v4-titlebar {
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
      box-shadow: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .v4-titlebar,
    .v4-icon-btn,
    .v4-core-pill {
      transition: none;
    }
  }
</style>

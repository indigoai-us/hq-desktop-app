<script lang="ts">
  import type { SyncState } from "../common/sync-model.js";
  import type { SettingsTab } from "../settings/settings-sections.js";
  import type { PlatformAdapter } from "@hq/platform";
  import { getV4TitleBarModel, type V4HydrationIssue } from "./model.js";
  import {
    TITLEBAR_HEIGHT_PX,
    TITLEBAR_TRAFFIC_LIGHT_GUTTER_PX,
  } from "./titlebar-layout.js";
  import { titlebarDayDate } from "../chat/sidebar-model.js";
  import type { HomeConflict } from "./home-model.js";
  import CorePopover from "./CorePopover.svelte";
  import { corePillDotTone } from "./core-popover-model.js";
  import {
    createLaunchActions,
    type LaunchKey,
  } from "../settings/launch-actions.js";
  import { safeHref } from "../common/markdown.js";
  import { HQ_CONSOLE_BASE } from "../common/hq-console.js";
  import Tooltip from "../common/Tooltip.svelte";
  import Caret from "../common/Caret.svelte";
  import "./tokens.css";
  import "../chat/chat-tokens.css";

  /**
   * Minimal native title bar (visual QA D-04): traffic-light inset, sidebar
   * toggle, HQ wordmark, DAY · DATE, meetings icon, bell with monochrome unread
   * dot, and Core pill. Sync/cloud/version/account live in Core + sidebar footer.
   * Overlay titlebar drag: data-tauri-drag-region on every non-control node
   * plus plugin:window|start_dragging (needs core:window:allow-start-dragging).
   * Do not use -webkit-app-region: drag — WKWebView swallows the click.
   *
   * Extra props (syncState, watchedCount, …) remain accepted so DesktopApp can
   * keep a single wiring surface; they are no longer rendered as V1 chrome.
   */
  interface Props {
    /** Platform seam, forwarded to the Core popover. */
    adapter: PlatformAdapter;
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
    /**
     * Inject the D-08 designed Core-popover fixtures (conflict card / packs /
     * update / core version). Visual-QA only — MUST stay false on real data.
     */
    coreUseFixtures?: boolean;
    /** USER-EDIT drift count from the shell's core-state scan (G7 dot tone). */
    driftCount?: number;
    oncloudtoggle?: (paused: boolean) => void;
    onresolveconflict?: (
      path: string,
      strategy: "keep-local" | "keep-remote",
    ) => void | Promise<void>;
    onopenconflict?: (path: string) => void | Promise<void>;
    onopendrift?: () => void | Promise<void>;
    onopenLibrary?: () => void;
    onopenMarketplace?: () => void;
    /**
     * Host external-URL opener (default browser). Same seam the message-body
     * autolinks use (DesktopApp passes its Tauri plugin-shell opener); when
     * absent we fall back to a noopener `window.open`. The webview MUST NOT
     * navigate — never assign to location for these.
     */
    onopenurl?: (url: string) => void;
  }

  let {
    adapter,
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
    hqFolderPath = null,
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
    coreUseFixtures = false,
    driftCount = 0,
    onresolveconflict,
    onopenconflict,
    onopendrift,
    onopenLibrary,
    onopenMarketplace,
    onopenurl,
  }: Props = $props();

  const dayDateLabel = $derived(titlebarDayDate());

  /**
   * Shared with the native traffic-light offset (see titlebar-layout.ts).
   * The overlay lights are positioned so their centre sits on this bar's
   * content centre — do not move the wordmark/date to meet the lights.
   */
  const titlebarChromeStyle = `--v4-titlebar-height: ${TITLEBAR_HEIGHT_PX}px; --v4-traffic-light-gutter: ${TITLEBAR_TRAFFIC_LIGHT_GUTTER_PX}px;`;

  /**
   * Platform capability seam (not hardcoded): only hosts that draw native
   * window controls (desktop traffic lights / caption buttons) need the
   * left inset that clears them. On web there are no controls, so the wordmark
   * + DAY·DATE sit flush-left.
   */
  const hasWindowControls = $derived(
    adapter?.capabilities?.hasWindowControls ?? false,
  );

  /** Core is the local HQ Core / sync / packs popover. Hide it on web. */
  const showCore = $derived(
    Boolean(
      adapter?.isAvailable("canSync") ||
      adapter?.isAvailable("canSelfUpdate") ||
      adapter?.isAvailable("canManagePackages"),
    ),
  );

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
      if (model.recovery === "hydration") await onretryhydration?.();
      else if (model.action.id === "cancel") await oncancel?.();
      else if (model.action.id === "retry") await onretry?.();
      else if (model.action.id === "resolve") await onresolveconflicts?.();
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
    if (model.recovery === "hydration") {
      return {
        sentence: model.sentence,
        label: hydrationRefreshing || recoveryBusy ? "Retrying…" : "Retry",
        busy: hydrationRefreshing || recoveryBusy,
        copyIssue: null,
      };
    }
    if (syncState === "conflict" && model.action.id === "resolve") {
      return {
        sentence: model.sentence,
        label: recoveryBusy ? "Opening…" : "Resolve conflicts",
        busy: recoveryBusy,
        copyIssue: {
          kind: "sync-conflict" as const,
          payload: { count: conflictCount, company: conflictCompany },
        },
      };
    }
    if (syncState === "error" || syncState === "auth-error") {
      return {
        sentence: model.sentence,
        label: recoveryBusy ? "Working…" : model.action.label,
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

  /**
   * Launch menu (titlebar): opens the user's HQ folder in Claude Code /
   * Codex (ChatGPT) / Grok Build. Reuses the exact SetupChannelIntro
   * cascades via `createLaunchActions`, but with NO prefilled prompt — a
   * plain workspace launch, not the `/setup` onboarding flow.
   *
   * The HQ folder path is lazy-loaded from `settings.getSetupStatus` on
   * first open (same source SetupChannelIntro uses); the `hqFolderPath`
   * prop, when provided by the host, wins and skips the fetch.
   */
  let launchOpen = $state(false);
  let launchContainer: HTMLDivElement | null = $state(null);
  let launchMenuEl: HTMLDivElement | null = $state(null);
  let launchFolder = $state<string | null>(null);
  /** Bottom-start by default; flipped to bottom-end when the menu would
   *  overflow the right viewport edge (measured on open). */
  let launchAlignEnd = $state(false);
  let launching = $state<LaunchKey | null>(null);
  let launchErrors = $state<Partial<Record<LaunchKey, string>>>({});

  const resolvedLaunchFolder = $derived(
    (hqFolderPath ?? launchFolder ?? "").trim(),
  );

  async function ensureLaunchFolder(): Promise<void> {
    if (resolvedLaunchFolder || launchFolder !== null) return;
    try {
      const res = await adapter?.settings?.getSetupStatus?.();
      const status =
        res && res.ok ? (res.value as { hqFolderPath?: string } | null) : null;
      launchFolder = status?.hqFolderPath?.trim() ?? "";
    } catch {
      launchFolder = "";
    }
  }

  function toggleLaunch(): void {
    launchOpen = !launchOpen;
    if (launchOpen) {
      coreOpen = false;
      launchErrors = {};
      void ensureLaunchFolder();
    }
  }

  async function runLaunch(key: LaunchKey): Promise<void> {
    if (launching) return;
    await ensureLaunchFolder();
    if (!resolvedLaunchFolder) {
      launchErrors = {
        ...launchErrors,
        [key]: "HQ folder not configured yet — finish setup first.",
      };
      return;
    }
    launchErrors = { ...launchErrors, [key]: undefined };
    launching = key;
    try {
      // Plain launch: no prompt argument, so Claude's deep link omits `q`
      // and Codex's workspace opens without pre-typed text.
      const actions = createLaunchActions({
        shell: adapter.shell,
        hqFolderPath: resolvedLaunchFolder,
      });
      const error =
        key === "claude"
          ? await actions.launchClaude()
          : key === "codex"
            ? await actions.launchCodex()
            : await actions.launchGrok();
      if (error) {
        launchErrors = { ...launchErrors, [key]: error };
      } else {
        launchOpen = false;
      }
    } finally {
      launching = null;
    }
  }

  /** Viewport clamp: measure once per open; happy-dom rects are 0 so tests
   *  keep the default bottom-start alignment. */
  $effect(() => {
    if (!launchOpen || !launchMenuEl) {
      launchAlignEnd = false;
      return;
    }
    const rect = launchMenuEl.getBoundingClientRect();
    if (rect.width > 0 && rect.right > window.innerWidth - 12) {
      launchAlignEnd = true;
    }
  });

  /** Escape / outside-click close + ArrowUp/ArrowDown item nav (menu a11y). */
  $effect(() => {
    if (!launchOpen) return;

    function onMouseDown(event: MouseEvent) {
      if (!(event.target instanceof Node)) return;
      if (launchContainer && !launchContainer.contains(event.target)) {
        launchOpen = false;
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        launchOpen = false;
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = Array.from(
        launchMenuEl?.querySelectorAll<HTMLButtonElement>(
          "[role='menuitem']:not(:disabled)",
        ) ?? [],
      );
      if (items.length === 0) return;
      event.preventDefault();
      const idx = items.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === "ArrowDown"
          ? items[(idx + 1) % items.length]
          : items[(idx - 1 + items.length) % items.length];
      next?.focus();
    }

    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  });

  /**
   * HQ Console (hq.computer) opens in the DEFAULT BROWSER, never the webview.
   * Routed through the same host opener the message-body autolinks use
   * (75b1bee1): safeHref-guarded, then `onopenurl`, then a noopener
   * `window.open` fallback.
   */
  const HQ_CONSOLE_URL = HQ_CONSOLE_BASE;

  function openHqConsole(): void {
    coreOpen = false;
    launchOpen = false;
    const href = safeHref(HQ_CONSOLE_URL);
    if (!href) return;
    if (onopenurl) onopenurl(href);
    else window.open(href, "_blank", "noopener,noreferrer");
  }

  /**
   * Open the user's CONFIGURED HQ folder in the OS file manager.
   *
   * The renderer passes NO path. `revealInFinder` speaks the HQ-RELATIVE
   * contract (what FilePreviewPane correctly uses for a selected file), and
   * that contract cannot express the HQ ROOT — an absolute `hqFolderPath` is
   * rejected outright, which is what "invalid HQ-relative path" was. The host
   * resolves the configured root itself, so this works for whatever folder
   * THIS user configured, wherever it lives, on any OS. Nothing here is
   * machine-specific and nothing is hardcoded.
   *
   * `hqFolderPath` is still read, but ONLY to decide the button's enabled
   * state and tooltip — never as the reveal argument.
   *
   * Hidden entirely on hosts without local-file support (web), where the
   * platform seam reports the command unavailable.
   */
  const canRevealFolder = $derived(
    Boolean(adapter?.capabilities?.localFiles) ||
      Boolean(adapter?.isAvailable?.("localFiles")),
  );
  let revealing = $state(false);
  let revealError = $state<string | null>(null);

  /**
   * Config presence gates the control. `null` = still loading (allow the
   * click; the handler awaits resolution), `""` = genuinely not configured.
   */
  const hqFolderConfigured = $derived(
    hqFolderPath === null && launchFolder === null
      ? null
      : resolvedLaunchFolder.length > 0,
  );

  /**
   * Resolve the configured HQ folder once on mount so the button shows its
   * true enabled/disabled state immediately, rather than looking available
   * and only failing on click.
   */
  $effect(() => {
    if (canRevealFolder) void ensureLaunchFolder();
  });

  const revealTooltip = $derived(
    revealError ??
      (hqFolderConfigured === false
        ? "HQ folder not configured"
        : "Open HQ folder"),
  );

  async function revealHqFolder(): Promise<void> {
    if (revealing) return;
    coreOpen = false;
    launchOpen = false;
    revealing = true;
    revealError = null;
    try {
      // Resolve config first purely to give a precise disabled/error message;
      // the host does its own authoritative resolution.
      await ensureLaunchFolder();
      if (!resolvedLaunchFolder) {
        revealError = "HQ folder not configured";
        setTimeout(() => (revealError = null), 6000);
        return;
      }
      const res = await adapter.files.revealHqRoot();
      if (!res.ok) throw new Error(res.message ?? "Reveal is unavailable");
    } catch (err) {
      // Surface the REAL reason. A generic string is what hid both the
      // wrong-command-name bug and the wrong-argument-contract bug.
      console.error("titlebar: open HQ folder failed", err);
      const detail = err instanceof Error ? err.message : String(err);
      revealError = `Could not open HQ folder: ${detail}`;
      setTimeout(() => (revealError = null), 6000);
    } finally {
      revealing = false;
    }
  }

  const LAUNCH_ITEMS: ReadonlyArray<{ key: LaunchKey; label: string }> = [
    { key: "claude", label: "Claude Code" },
    { key: "codex", label: "Codex (ChatGPT)" },
    { key: "grok", label: "Grok Build (terminal)" },
  ];

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
    if (coreOpen) launchOpen = false;
  }

  function isDragBlocker(target: EventTarget | null): boolean {
    return (
      target instanceof Element &&
      Boolean(
        target.closest("button, a, input, textarea, select, [data-no-drag]"),
      )
    );
  }

  function startWindowDrag(event: PointerEvent): void {
    if (event.button !== 0 || isDragBlocker(event.target)) return;
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__?: {
          invoke?: (
            cmd: string,
            args?: Record<string, unknown>,
          ) => Promise<unknown>;
          metadata?: { currentWindow?: { label?: string } };
        };
      }
    ).__TAURI_INTERNALS__;
    const label = internals?.metadata?.currentWindow?.label ?? "main";
    void internals?.invoke?.("plugin:window|start_dragging", { label });
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
      if (event.key === "Escape") coreOpen = false;
    }

    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<header
  class="v4-titlebar chat-shell"
  style={titlebarChromeStyle}
  aria-label="Window chrome"
  data-tauri-drag-region
  onpointerdown={startWindowDrag}
>
  <div
    class="v4-titlebar-leading"
    class:no-window-controls={!hasWindowControls}
    data-testid="titlebar-leading"
    data-tauri-drag-region
  >
    {#if hasWindowControls}
      <!-- Padded dead space under the native traffic lights — safe drag only. -->
      <div
        class="v4-drag-pad v4-drag-lights"
        aria-hidden="true"
        data-tauri-drag-region
      ></div>
    {/if}
    <button
      type="button"
      class="v4-icon-btn"
      class:active={!sidebarCollapsed}
      aria-label={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
      title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
      aria-pressed={!sidebarCollapsed}
      onclick={() => ontogglesidebar?.()}
    >
      <svg class="v4-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect
          x="1.75"
          y="2.25"
          width="12.5"
          height="11.5"
          rx="2"
          stroke="currentColor"
          stroke-width="1.2"
        />
        <path d="M5.25 2.5v11" stroke="currentColor" stroke-width="1.2" />
      </svg>
    </button>
    <span
      class="v4-wordmark"
      data-testid="titlebar-wordmark"
      aria-label="HQ"
      data-tauri-drag-region>HQ</span
    >
    <span
      class="v4-day-date"
      data-testid="titlebar-day-date"
      data-tauri-drag-region>{dayDateLabel}</span
    >
  </div>

  <div
    class="v4-drag-pad v4-drag-flex"
    aria-hidden="true"
    data-tauri-drag-region
  ></div>

  <div class="v4-title-actions" data-no-drag data-tauri-drag-region="false">
    <div class="v4-launch-wrap" bind:this={launchContainer}>
      <Tooltip label="Open your HQ folder in an AI tool" align="start">
        {#snippet trigger(describedBy: string)}
          <button
            type="button"
            class="v4-core-pill"
            data-testid="titlebar-launch"
            aria-haspopup="menu"
            aria-expanded={launchOpen}
            aria-label="Open HQ folder in an AI tool"
            aria-describedby={describedBy || undefined}
            onclick={toggleLaunch}
          >
            Launch
            <Caret tone="var(--t3)" />
          </button>
        {/snippet}
      </Tooltip>
      {#if launchOpen}
        <div
          class="v4-launch-menu v4-popover-strong-surface"
          class:align-end={launchAlignEnd}
          role="menu"
          aria-label="Launch HQ folder in"
          data-testid="titlebar-launch-menu"
          bind:this={launchMenuEl}
        >
          {#each LAUNCH_ITEMS as item (item.key)}
            <button
              type="button"
              class="v4-launch-item"
              role="menuitem"
              data-testid={`titlebar-launch-${item.key}`}
              disabled={launching !== null && launching !== item.key}
              onclick={() => void runLaunch(item.key)}
            >
              <span class="v4-launch-item-label">
                {launching === item.key ? `Opening ${item.label}…` : item.label}
              </span>
              {#if launchErrors[item.key]}
                <span
                  class="v4-launch-item-error"
                  data-testid={`titlebar-launch-${item.key}-error`}
                  >{launchErrors[item.key]}</span
                >
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
    {#if canRevealFolder}
      <Tooltip label={revealTooltip}>
        {#snippet trigger(describedBy: string)}
          <button
            type="button"
            class="v4-icon-btn"
            data-testid="titlebar-reveal-folder"
            aria-label="Open HQ folder"
            aria-describedby={describedBy || undefined}
            disabled={revealing || hqFolderConfigured === false}
            onclick={() => void revealHqFolder()}
          >
            <svg
              class="v4-icon"
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M1.75 4.25a1.5 1.5 0 0 1 1.5-1.5h2.6l1.4 1.6h5a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5h-9a1.5 1.5 0 0 1-1.5-1.5v-7.6Z"
                stroke="currentColor"
                stroke-width="1.2"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        {/snippet}
      </Tooltip>
    {/if}
    <Tooltip label="Open HQ Console">
      {#snippet trigger(describedBy: string)}
        <button
          type="button"
          class="v4-icon-btn"
          data-testid="titlebar-console"
          aria-label="Open HQ Console"
          aria-describedby={describedBy || undefined}
          onclick={openHqConsole}
        >
          <svg
            class="v4-icon"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <circle
              cx="8"
              cy="8"
              r="5.75"
              stroke="currentColor"
              stroke-width="1.2"
            />
            <path
              d="M2.5 8h11M8 2.25c1.6 1.7 2.4 3.6 2.4 5.75S9.6 12.05 8 13.75c-1.6-1.7-2.4-3.6-2.4-5.75S6.4 3.95 8 2.25Z"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      {/snippet}
    </Tooltip>
    <Tooltip label="Meetings">
      {#snippet trigger(describedBy: string)}
        <button
          type="button"
          class="v4-icon-btn"
          data-testid="titlebar-meetings"
          aria-label="Meetings"
          aria-describedby={describedBy || undefined}
          onclick={() => {
            coreOpen = false;
            onopenMeetings?.();
          }}
        >
          <svg
            class="v4-icon"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <rect
              x="1.75"
              y="4.25"
              width="8.5"
              height="7.5"
              rx="1.5"
              stroke="currentColor"
              stroke-width="1.2"
            />
            <path
              d="M10.75 6.2 14.25 4.4v7.2l-3.5-1.8V6.2Z"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      {/snippet}
    </Tooltip>
    <Tooltip label={hasUnread ? "Notifications (unread)" : "Notifications"}>
      {#snippet trigger(describedBy: string)}
        <button
          type="button"
          class="v4-icon-btn v4-notif-btn"
          data-testid="titlebar-notifications"
          aria-label={hasUnread ? "Notifications, unread" : "Notifications"}
          aria-describedby={describedBy || undefined}
          onclick={() => {
            coreOpen = false;
            onopenNotifications?.();
          }}
        >
          <svg
            class="v4-icon"
            viewBox="0 0 16 16"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M8 2.25a3.5 3.5 0 0 0-3.5 3.5v2.1l-1.2 1.8h9.4l-1.2-1.8V5.75A3.5 3.5 0 0 0 8 2.25Z"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linejoin="round"
            />
            <path
              d="M6.5 12.25a1.5 1.5 0 0 0 3 0"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
            />
          </svg>
          {#if hasUnread}
            <span
              class="v4-notif-dot"
              data-testid="titlebar-notifications-badge"
              aria-hidden="true"
            ></span>
          {/if}
        </button>
      {/snippet}
    </Tooltip>
    {#if showCore}
      <div class="v4-core-wrap" bind:this={coreContainer}>
        <Tooltip label="HQ Core: sync, packs, and updates" align="end">
          {#snippet trigger(describedBy: string)}
            <button
              type="button"
              class="v4-core-pill"
              data-testid="titlebar-core-pill"
              aria-expanded={coreOpen}
              aria-haspopup="dialog"
              aria-label="Open Core popover"
              aria-describedby={describedBy || undefined}
              onclick={openCore}
            >
              <span
                class="v4-core-dot"
                class:warn={coreDotTone === "warn"}
                data-testid="titlebar-core-dot"
                data-tone={coreDotTone}
                aria-hidden="true">●</span
              >
              Core
              <Caret tone="var(--t3)" />
            </button>
          {/snippet}
        </Tooltip>
        {#if coreOpen}
          <CorePopover
            {adapter}
            appVersion={version}
            {conflicts}
            {cloudPaused}
            useFixtures={coreUseFixtures}
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
    {/if}
  </div>
</header>

<style>
  .v4-titlebar {
    position: relative;
    /* Above .channel-header (20) / .member-pill-wrap (21) so the Core popover
       is never overdrawn by the Chat|Board|Files tab strip. */
    z-index: 30;
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 var(--v4-titlebar-height);
    height: var(--v4-titlebar-height);
    overflow: visible;
    padding: 0 16px 0 0;
    border-bottom: 1px solid var(--line);
    background: transparent;
    font: 400 13px/1.45 var(--font-ui);
    user-select: none;
    -webkit-user-select: none;
    cursor: default;
  }

  .v4-titlebar-leading {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    gap: 8px;
    /* Leading gutter clears the overlay traffic lights (macOS). Shared with
       the native trafficLightPosition inset via `--v4-traffic-light-gutter`
       (titlebar-layout.ts). Hosts without native window controls (web) drop
       it so the wordmark is flush-left — see `.no-window-controls`. */
    padding-left: var(--v4-traffic-light-gutter);
  }

  /* Web / no OS window controls: wordmark + DAY·DATE flush-left. */
  .v4-titlebar-leading.no-window-controls {
    padding-left: 16px;
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

  .v4-launch-wrap {
    position: relative;
    flex: 0 0 auto;
  }

  /* Dropdown anchored bottom-start under the Launch pill (flips to
     bottom-end via .align-end when it would overflow the viewport — measured
     in the open $effect). Surface follows the RecipientPicker/VersionPopout
     convention: --v4-popover-strong is NEAR-OPAQUE, because a nested
     backdrop-filter is neutered outside its parent's backdrop root — a glass
     --pop-bg/--btn-bg here lets the channel toolbar read straight through
     the menu. z-index matches CorePopover so sibling chrome never overdraws
     it. */
  .v4-launch-menu {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    min-width: 220px;
    max-width: calc(100vw - 24px);
    padding: 4px;
    border: 1px solid var(--panel-border, var(--line2));
    border-radius: 10px;
    background: var(--v4-popover-strong, var(--panel-bg, var(--btn-bg)));
    box-shadow: var(--panel-shadow, 0 8px 24px rgba(0, 0, 0, 0.18));
  }

  /* Viewport clamp: right-align to the button when bottom-start overflows. */
  .v4-launch-menu.align-end {
    left: auto;
    right: 0;
  }

  .v4-launch-item {
    appearance: none;
    -webkit-appearance: none;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: 7px 10px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    color: var(--t1);
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
  }

  .v4-launch-item:hover:not(:disabled),
  .v4-launch-item:focus-visible {
    background: var(--hover);
  }

  .v4-launch-item:focus-visible {
    outline: 2px solid var(--v4-focus-ring, var(--v4-control-border));
    outline-offset: -2px;
  }

  .v4-launch-item:disabled {
    color: var(--t3);
    cursor: default;
  }

  .v4-launch-item-error {
    color: var(--warn);
    font-size: 11px;
    line-height: 1.35;
    white-space: normal;
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
  .v4-core-pill[aria-expanded="true"] {
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


  /* Windows uses the native decorated title bar (system controls + Snap
     Layouts). The HQ toolbar sits below it — no macOS traffic-light gutter. */
  :global(html[data-platform="windows"]) .v4-titlebar-leading {
    padding-left: 12px;
  }

  :global(html[data-platform="windows"]) .v4-drag-lights {
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
    transition:
      color 0.12s,
      background 0.12s;
  }

  .v4-icon-btn:hover,
  .v4-icon-btn.active {
    background: var(--hover);
    color: var(--t1);
  }

  /* Pressed global controls stay visibly selected without inheriting the OS
     accent color. aria-pressed remains the semantic source of truth. */
  .v4-icon-btn[aria-pressed="true"] {
    border-color: var(--v4-control-border);
    background: color-mix(in srgb, var(--v4-text-1) 8%, transparent);
    box-shadow: inset 0 0 0 1px var(--v4-hairline);
    color: var(--v4-text-1);
  }

  .v4-icon-btn:disabled {
    color: var(--t3);
    cursor: default;
  }

  .v4-icon-btn:disabled:hover {
    background: transparent;
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

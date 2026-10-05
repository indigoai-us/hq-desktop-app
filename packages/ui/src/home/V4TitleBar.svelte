<script lang="ts">
  import type { SyncState } from "../common/sync-model.js";
  import type { SettingsTab } from "../settings/settings-sections.js";
  import type { PlatformAdapter } from "@hq/platform";
  import { getV4TitleBarModel, type V4HydrationIssue } from "./model.js";
  import RailIcon from "../common/button/RailIcon.svelte";
  import type { BrandIconName } from "../common/button/rail-icons.js";
  import { startWindowDrag } from "./window-drag.js";
  import { titlebarDayDate } from "../chat/sidebar-model.js";
  import type { HomeConflict } from "./home-model.js";
  import CorePopover from "./CorePopover.svelte";
  import { corePillDotTone } from "./core-popover-model.js";
  import {
    createLaunchActions,
    type LaunchKey,
  } from "../settings/launch-actions.js";
  import { displayHqRoot, readRememberedHqRoot, rememberHqRoot } from "./launch-folder.js";
  import type { AiTools } from "../settings/setup-launch.js";
  import Tooltip from "../common/Tooltip.svelte";
  import BrandLogoSlot from "../brand/BrandLogoSlot.svelte";
  import { isEntitledBrand, type CachedBrand } from "../brand/brand.js";
  import Caret from "../common/Caret.svelte";
  import { untrack } from "svelte";
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
  import {
    syncStatusLabel,
    type SyncStatusState,
  } from "./sync-status.js";

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
    /** OWNER-R36: the page has no side pane, so there is nothing to show or hide. */
    sidebarToggleHidden?: boolean;
    onsync?: () => void | Promise<void>;
    oncancel?: () => void | Promise<void>;
    onretry?: () => void | Promise<void>;
    onretryhydration?: () => void | Promise<void>;
    onresolveconflicts?: () => void | Promise<void>;
    ontogglesidebar?: () => void;
    oncommand?: () => void;
    onaccount?: () => void;
    onOpenSettings?: (tab?: SettingsTab) => void;
    onopenNotifications?: () => void;
    primaryAction?: { label: string; onselect: () => void };
    /**
     * White-label brand for the header slot (PL-04). Resolved by the shell
     * from the same membership enrichment the popover reads, so an entitled
     * company shows its logo here and an unentitled one is left alone.
     */
    brand?: CachedBrand | null;
    /** Company name for the tenant logo's alt text. */
    brandCompanyName?: string | null;
    /** Unread count drives monochrome bell dot only (no red pill). */
    unreadCount?: number;
    /**
     * Live sync state, reduced from the runner's events by the shell. Null on
     * platforms with no event bridge, where the chip stays hidden rather than
     * claiming a state it cannot observe.
     */
    syncStatus?: SyncStatusState | null;
    /** Opens wherever sync trouble is resolved. Chip is inert without it. */
    onopenSync?: () => void;
    cloudPaused?: boolean;
    /**
     * Companies whose uploads are paused by a plan limit (hard-stop US-019).
     * Lights the Core pill and replaces "All synced" in the Core popover.
     */
    uploadsPaused?: readonly { company: string; upgradeUrl?: string | null }[] | null;
    conflicts?: HomeConflict[];
    /**
     * Inject the D-08 designed Core-popover fixtures (conflict card / packs /
     * update / core version). Visual-QA only — MUST stay false on real data.
     */
    coreUseFixtures?: boolean;
    /** USER-EDIT drift count from the shell's core-state scan (G7 dot tone). */
    driftCount?: number;
    /**
     * PL-02 — sync trouble the shell reads from `list_syncable_workspaces`.
     * Forwarded to the Core popover, which owns the notice rows.
     */
    manifestError?: string | null;
    cloudReachable?: boolean;
    cloudError?: string | null;
    /** Workspaces, used only to resolve uids in error copy. */
    workspaces?: readonly Record<string, unknown>[] | null;
    oncloudtoggle?: (paused: boolean) => void;
    onresolveconflict?: (
      path: string,
      strategy: "keep-local" | "keep-remote" | "discard",
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
    /** In-app history. Buttons stay visible and disable at stack endpoints. */
    canGoBack?: boolean;
    canGoForward?: boolean;
    backLabel?: string;
    forwardLabel?: string;
    onback?: () => void;
    onforward?: () => void;
    /**
     * Host-held Launch menu (the guided tour's last step). While true the
     * menu stays open: outside clicks, Escape and the pill do not close it.
     * Going false closes a menu this prop opened.
     */
    launchMenuForcedOpen?: boolean;
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
    errorMessage = "",
    errorCompany = null,
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
    sidebarToggleHidden = false,
    ontogglesidebar,
    onopenNotifications,
    primaryAction,
    brand = null,
    brandCompanyName = null,
    unreadCount = 0,
    syncStatus = null,
    onopenSync,
    cloudPaused = false,
    uploadsPaused = null,
    conflicts = [],
    coreUseFixtures = false,
    driftCount = 0,
    manifestError = null,
    cloudReachable = true,
    cloudError = null,
    workspaces = null,
    onresolveconflict,
    onopenconflict,
    onopendrift,
    onopenLibrary,
    onopenMarketplace,
    onopenurl,
    canGoBack = false,
    canGoForward = false,
    backLabel = "",
    forwardLabel = "",
    onback,
    onforward,
    launchMenuForcedOpen = false,
  }: Props = $props();

  // Sentence case in the chrome ("Friday · Oct 2"); the model keeps caps.
  const dayDateLabel = $derived(
    titlebarDayDate()
      .toLowerCase()
      .replace(/(^|· )([a-z])/g, (_m, lead: string, ch: string) => lead + ch.toUpperCase()),
  );

  /**
   * Same gate as the popover's slot: entitlement must be explicitly true AND
   * at least one brand field set. Anything else leaves the HQ wordmark alone.
   */
  const brandEntitled = $derived(
    !!brand && isEntitledBrand(brand.brandingEnabled, brand.brand),
  );
  const backHoverLabel = $derived(
    canGoBack && backLabel.trim() ? backLabel : "Back",
  );
  const forwardHoverLabel = $derived(
    canGoForward && forwardLabel.trim() ? forwardLabel : "Forward",
  );

  /**
   * Platform capability seam (not hardcoded): only hosts that draw native
   * window controls (desktop traffic lights / caption buttons) need the
   * left inset that clears them. On web there are no controls, so the wordmark
   * + DAY·DATE sit flush-left. Height and gutter come from the shared
   * `--titlebar-height` / `--titlebar-leading-inset` tokens so sub-page
   * headers stay on the same centre line as the overlay traffic lights.
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
  const syncLabel = $derived(
    syncStatus ? syncStatusLabel(syncStatus) : null,
  );

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
  /** Null until the open-time tool check returns. Unknown stays launchable. */
  let launchTools = $state<AiTools | null>(null);
  let launchToolsChecked = $state(false);

  const resolvedLaunchFolder = $derived(
    (launchFolder ?? hqFolderPath ?? readRememberedHqRoot() ?? "").trim(),
  );

  const launchFolderLabel = $derived(
    resolvedLaunchFolder ? displayHqRoot(resolvedLaunchFolder) : "not set",
  );

  function toolInstalled(key: LaunchKey, tools: AiTools | null): boolean | null {
    if (!tools) return null;
    if (key === "claude") return Boolean(tools.claude_cli || tools.claude_desktop);
    if (key === "codex") return Boolean(tools.codex_cli || tools.codex_desktop);
    return Boolean(tools.grok_cli);
  }

  async function refreshLaunchTools(): Promise<void> {
    try {
      const res = await adapter?.shell?.detectAiTools?.();
      if (res && res.ok && res.value && typeof res.value === "object") {
        launchTools = res.value as unknown as AiTools;
      }
    } catch {
      /* keep the previous snapshot; the row stays launchable */
    } finally {
      launchToolsChecked = true;
    }
  }

  async function ensureLaunchFolder(): Promise<void> {
    const remembered = readRememberedHqRoot();
    if (!hqFolderPath && remembered && launchFolder === null) {
      launchFolder = remembered;
    }
    if (resolvedLaunchFolder || launchFolder !== null) {
      if (resolvedLaunchFolder) rememberHqRoot(resolvedLaunchFolder);
      return;
    }
    try {
      const res = await adapter?.settings?.getSetupStatus?.();
      const status =
        res && res.ok ? (res.value as { hqFolderPath?: string } | null) : null;
      launchFolder = status?.hqFolderPath?.trim() ?? "";
      if (launchFolder) rememberHqRoot(launchFolder);
    } catch {
      launchFolder = "";
    }
  }

  async function changeLaunchFolder(): Promise<void> {
    const pick = adapter?.shell?.pickFolder;
    if (!pick) return;
    const res = await pick();
    if (!res.ok || !res.value) return;
    const next = res.value.trim();
    if (!next) return;
    launchFolder = next;
    rememberHqRoot(next);
  }

  /** The host is holding the menu open (see `launchMenuForcedOpen`). */
  let launchHeldByHost = false;
  $effect(() => {
    if (launchMenuForcedOpen) {
      launchHeldByHost = true;
      launchOpen = true;
      coreOpen = false;
      launchErrors = {};
      untrack(() => void ensureLaunchFolder());
    } else if (launchHeldByHost) {
      launchHeldByHost = false;
      launchOpen = false;
    }
  });

  function toggleLaunch(): void {
    if (launchMenuForcedOpen) return;
    launchOpen = !launchOpen;
    if (launchOpen) {
      coreOpen = false;
      launchErrors = {};
      void ensureLaunchFolder();
      void refreshLaunchTools();
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
      if (launchMenuForcedOpen) return;
      // The guided tour's card sits outside the wrapper; its buttons must not
      // close the menu it is pointing at.
      if (event.target instanceof Element && event.target.closest("[data-hq-tour]")) return;
      if (launchContainer && !launchContainer.contains(event.target)) {
        launchOpen = false;
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (!launchMenuForcedOpen) launchOpen = false;
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
  const LAUNCH_ITEMS: ReadonlyArray<{
    key: LaunchKey;
    label: string;
    mark: BrandIconName;
    hint: string;
  }> = [
    { key: "claude", label: "Claude Code", mark: "claude-code", hint: "Opens in the HQ folder" },
    { key: "codex", label: "Codex", mark: "codex", hint: "Opens in the HQ folder" },
    { key: "grok", label: "Grok Build", mark: "grok", hint: "Needs grok on PATH" },
  ];

  /**
   * Live caption for the Core popover header while a run is in flight. The
   * title bar already reduces the run (`syncStatusLabel`); the popover reuses
   * that sentence rather than counting files a second time.
   */
  const syncCaptionText = $derived(
    syncLabel?.tone === "busy"
      ? [syncLabel.detail, syncLabel.text].filter(Boolean).join(" · ")
      : null,
  );

  /** Message behind an `error` phase — the reduced run carries it. */
  const syncErrorMessage = $derived(
    syncStatus?.phase === "error"
      ? (syncStatus.message ?? errorMessage ?? null)
      : (errorMessage ?? null),
  );

  /**
   * Phase the Core popover header speaks about.
   *
   * `syncState` is reduced from the on-disk journal, which only ever reports
   * `idle` or `conflict`. The event-stream reducer (`syncStatus`) is the only
   * source that sees a run start or a run fail, so a non-idle phase there
   * wins — otherwise a failing sync would read "All synced".
   */
  const coreSyncPhase = $derived(
    syncStatus && syncStatus.phase !== "idle" ? syncStatus.phase : syncState,
  );

  /** G7: amber dot while a conflict/attention item is pending; green when
   *  healthy; a quiet blue while a run is in flight (PL-01). */
  const coreDotTone = $derived(
    corePillDotTone({
      conflictCount: Math.max(conflictCount, conflicts.length),
      syncState: coreSyncPhase,
      manifestError,
      cloudReachable,
      driftCount,
      cloudPaused,
      uploadsPausedCount: uploadsPaused?.length ?? 0,
    }),
  );

  function openCore(): void {
    coreOpen = !coreOpen;
    if (coreOpen) launchOpen = false;
  }

  $effect(() => {
    const openFromBanner = () => {
      coreOpen = true;
      launchOpen = false;
    };
    window.addEventListener("hq-open-core", openFromBanner);
    return () => window.removeEventListener("hq-open-core", openFromBanner);
  });

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
  class:has-window-controls={hasWindowControls}
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
    {#if !sidebarToggleHidden}
    <button
      type="button"
      class="v4-icon-btn"
      class:active={!sidebarCollapsed}
      data-testid="titlebar-sidebar-toggle"
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
    {/if}
    {#if brandEntitled}
      <!-- White-label header slot (PL-04): the tenant logo replaces the HQ
           wordmark, with the permanent powered-by lockup underneath. Gated on
           the same `isEntitledBrand` check the popover uses, so an unentitled
           company keeps the wordmark chrome exactly as it was. -->
      <div
        class="v4-brand-slot"
        data-testid="titlebar-brand-slot"
        data-tauri-drag-region
      >
        <BrandLogoSlot
          {brand}
          brandingEnabled={true}
          companyName={brandCompanyName}
          size="desktop"
        />
      </div>
    {:else}
      <span
        class="v4-wordmark"
        data-testid="titlebar-wordmark"
        aria-label="HQ"
        data-tauri-drag-region>HQ</span
      >
    {/if}
    <span
      class="v4-day-date"
      data-testid="titlebar-day-date"
      data-tauri-drag-region>{dayDateLabel}</span
    >
    <div
      class="v4-history"
      data-testid="titlebar-history"
      data-no-drag
      data-tauri-drag-region="false"
    >
      <Tooltip label={backHoverLabel} align="start">
        {#snippet trigger(describedBy: string)}
          <button
            type="button"
            class="v4-icon-btn"
            data-testid="titlebar-back"
            aria-label="Back"
            title={backHoverLabel}
            aria-describedby={describedBy || undefined}
            disabled={!canGoBack}
            onclick={() => onback?.()}
          >
            <svg class="v4-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M10 3.5 5.5 8 10 12.5"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        {/snippet}
      </Tooltip>
      <Tooltip label={forwardHoverLabel} align="start">
        {#snippet trigger(describedBy: string)}
          <button
            type="button"
            class="v4-icon-btn"
            data-testid="titlebar-forward"
            aria-label="Forward"
            title={forwardHoverLabel}
            aria-describedby={describedBy || undefined}
            disabled={!canGoForward}
            onclick={() => onforward?.()}
          >
            <svg class="v4-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M6 3.5 10.5 8 6 12.5"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        {/snippet}
      </Tooltip>
    </div>
  </div>

  <div
    class="v4-drag-pad v4-drag-flex"
    aria-hidden="true"
    data-tauri-drag-region
  ></div>

  <div class="v4-title-actions" data-no-drag data-tauri-drag-region="false">
    {#if primaryAction}
      <button type="button" class="v4-core-pill" data-testid="titlebar-primary-action" onclick={primaryAction.onselect}>
        <svg class="v4-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.3" />
        </svg>
        {primaryAction.label}
      </button>
    {/if}
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
          <div class="v4-launch-sec">
            Launch
            <span class="v4-launch-sec-path" data-testid="titlebar-launch-root">{launchFolderLabel}</span>
          </div>
          {#each LAUNCH_ITEMS as item (item.key)}
            {@const installed = toolInstalled(item.key, launchTools)}
            {#if launchToolsChecked && installed === false}
              <div
                class="v4-launch-item v4-launch-missing"
                data-testid={`titlebar-launch-${item.key}`}
              >
                <span class="v4-launch-mark off" data-launch-mark={item.mark}><RailIcon name={item.mark} /></span>
                <span class="v4-launch-copy">
                  <span class="v4-launch-item-label">
                    {item.label}
                    <span class="v4-launch-dim" data-testid={`titlebar-launch-${item.key}-missing`}>Not installed</span>
                  </span>
                  <small>{item.hint}</small>
                </span>
                <button
                  type="button"
                  class="v4-launch-install"
                  data-testid={`titlebar-launch-${item.key}-install`}
                  onclick={() => void refreshLaunchTools()}
                ><RailIcon name="download" />Install</button>
              </div>
            {:else}
              <button
                type="button"
                class="v4-launch-item"
                role="menuitem"
                data-testid={`titlebar-launch-${item.key}`}
                disabled={launching !== null && launching !== item.key}
                onclick={() => void runLaunch(item.key)}
              >
                <span class="v4-launch-mark" data-launch-mark={item.mark}><RailIcon name={item.mark} /></span>
                <span class="v4-launch-copy">
                  <span class="v4-launch-item-label">
                    {launching === item.key ? `Opening ${item.label}…` : item.label}
                  </span>
                  <small>{item.hint}</small>
                  {#if launchErrors[item.key]}
                    <span
                      class="v4-launch-item-error"
                      data-testid={`titlebar-launch-${item.key}-error`}
                      >{launchErrors[item.key]}</span
                    >
                  {/if}
                </span>
              </button>
            {/if}
          {/each}
          {#if launchToolsChecked}
            <div class="v4-launch-foot">
              <span>Installed tools are checked on open.</span>
              <button type="button" class="v4-launch-change" data-testid="titlebar-launch-recheck" data-rail-btn onclick={() => void refreshLaunchTools()}><RailIcon name="refresh" size={14} />Check again</button>
            </div>
          {/if}
          <div class="v4-launch-foot">
            <span>Folder</span>
            <code data-testid="titlebar-launch-folder">{launchFolderLabel}</code>
            <button type="button" class="v4-launch-change" data-testid="titlebar-launch-change" data-rail-btn onclick={() => void changeLaunchFolder()}><RailIcon name="pencil" size={14} />Change…</button>
          </div>
        </div>
      {/if}
    </div>
    {#if syncLabel?.text}
      <Tooltip label={syncLabel.detail}>
        {#snippet trigger(describedBy: string)}
          <button
            type="button"
            class="v4-sync-chip"
            class:attention={syncLabel.tone === "attention"}
            data-testid="titlebar-sync-status"
            data-tone={syncLabel.tone}
            aria-label={syncLabel.detail}
            aria-describedby={describedBy || undefined}
            aria-live="polite"
            disabled={!onopenSync}
            onclick={() => {
              coreOpen = false;
              onopenSync?.();
            }}
          >
            {#if syncLabel.tone === "busy"}
              <span class="v4-sync-spinner" aria-hidden="true"></span>
            {/if}
            <span class="v4-sync-text">{syncLabel.text}</span>
          </button>
        {/snippet}
      </Tooltip>
    {/if}
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
                class:active={coreDotTone === "active"}
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
            {uploadsPaused}
            {onopenurl}
            syncState={coreSyncPhase}
            {lastSyncLabel}
            syncCaption={syncCaptionText}
            conflictCount={Math.max(conflictCount, conflicts.length)}
            {conflictCompany}
            errorMessage={syncErrorMessage}
            errorCompany={errorCompany ?? null}
            {manifestError}
            {cloudReachable}
            {cloudError}
            {workspaces}
            {hqFolderPath}
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
    flex: 0 0 var(--titlebar-height, 48px);
    height: var(--titlebar-height, 48px);
    overflow: visible;
    padding: 0 16px 0 0;
    border-bottom: 1px solid var(--line);
    background: transparent;
    font: 400 13px/1.45 var(--font-ui);
    user-select: none;
    -webkit-user-select: none;
    cursor: default;
  }

  .v4-brand-slot {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    min-width: 0;
    margin-right: 2px;
  }

  .v4-titlebar-leading {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    flex-wrap: nowrap;
    gap: 8px;
    /* Leading gutter clears overlay traffic lights (macOS). Shared with
       sub-page headers via `--titlebar-leading-inset` (titlebar-layout.ts).
       Hosts without native window controls (web) drop it so the wordmark is
       flush-left — see `.no-window-controls`. */
    padding-left: var(--titlebar-leading-inset);
  }

  /* Web / no OS window controls: wordmark + DAY·DATE flush-left. */
  .v4-titlebar-leading.no-window-controls {
    --titlebar-leading-inset: 16px;
    padding-left: var(--titlebar-leading-inset);
  }

  .v4-wordmark {
    flex: 0 0 auto;
    color: var(--t1);
    font-size: 13px;
    font-weight: 500;
    line-height: 1;
  }

  .v4-day-date {
    flex: 0 0 auto;
    color: var(--t3);
    font-size: 13px;
    font-weight: 400;
    line-height: 1;
    white-space: nowrap;
  }

  .v4-history {
    display: flex;
    align-items: center;
    flex: 0 0 auto;
    flex-shrink: 0;
    gap: 2px;
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
    width: 340px;
    max-width: calc(100vw - 24px);
    padding: 8px;
    border: 1px solid var(--overlay-border);
    border-radius: var(--v4-radius-popover, 10px);
    background: var(--overlay-bg);
    box-shadow: var(--overlay-shadow);
  }

  .v4-launch-sec {
    display: flex;
    padding: 4px 8px 6px;
    font-size: 13px;
    font-weight: 500;
    color: var(--v4-text-2, var(--t2));
  }

  .v4-launch-sec-path {
    margin-left: auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
    font-weight: 400;
    color: var(--v4-text-3, var(--t3));
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
    align-items: flex-start;
    gap: 10px;
    padding: 8px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--v4-text-1, var(--t1));
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }

  .v4-launch-missing { cursor: default; }
  .v4-launch-missing:hover { background: transparent; }

  .v4-launch-mark {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    background: var(--v4-control-bg, var(--btn-bg));
    display: grid;
    place-items: center;
    font-size: 11px;
    font-weight: 500;
    flex: none;
    margin-top: 1px;
  }

  .v4-launch-mark.off { opacity: 0.45; }

  .v4-launch-copy { flex: 1; min-width: 0; display: flex; flex-direction: column; }

  .v4-launch-copy small {
    display: block;
    font-size: 13px;
    color: var(--v4-text-3, var(--t3));
    margin-top: 2px;
  }

  .v4-launch-dim {
    color: var(--v4-text-3, var(--t3));
    font-weight: 400;
    font-size: 13px;
    margin-left: 6px;
  }

  .v4-launch-install {
    flex: none;
    appearance: none;
    border: 1px solid var(--v4-control-border, var(--line2));
    background: var(--v4-control-bg, transparent);
    color: var(--v4-text-1, var(--t1));
    border-radius: 6px;
    padding: 2px 8px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .v4-launch-foot {
    margin: 6px 0 0;
    padding: 8px 8px 2px;
    border-top: 1px solid var(--v4-rowline, var(--line2));
    font-size: 13px;
    color: var(--v4-text-3, var(--t3));
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .v4-launch-foot code {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 12px;
    color: var(--v4-text-2, var(--t2));
  }

  /* Compact labelled button (design standard §4): icon + label, 28px in the
     dense menu footer, 12px/500, 6px gap, 8px radius. */
  .v4-launch-change {
    margin-left: auto;
    appearance: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    box-sizing: border-box;
    height: 28px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    padding: 0 12px;
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    color: var(--v4-text-2, var(--t2));
    cursor: pointer;
    white-space: nowrap;
  }
  .v4-launch-change:hover { color: var(--v4-text-1, var(--t1)); }

  .v4-launch-item:hover:not(:disabled),
  .v4-launch-item:focus-visible {
    background: var(--v4-hover, var(--hover));
  }

  .v4-launch-item.v4-launch-missing:hover {
    background: transparent;
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
    font-size: 13px;
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
    font-size: 13px;
    font-weight: 400;
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
  .v4-core-dot.active {
    color: var(--ice-ink);
  }

  .v4-core-dot.warn {
    color: var(--warn);
  }


  /* Windows uses the native decorated title bar (system controls + Snap
     Layouts). `--titlebar-leading-inset` is 12px via tokens.css; hide the
     macOS traffic-light drag pad. */
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

  .v4-sync-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 22px;
    padding: 0 8px;
    margin-right: 2px;
    border: 1px solid var(--line);
    border-radius: 999px;
    background: transparent;
    color: var(--t2);
    font: inherit;
    font-size: 13px;
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
    /* No backdrop-filter: this sits on always-on chrome over the native glass,
       and a second blur here is a per-frame repaint of the whole title bar.
       Enforced by the always-on-chrome guard in the perf budget contract. */
  }

  .v4-sync-chip:disabled {
    cursor: default;
  }

  .v4-sync-chip:hover:not(:disabled) {
    color: var(--t1);
  }

  .v4-sync-chip.attention {
    color: var(--t1);
    border-color: var(--t2);
  }

  .v4-sync-text {
    font-variant-numeric: tabular-nums;
  }

  .v4-sync-spinner {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    border: 1.5px solid currentColor;
    border-top-color: transparent;
    /* transform-only, so it composites instead of repainting the title bar. */
    animation: v4-sync-spin 700ms linear infinite;
  }

  @keyframes v4-sync-spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .v4-sync-spinner {
      animation: none;
      /* Still reads as "in progress" without motion. */
      border-top-color: currentColor;
      opacity: 0.5;
    }
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

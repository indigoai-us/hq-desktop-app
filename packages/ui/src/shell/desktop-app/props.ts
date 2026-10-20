/**
 * DesktopApp's prop contract. Lives outside the component so the shell's
 * type surface can be read and checked without the 14k-line script.
 */
import type { Component } from "svelte";
import type { PlatformAdapter } from "@hq/platform";
import type {
  ChatSidebarApi,
  ChatWakeBus,
  ConversationMessageWire,
  NotificationsApi,
  ProjectMemberAddResult,
  ReplyThreadScope,
} from "../../chat/chat-api.js";
import type { ReactionMap } from "../../chat/messaging/reactions.js";
import type {
  BoardTabData,
  ChannelFileItemModel,
  ChannelFilePreview,
} from "../../chat/messaging/channelTabModels.js";
import type { PutChatAttachment } from "../../chat/messaging/upload-chat-attachments.js";
import type { ConversationRow } from "../../chat/sidebar-model.js";
import type { LifecycleCardActionEvent } from "../../chat/messaging/channelMessageModels.js";
import type { Workspace } from "../../chat/workspaces.js";
import type { LocalOnlyCompany } from "../../company/company-display-map.js";
import type { SyncEventHost } from "../sync-events.js";
import type { RosterStatus } from "../../identity/roster-refresh.js";
import type { SelfIdentity } from "../../identity/self.js";
import type { ChannelDirectoryRow } from "../../chat/channel-directory-reconciler.js";
import type { ShellSettingsProfile } from "../../settings/ShellSettings.svelte";
import type { ChannelStatusModel } from "../../chat/channel-status-model.js";
import type { MentionTarget } from "../../chat/mentions.js";
import type { PackagesEvents } from "../../library/packages-events.js";
import type { OfficeCallsHost } from "../../meet/office-host.js";
import type { SetupRunApi } from "../../chat/setup-run.js";
import type { NavigationScrollState } from "../navigation-history.js";
import type { RowExtrasResolver } from "../../chat/row-extras.js";

export interface DesktopAppProps {
  /** Platform seam — forwarded to the title-bar Core popover. */
  adapter: PlatformAdapter;
  /** App version, shown in the Core popover. */
  version?: string;
  sidebarApi: ChatSidebarApi;
  notificationsApi: NotificationsApi;
  /**
   * Resolve the (injected) timeline for a row, oldest → newest. Synchronous —
   * the display layer never fetches. Defaults to an empty timeline.
   */
  messagesByRow?: (row: ConversationRow) => ConversationMessageWire[];
  /** Resolve the (injected) reaction aggregates for a row. */
  reactionsByRow?: (row: ConversationRow) => ReactionMap;
  /** Persist a fetched/toggled reaction map into the host cache. */
  onreactionscache?: (row: ConversationRow, reactions: ReactionMap) => void;
  /** Resolve the (injected) Board fixture for a row (columns + stories). */
  boardByRow?: (row: ConversationRow) => BoardTabData | null;
  /** Add an active company member to a project row through the host API. */
  addProjectMember?: (row: ConversationRow, personUid: string) => Promise<ProjectMemberAddResult>;
  /** Resolve the (injected) Files fixture rows for a row. */
  filesByRow?: (row: ConversationRow) => ChannelFileItemModel[];
  loadFilePreview?: (item: ChannelFileItemModel) => Promise<ChannelFilePreview>;
  /** Platform seam for opening an external URL (run-card preview/diff). */
  onopenurl?: (url: string) => void;
  /**
   * Host-owned notification rows (paused uploads) open through the host, so
   * it can record the engagement and open only an approved link.
   */
  onopenhostnotification?: (id: string, url: string) => void;
  /** Bubbled lifecycle-card action (host posts in US-009). */
  oncardaction?: (event: LifecycleCardActionEvent) => void;
  /** Wake events (host bridges MeshClient → bus); null when offline. */
  wakes?: ChatWakeBus | null;
  /** Workspace memberships → sidebar company scopes. */
  companies?: Workspace[] | null;
  /**
   * Company folders on this Mac with no cloud id. Listed in the company
   * switcher only; they cannot be opened until they sync.
   */
  localCompanies?: readonly LocalOnlyCompany[];
  /**
   * A company's home channel was just created/adopted client-side
   * (`ensureCompanyHomeChannel`, from a Companies-row click) and the
   * `companies` roster prop hasn't caught up yet. The host should patch
   * its own roster copy and kick a background refresh so the persisted
   * value matches; the shell already applies the id locally (see
   * `resolvedHomeChannelIds`) so chrome is correct immediately either way.
   */
  onhomechannelresolved?: (companyUid: string, homeChannelId: string) => void;
  /**
   * App-level event subscription (Tauri `listen`, or a web bridge), used to
   * observe sync outcomes the command result cannot report — see
   * `syncMembership`. Omitted on platforms without an event bus; the
   * membership banner degrades to reporting dispatch errors only.
   */
  syncEvents?: SyncEventHost | null;
  /**
   * Where the host is in loading `companies` for this session. #setup
   * hides the seeded "Create a company" card and the create hero copy
   * until the roster has loaded once (`ready` | `failed`). Omitted = ready.
   */
  rosterStatus?: RosterStatus | null;
  /** Re-run the host's roster fetch after `rosterStatus === "failed"`. */
  onretryroster?: () => void;
  /**
   * Re-read `companies` now, without touching `rosterStatus`. Called when a
   * channel names a company the roster does not have yet (the setup bot
   * created it); resolves once the host has applied the fresh roster.
   */
  onrefreshroster?: () => Promise<unknown>;
  /**
   * Start reauthentication from the session-expired banner (PL-03). The
   * desktop host clears the dead session and lands the user on its sign-in
   * surface. Omitted → the banner states the problem without an action.
   */
  onsignin?: () => void | Promise<void>;
  /**
   * Verified signed-in principal (host-supplied: web = Cognito session,
   * desktop = its auth source). Drives "you" tagging + admin gating in the
   * shared UI. Null on the unauth / empty path.
   */
  self?: SelfIdentity | null;
  /** Native account partition for renderer persistence and async guards. */
  tenantAccountId?: string | null;
  /** Monotonic native auth-session generation. A new value remounts the host. */
  tenantGeneration?: number;
  /**
   * Optional explicit admin/owner flag from a defensive host probe
   * (`identity.isAdmin()`). When omitted, admin is derived from membership
   * roles; unknown ⇒ not-admin (admin affordances hidden).
   */
  isAdmin?: boolean | null;
  accountLabel?: string | null;
  accountInitials?: string | null;
  /** Seed the titlebar bell before NotificationsView mounts. */
  initialUnreadCount?: number;
  /** Pre-selected conversation so the default view renders a live channel. */
  initialRow?: ConversationRow | null;
  /**
   * Optional `?reply=<rootEventId>` target. Web passes this from the
   * conversation URL; desktop honors the same query on its deep-link.
   */
  initialReplyRootEventId?: string | null;
  /**
   * Host-owned directory (local mesh overlay). Forwarded to the sidebar so
   * the rail paints before the async directory reconciler settles.
   */
  seedDirectory?: ChannelDirectoryRow[] | null;
  /**
   * Rows the ⌘K / sidebar-search overlay typeaheads over (channels + people).
   * Injected from the host overlay — the display layer never fetches.
   */
  searchRows?: ConversationRow[];
  /**
   * Signed-in profile for the Settings destination. Null/omitted paints
   * the "No data" profile pane — never a fixture person.
   */
  settingsProfile?: ShellSettingsProfile | null;
  /**
   * Resolve the (injected) channel status/members model for a row — powers the
   * member-pill popover. Synchronous; null when the row has no status fixture.
   */
  channelStatusByRow?: (row: ConversationRow) => ChannelStatusModel | null;
  /** person/agent uid → display name used to join the channel creator roster. */
  identities?: Readonly<Record<string, string>> | null;
  /** Contacts + agents for @ mention completion. */
  mentionCandidates?: MentionTarget[];
  /**
   * Inject the D-08 designed fixtures into the titlebar Core popover (packs /
   * update). MUST stay false on real-data paths.
   */
  coreFixtures?: boolean;
  /**
   * Keep the sidebar's legacy Companies block. Off in the console-rail
   * shell, where companies live on the rail only; the company-home heal
   * tests still drive that block.
   */
  sidebarCompanies?: boolean;
  onsignout?: () => Promise<void> | void;
  onOpenSettings?: () => void;
  /** Open HQ Console externally (Settings → Manage account). */
  onOpenConsole?: (url: string) => Promise<void> | void;
  /**
   * Called once the mounted app can receive embedded host navigation.
   * A returned cleanup detaches the host while lifecycle changes unmount it.
   */
  onembeddednavigationready?: () => void | (() => void);
  /** Optional desktop package-operation stream for Library → Installed. */
  packagesEvents?: PackagesEvents | null;
  /** Native app/Core/CLI update event edge for Settings → Updates. */
  updateWakeSeq?: number;
  /** Read the current native app version during an Updates refresh. */
  refreshAppVersion?: () => Promise<string>;
  /** Live interface version when a UI hot update is serving. */
  uiVersion?: string | null;
  /** MeshClient notification wakes — bumps NotificationsView to re-fetch REST. */
  notificationWakeSeq?: number;
  /** Host owns native active-thread registration for realtime reply wakes. */
  onactivethreadchange?: (
    active:
      | {
          rootEventId: string;
          scope: ReplyThreadScope;
          channelId?: string | null;
          withPersonUid?: string | null;
          seenReplyIds: string[];
        }
      | null,
  ) => void;
  /** The persisted post-ready marker used by the desktop telemetry path. */
  readyFirstActionReady?: boolean;
  /**
   * When true, messagesByRow is first-paint only — the shell still fetches
   * REST for the selected row so mentions, member-added lines, and the
   * latest timeline land even when the machine cache is stale.
   */
  hydrateLiveMessages?: boolean;
  /** Persist the REST timeline into the host's shallow cache. */
  onlivemessages?: (
    row: ConversationRow,
    messages: ConversationMessageWire[],
  ) => void;
  /** Persist the conversation the user just opened (fresh-load restore). */
  onselectrow?: (row: ConversationRow) => void;
  /**
   * QA-075: the company whose pane is open (a company or project channel),
   * or null on personal pages and every non-conversation view. Hosts use it
   * to scope per-company notices to that company's pane.
   */
  onactivecompanychange?: (company: { uid: string | null; slug: string } | null) => void;
  /** Desktop: PUT attachment bytes outside the webview (no S3 CORS). */
  putAttachmentObject?: PutChatAttachment;
  /**
   * Host-owned bounded byte transport for presigned Vault GETs. Desktop
   * supplies a native hop. Web uses the Work app's same-origin proxy because
   * Vault buckets do not grant browser CORS to raw presigned URLs.
   */
  getAttachmentObject?: (url: string, maxBytes?: number) => Promise<Response>;
  /**
   * Bound for first-paint optional fetches (directory, contacts, DM
   * threads). Tests pass a short value so a hung/404 call cannot leave the
   * conversation pane on its loader.
   */
  bootTimeoutMs?: number;
  /** First successful conversation/empty paint — host reports `shell_ready`. */
  onShellReady?: () => void;
  /**
   * US-018 native calling seams. Supplied by a desktop host; absent on the
   * web. The Office tab is gated on `adapter.capabilities.nativeCalls`, and
   * the panel refuses in its own voice when this is missing.
   */
  callsHost?: OfficeCallsHost | null;
  /** Host-registered full-column destinations keyed by page id. */
  extraPages?: Record<
    string,
    {
      label: string;
      detail?: string;
      /** Optional host-owned create action in the window header. */
      createAction?: { label: string; param: () => string | null };
      /**
       * Optional host-owned "Run Setup" destination for #welcome: a fresh
       * session whose param carries the setup prompt so the page can send
       * it as soon as the provider is ready. Falls back to `createAction`.
       */
      setupAction?: { label: string; param: () => string | null };
      /**
       * Optional host guided-run API. When present, #welcome's Run Setup
       * runs `/setup` natively inside the hero (stepper + question cards)
       * and only falls back to `setupAction` when the host's preflight says
       * the Sessions page must go first. "Show details" opens the session
       * on this page with its id as the param.
       */
      setupRun?: SetupRunApi;
      /** After setup: a fresh session with `/startwork <company>` as its first turn. */
      startworkAction?: { label: string; param: (company: string | null) => string | null };
      component: Component<{
        param?: string | null;
        restoreScroll?: NavigationScrollState | null;
        onnavigate?: (
          param: string | null,
          options?: { mode?: "push" | "replace" },
        ) => void;
      }>;
    }
  >;
  /** Host decoration for sidebar rows: badge, hover card, and actions. */
  rowExtrasLoading?: boolean;
  rowExtrasError?: boolean;
  rowExtras?: RowExtrasResolver | null;
  /**
   * US-005 wiring for the guided install path in #setup. When the setup
   * bot fails to start because no coding tool is signed in, the hero shows
   * `SetupInstallGuide` instead of a dead-end. The host provides real
   * callbacks that drive the Rust install / sign-in / detect commands
   * (see `apps/sync/src/desktop-alt/lib/install-guide-adapter.ts`).
   * Omitted callers keep today's behavior: error message only, no guide.
   */
  setupInstallGuide?: {
    oninstall(tool: "claude" | "codex"): Promise<{ ok: boolean; reason?: string }>;
    onsignin(
      tool: "claude" | "codex",
      options?: { signal?: AbortSignal },
    ): Promise<{ ok: boolean; reason?: string }>;
    /** Is this tool already signed in? Lets the guide skip to Continue. */
    onstatus?(tool: "claude" | "codex"): Promise<boolean>;
    /** Stop a pending sign-in so the guide can open a fresh one. */
    oncancelsignin?(tool: "claude" | "codex"): Promise<void>;
    onrefresh(): Promise<void>;
    downloadUrlFor(tool: "claude" | "codex"): string;
    onopen(url: string): Promise<{ ok: boolean; reason?: string }> | void;
    /**
     * Open one of the assistant desktop apps with a fixed install prompt
     * pre-filled. Wired to `open_claude_code_link` /
     * `open_codex_deep_link` via the install-guide adapter. When present,
     * the shared InstallChoice panel offers a "Set up with Claude" or
     * "Set up with ChatGPT" button on both the New bot wizard and the
     * setup assistant.
     */
    onopenassistant?(
      assistant: "claude-desktop" | "chatgpt-desktop",
      url: string,
    ): Promise<{ ok: boolean; reason?: string }>;
  } | null;
  /**
   * Live AiTools payload. Passed through the New-bot wizard so the
   * shared InstallChoice panel can decide which assistant buttons to
   * offer without a per-open probe. Null while the initial probe runs.
   */
  aiTools?: import("../../install-choice/install-choice.js").AiTools | null;
  /** Open the assistant desktop app with a pre-filled install prompt. */
  onopenassistant?: (
    assistant: import("../../install-choice/install-choice.js").AssistantId,
    url: string,
  ) => Promise<import("../../install-choice/install-choice.js").InstallOutcome>;
  /** HQ's own one-click installer for a coding tool. */
  onassistedinstall?: (
    tool: import("../../install-choice/install-choice.js").CodingTool,
  ) => Promise<import("../../install-choice/install-choice.js").InstallOutcome>;
  /**
   * Ask the host to (re-)probe `detect_ai_tools`. Called lazily by the
   * New bot wizard on mount so the probe is not paid on every app open.
   */
  onrequestaitools?: () => void;
}

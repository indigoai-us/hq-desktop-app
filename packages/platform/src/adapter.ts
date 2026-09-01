/**
 * PlatformAdapter — the single typed seam between shared app code and the host
 * it runs in (web browser talking to hq-pro REST, or desktop via Tauri invoke).
 *
 * Result contract
 * ---------------
 * Every adapter method resolves to an `AdapterResult<T>` discriminated union:
 *
 *   { ok: true, value: T }
 *   { ok: false, reason: "unavailable", code?: string, message?: string }
 *   { ok: false, reason: "error", code?: string, message?: string }
 *
 * - `reason: "unavailable"` means the capability is not offered on this
 *   platform (or its backing API does not exist yet). UI renders the standard
 *   degraded state and never crashes. `code` may carry a finer-grained hint
 *   such as "desktop-only" or "not-yet-implemented-api", but UI only needs
 *   the `reason` discriminant.
 * - `reason: "error"` means the capability exists but the call failed
 *   (network, backend, invoke error). `message` is human-readable.
 *
 * Methods never throw for platform divergence; they reject only on programmer
 * error (bad arguments).
 */

import type { Capabilities, Capability } from "./capabilities.js";

export type AdapterResult<T> = { ok: true; value: T } | AdapterFailure;

export interface AdapterFailure {
  ok: false;
  reason: "unavailable" | "error";
  /** Machine hint, e.g. "desktop-only", "not-yet-implemented-api", "http-500". */
  code?: string;
  /** Human-readable detail, safe to surface in dev tooling. */
  message?: string;
}

export function ok<T>(value: T): AdapterResult<T> {
  return { ok: true, value };
}

export function unavailable(code?: string, message?: string): AdapterFailure {
  return { ok: false, reason: "unavailable", code, message };
}

export function failure(code?: string, message?: string): AdapterFailure {
  return { ok: false, reason: "error", code, message };
}

/** Pragmatic payload type where the real shape is still TBD (US-002 audit). */
export type Json = Record<string, unknown>;

export type AdapterPromise<T = Json> = Promise<AdapterResult<T>>;

// ---------------------------------------------------------------------------
// Named payload interfaces for the obvious shapes
// ---------------------------------------------------------------------------

export interface WhoAmI {
  personUid: string;
  email: string;
  displayName?: string;
  [k: string]: unknown;
}

export interface ChannelSummary {
  id: string;
  name: string;
  unreadCount?: number;
  [k: string]: unknown;
}

export interface NotificationItem {
  id: string;
  title: string;
  read?: boolean;
  [k: string]: unknown;
}

/**
 * The durable notifications feed returned by hq-pro and Sync's Rust command.
 * Keep the envelope intact: the unread rollup is global (not page-local), and
 * `nextCursor` is an opaque server token that callers must pass back verbatim.
 */
export interface NotificationsFeed {
  notifications: NotificationItem[];
  unreadCount: number;
  nextCursor: string | null;
}

function notificationRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function notificationItem(value: unknown): NotificationItem | null {
  const row = notificationRecord(value);
  if (!row) return null;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id) return null;
  const title =
    typeof row.title === "string"
      ? row.title
      : typeof row.body === "string"
        ? row.body
        : "";
  const status = typeof row.status === "string" ? row.status.toLowerCase() : "";
  const readAt = row.readAt ?? row.read_at;
  const read =
    row.read === true ||
    status === "read" ||
    (typeof readAt === "string" && readAt.trim().length > 0);
  return {
    ...row,
    id,
    title,
    // Consumers use the durable status field, so legacy read/readAt rows must
    // be normalized into the same state rather than only exposing a side flag.
    status: status || (read ? "read" : "unread"),
    read,
  };
}

/**
 * Normalize legacy bare arrays at the platform edge while making every caller
 * observe the canonical envelope. New hosts must never flatten this result.
 */
export function normalizeNotificationsFeed(value: unknown): NotificationsFeed {
  const record = notificationRecord(value);
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(record?.notifications)
      ? record.notifications
      : [];
  const notifications = rows
    .map(notificationItem)
    .filter((row): row is NotificationItem => row !== null);
  const rawUnread = record?.unreadCount ?? record?.unread_count;
  const parsedUnread =
    typeof rawUnread === "number"
      ? rawUnread
      : typeof rawUnread === "string" && rawUnread.trim()
        ? Number(rawUnread)
        : NaN;
  const unreadCount = Number.isFinite(parsedUnread)
    ? Math.max(0, Math.floor(parsedUnread))
    : notifications.filter((item) => item.read !== true).length;
  const rawCursor = record?.nextCursor ?? record?.next_cursor;
  const nextCursor =
    typeof rawCursor === "string" && rawCursor.trim().length > 0
      ? rawCursor
      : null;
  return { notifications, unreadCount, nextCursor };
}

export interface SyncStatus {
  running?: boolean;
  lastSyncAt?: string | null;
  pendingFiles?: number;
  conflicts?: number;
  daemonRunning?: boolean;
  source?: string;
  hqFolderPath?: string;
  [k: string]: unknown;
}

export interface DaemonStatus {
  running: boolean;
  pid?: number | null;
  startedAt?: string | null;
  watchPath?: string | null;
  source?: string;
}

export interface VersionInfo {
  app?: string;
  core?: string;
  cli?: string;
  /** Independent probe outcomes are retained even when the other probe works. */
  coreProbe?: VersionProbe;
  cliProbe?: VersionProbe;
  [k: string]: unknown;
}

export interface VersionProbe {
  status: "available" | "missing" | "failed";
  value?: string | null;
  code?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Domain groups
// ---------------------------------------------------------------------------

/** The caller's editable global member profile, as it appears on the wire. */
export interface MemberProfileWire {
  displayName?: string;
  description?: string;
  /** Presigned avatar URL (preferred) — never the raw S3 key. */
  avatarUrl?: string;
  /** Legacy inline base64 for un-migrated rows (no `data:` prefix). */
  avatarBase64?: string;
}

/** GET /v1/profile response shape. `profile` is null until first set. */
export interface GetProfileResult {
  profile: MemberProfileWire | null;
  /** Entity name — the displayName fallback the UI shows when unset. */
  entityName?: string;
}

/**
 * PUT /v1/profile body. At least one field must be present. `avatarBase64`
 * must be raw base64 (no `data:` prefix), decode ≤192KB, image ≥512×512px.
 */
export interface UpdateProfileInput {
  displayName?: string;
  description?: string;
  avatarBase64?: string;
}

export interface IdentityApi {
  whoami(): AdapterPromise<WhoAmI>;
  isAdmin(): AdapterPromise<boolean>;
  hasFeature(flag: string): AdapterPromise<boolean>;
  /** Workspace memberships (companies + roles) for the signed-in person. */
  listWorkspaces(): AdapterPromise<Json[]>;
  /** GET /v1/profile — the caller's editable global member profile. */
  getProfile(): AdapterPromise<GetProfileResult>;
  /** PUT /v1/profile — update name / description / avatar (field-merge). */
  updateProfile(input: UpdateProfileInput): AdapterPromise<{
    profile: MemberProfileWire | null;
  }>;
}

export interface MessageSearchOptions {
  /** Restrict hits to one company scope. */
  companyUid?: string;
  /** Max hits to return. */
  limit?: number;
}

/**
 * Optional tenant scope for a contacts listing. Omitting `companyUid` returns
 * every contact the caller can see across ALL their companies — correct for a
 * global compose picker, WRONG for a channel-scoped mention roster, which must
 * only ever offer members of the channel's own company.
 */
export interface ListContactsOptions {
  /** Restrict the roster to one company (`GET /v1/notify/contacts?companyUid=`). */
  companyUid?: string | null;
}

/** Optional owner/admin scope for channel-directory listings. */
export interface ListChannelsOptions {
  /** Company whose project channels the caller administers. */
  companyUid?: string;
  /** Include project channels even when the caller is not a member. */
  includeCompanyProjects?: boolean;
}

/** Reply-thread partition. Distinct from GET /v1/notify/thread (1:1 DM list). */
export type ReplyThreadScope = "dm" | "channel";

export interface FetchReplyThreadArgs {
  scope: ReplyThreadScope;
  rootEventId: string;
  withPersonUid?: string;
  channelId?: string;
}

export interface SendReplyArgs {
  scope: ReplyThreadScope;
  rootEventId: string;
  body: string;
  withPersonUid?: string;
  channelId?: string;
  mentions?: Array<{
    participantUid: string;
    participantType: "human" | "agent";
    displayName: string;
    email?: string;
  }>;
  attachments?: Json[];
}

export interface ReplyThreadValue {
  scope: ReplyThreadScope;
  root: Json | null;
  replies: Json[];
  replyCount: number;
}

function trimText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isJsonRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** GET /v1/notify/threads — never GET /v1/notify/thread (1:1 conversation). */
export const REPLY_THREADS_PATH = "/v1/notify/threads";
/** Canonical DM send: POST /v1/notify/dm with `{ toPersonUid, body }`. */
export const REPLY_DM_SEND_PATH = "/v1/notify/dm";

/**
 * Derive reply-thread scope from a conversation row.
 * channelId present → channel (chat, project, AND group DMs).
 * kind==="dm" && personUid && !channelId → dm.
 * Never use kind==="dm" alone.
 */
export function replyScopeForRow(
  row:
    | {
        kind?: string | null;
        channelId?: string | null;
        personUid?: string | null;
      }
    | null
    | undefined,
): ReplyThreadScope | null {
  if (!row) return null;
  if (trimText(row.channelId)) return "channel";
  if (row.kind === "dm" && trimText(row.personUid)) return "dm";
  return null;
}

export function validateFetchReplyThread(
  args: FetchReplyThreadArgs,
): AdapterFailure | null {
  if (!trimText(args.rootEventId)) {
    return failure("http-400", "Missing required query parameter: rootEventId");
  }
  if (args.scope !== "dm" && args.scope !== "channel") {
    return failure(
      "http-400",
      "Query parameter 'scope' must be 'dm' or 'channel'",
    );
  }
  if (args.scope === "dm" && !trimText(args.withPersonUid)) {
    return failure(
      "http-400",
      "DM-scope thread requires query parameter 'withPersonUid'",
    );
  }
  if (args.scope === "channel" && !trimText(args.channelId)) {
    return failure(
      "http-400",
      "Channel-scope thread requires query parameter 'channelId'",
    );
  }
  return null;
}

export function validateSendReply(args: SendReplyArgs): AdapterFailure | null {
  if (!trimText(args.rootEventId)) {
    return failure(
      "http-400",
      "Field 'rootEventId' must be a non-empty string",
    );
  }
  if (args.scope !== "dm" && args.scope !== "channel") {
    return failure("http-400", "scope must be 'dm' or 'channel'");
  }
  if (args.scope === "dm" && !trimText(args.withPersonUid)) {
    return failure("http-400", "DM-scope reply requires withPersonUid");
  }
  if (args.scope === "channel" && !trimText(args.channelId)) {
    return failure("http-400", "Channel-scope reply requires channelId");
  }
  return null;
}

export function buildReplyThreadPath(args: FetchReplyThreadArgs): string {
  const params = new URLSearchParams({
    scope: args.scope,
    rootEventId: trimText(args.rootEventId),
  });
  if (args.scope === "dm") {
    params.set("withPersonUid", trimText(args.withPersonUid));
  } else {
    params.set("channelId", trimText(args.channelId));
  }
  return `${REPLY_THREADS_PATH}?${params.toString()}`;
}

export function buildSendReplyRequest(args: SendReplyArgs): {
  path: string;
  body: Json;
} {
  const body: Json = {
    body: args.body,
    rootEventId: trimText(args.rootEventId),
  };
  if (args.mentions && args.mentions.length > 0) {
    body.mentions = args.mentions;
  }
  if (args.attachments && args.attachments.length > 0) {
    body.attachments = args.attachments;
  }
  if (args.scope === "dm") {
    body.toPersonUid = trimText(args.withPersonUid);
    return { path: REPLY_DM_SEND_PATH, body };
  }
  return {
    path: `/v1/notify/channels/${encodeURIComponent(trimText(args.channelId))}/messages`,
    body,
  };
}

export function normalizeReplyThreadValue(value: unknown): ReplyThreadValue {
  const rec = isJsonRecord(value) ? value : {};
  const root = isJsonRecord(rec.root) ? rec.root : null;
  const replies = Array.isArray(rec.replies)
    ? rec.replies.filter(isJsonRecord)
    : [];
  const rootCount =
    root && typeof root.replyCount === "number" ? root.replyCount : undefined;
  const replyCount =
    typeof rec.replyCount === "number"
      ? rec.replyCount
      : (rootCount ?? replies.length);
  return {
    scope: rec.scope === "dm" ? "dm" : "channel",
    root,
    replies,
    replyCount,
  };
}

export interface MessagingApi {
  listChannels(opts?: ListChannelsOptions): AdapterPromise<ChannelSummary[]>;
  fetchChannelDirectory(cursor?: string): AdapterPromise<Json>;
  createChannel(payload: Json): AdapterPromise<Json>;
  /** POST /v1/notify/channels/{id}/members — add a person to a channel. */
  addChannelMember(
    channelId: string,
    toPersonUid: string,
  ): AdapterPromise<Json>;
  /**
   * DELETE /v1/notify/channels/{id}/members/{personUid} — remove a member.
   * Self-removal is always allowed; removing another member requires the
   * caller to be the channel owner (enforced server-side, 403 otherwise).
   */
  removeChannelMember(
    channelId: string,
    personUid: string,
  ): AdapterPromise<Json>;
  listContacts(opts?: ListContactsOptions): AdapterPromise<Json[]>;
  listDmRequests(): AdapterPromise<Json[]>;
  markChannelRead(id: string): AdapterPromise<void>;
  markDmThreadRead(personUid: string): AdapterPromise<void>;
  searchMessages(
    q: string,
    opts?: MessageSearchOptions,
  ): AdapterPromise<Json[]>;
  /** Channel detail + newest-first message page (windowed timeline). */
  fetchChannel(args: {
    channelId: string;
    limit?: number;
    cursor?: string | null;
    /** Exclusive ISO8601 lower bound — only messages after this instant. */
    since?: string | null;
  }): AdapterPromise<Json>;
  /** GET /v1/notify/channels/{id}/members — owner/creator + invitees. */
  listChannelMembers(channelId: string): AdapterPromise<Json>;
  sendChannelMessage(
    channelId: string,
    body: string,
    extras?: {
      mentions?: Array<{
        participantUid: string;
        participantType: "human" | "agent";
        displayName: string;
      }>;
      attachments?: Array<{
        id: string;
        vaultPath: string;
        companyUid: string;
        name: string;
        contentType: string;
        sizeBytes: number;
        kind: "image" | "file";
      }>;
    },
  ): AdapterPromise<Json>;
  /** Newest-first DM thread page with `withPersonUid`. */
  fetchDmThread(args: {
    withPersonUid: string;
    limit?: number;
    since?: string | null;
  }): AdapterPromise<Json>;
  sendDm(
    toPersonUid: string,
    body: string,
    extras?: {
      attachments?: Array<{
        id: string;
        vaultPath: string;
        companyUid: string;
        name: string;
        contentType: string;
        sizeBytes: number;
        kind: "image" | "file";
      }>;
    },
  ): AdapterPromise<Json>;
  fetchReplyThread(args: {
    scope: "dm" | "channel";
    rootEventId: string;
    withPersonUid?: string;
    channelId?: string;
  }): AdapterPromise<ReplyThreadValue>;
  sendReply(args: SendReplyArgs): AdapterPromise<Json>;
  /** GET /v1/notify/reactions — envelope `{ reactions }` or a bare list. */
  fetchReactions(messageScope: string, messageId: string): AdapterPromise<Json>;
  /** POST (add) or DELETE (remove) /v1/notify/reactions. */
  toggleReaction(args: {
    messageScope: string;
    messageId: string;
    emoji: string;
    add: boolean;
  }): AdapterPromise<void>;
}

export interface NotificationsApi {
  fetchNotifications(opts?: Json): AdapterPromise<NotificationsFeed>;
  ack(id: string): AdapterPromise<void>;
  readAll(): AdapterPromise<void>;
  runAction(id: string, action: string, actionRef?: string | null): AdapterPromise<Json>;
  /** v1 DM inbox (GET /v1/notify/inbox) — source for live DM rows. */
  fetchDmInbox(opts?: Json): AdapterPromise<Json>;
  /**
   * v1 DM conversation listing (GET /v1/notify/dm-threads) — every peer the
   * caller has exchanged DMs with, newest activity first, both directions.
   * Optional: hosts may omit it, and older servers answer 404; callers fall
   * back to the inbound-only inbox in both cases.
   */
  fetchDmThreads?(opts?: Json): AdapterPromise<Json>;
  ackDmInbox(eventIds: string[]): AdapterPromise<void>;
  /** v1 share inbox (GET /v1/files/shared-with-me). */
  fetchSharedWithMe(opts?: Json): AdapterPromise<Json>;
  ackSharedWithMe(eventIds: string[]): AdapterPromise<void>;
}

/** `POST /v1/google/connect` — Google OAuth consent URL for a new account. */
export interface CalendarConnectResult {
  url: string;
}

export interface MeetingsApi {
  listMemberships(): AdapterPromise<Json[]>;
  listUpcoming(): AdapterPromise<Json[]>;
  listScheduledBots(): AdapterPromise<Json[]>;
  inviteBot(payload: Json): AdapterPromise<Json>;
  cancelBot(id: string): AdapterPromise<void>;
  /** Same payload as inviteBot — hq-pro `POST /v1/bot/join-now`. */
  joinBotNow(payload: Json): AdapterPromise<Json>;
  listAccounts(): AdapterPromise<Json[]>;
  /** `{ calendars, selectedCalendarIds }` from `GET /v1/calendar/calendars`. */
  listCalendars(account: string): AdapterPromise<Json>;
  /** `POST /v1/google/connect` — returns `{ url }` (Google consent URL). */
  connectCalendar(): AdapterPromise<CalendarConnectResult>;
  /** `DELETE /v1/google/accounts/{accountId}` — revoke + remove one account. */
  disconnectCalendar(accountId: string): AdapterPromise<Json>;
}

export interface MarketplaceApi {
  listListings(opts?: Json): AdapterPromise<Json>;
  getListing(id: string): AdapterPromise<Json>;
  publishPack(path: string): AdapterPromise<Json>;
  recordInstall(id: string, payload?: Json): AdapterPromise<void>;
  yank(id: string, reason: string): AdapterPromise<void>;
  getCreatorProfile(handle: string): AdapterPromise<Json>;
  getMyCreator(): AdapterPromise<Json>;
  claimHandle(handle: string): AdapterPromise<Json>;
  updateCreatorProfile(p: CreatorProfileUpdate): AdapterPromise<Json>;
  uploadCreatorAvatar(data: Uint8Array | string): AdapterPromise<Json>;
  requestCreatorAccess(p: CreatorAccessRequest): AdapterPromise<Json>;
  listCreatorApplications(): AdapterPromise<Json[]>;
  decideCreatorApplication(id: string, decision: string): AdapterPromise<Json>;
  listModerationQueue(): AdapterPromise<Json[]>;
  decideModerationListing(id: string, decision: string): AdapterPromise<Json>;
  /** Desktop-only capability: canInstallLocally. */
  installPack(listing: Json): AdapterPromise<Json>;
}

/** The exact request body accepted by the creator-access command. */
export interface CreatorAccessRequest {
  reason: string | null;
  handle: string | null;
}

/** The exact camel-case body accepted by the creator-profile Tauri command. */
export interface CreatorProfileUpdate {
  bio: string | null;
  socialLinks: Array<{ label: string; url: string }> | null;
  tipUrl: string | null;
}

export interface CompanyApi {
  getDeployments(slug: string): AdapterPromise<Json[]>;
  getSecrets(slug: string): AdapterPromise<Json[]>;
  listMembers(slug: string): AdapterPromise<Json[]>;
  getTeamTelemetry(slug: string): AdapterPromise<Json>;
  claimPendingInvite(slug: string): AdapterPromise<Json>;
  connectToCloud(slug: string): AdapterPromise<Json>;
  getSummary(slug: string): AdapterPromise<Json>;
  getBoard(slug: string): AdapterPromise<Json>;
  getActivity(slug: string): AdapterPromise<Json[]>;
}

export interface ProjectsApi {
  listProjects(): AdapterPromise<Json[]>;
  getGoals(slug: string): AdapterPromise<Json>;
  getPrd(path: string): AdapterPromise<Json>;
  getReadme(path: string): AdapterPromise<string>;
  setProjectStatus(slug: string, status: string): AdapterPromise<void>;
  setStoryPasses(
    path: string,
    storyId: string,
    passes: boolean,
  ): AdapterPromise<void>;
  getProjectCreators(slug: string): AdapterPromise<Json[]>;
}

export interface LibraryApi {
  getRoot(): AdapterPromise<Json>;
  getCompany(slug: string): AdapterPromise<Json>;
  getWorkerDetail(path: string): AdapterPromise<Json>;
  getSkillDetail(path: string): AdapterPromise<Json>;
}

export interface FilesApi {
  listDir(relPath: string): AdapterPromise<Json[]>;
  getFileContent(path: string): AdapterPromise<string>;
  /** ACL-filtered vault browse (hq-pro GET /v1/files/list). */
  listVaultPrefix(companyUid: string, prefix: string): AdapterPromise<Json>;
  /** Presigned GET for a vault key (hq-pro POST /v1/files/presign). */
  presignVaultGet(companyUid: string, key: string): AdapterPromise<Json>;
  /** Presigned PUT for a vault key (hq-pro POST /v1/files/presign). */
  presignVaultPut(
    companyUid: string,
    key: string,
    contentType: string,
  ): AdapterPromise<Json>;
  getAuthorizedPreview(path: string): AdapterPromise<Json>;
  /** Desktop-only capability: localFiles. */
  revealInFinder(path: string): AdapterPromise<void>;
  /**
   * Open the user's CONFIGURED HQ folder in the OS file manager.
   *
   * Takes no argument on purpose. `revealInFinder` speaks the HQ-RELATIVE
   * path contract, which cannot express the HQ ROOT (an empty path is
   * rejected, and an absolute one is rejected outright). The host resolves
   * the configured root itself, so no renderer can hardcode or mis-resolve a
   * machine-specific path.
   */
  revealHqRoot(): AdapterPromise<void>;
}

export interface AgencyApi {
  listTeams(): AdapterPromise<Json[]>;
  listQuestions(): AdapterPromise<Json[]>;
  listChat(team: string): AdapterPromise<Json[]>;
  answerQuestion(id: string, answer: Json): AdapterPromise<void>;
  sendMessage(team: string, message: Json): AdapterPromise<void>;
}

export interface FeedbackApi {
  submitBugReport(title: string, body: string): AdapterPromise<Json>;
}

/** Desktop-only group (capability: canSync). */
export interface SyncApi {
  startDaemon(): AdapterPromise<void>;
  stopDaemon(): AdapterPromise<void>;
  daemonStatus(): AdapterPromise<DaemonStatus>;
  startSync(slug?: string): AdapterPromise<void>;
  cancelSync(): AdapterPromise<void>;
  getSyncStatus(): AdapterPromise<SyncStatus>;
  getActivityLog(): AdapterPromise<Json[]>;
  resolveConflict(path: string, strategy: string): AdapterPromise<void>;
  restoreFromUpstream(args: Json): AdapterPromise<void>;
  beginReauth(): AdapterPromise<Json>;
  listSyncableWorkspaces(): AdapterPromise<Json[]>;
}

/** Desktop-only group (capability: canLaunchApps). */
export interface ShellApi {
  openInEditor(path: string): AdapterPromise<void>;
  openClaudeCodeLink(url: string): AdapterPromise<void>;
  openFileInClaude(path: string): AdapterPromise<void>;
  launchClaudeCode(path: string): AdapterPromise<void>;
  /** Open the Codex desktop app (the ChatGPT app's Codex surface) with the
   *  folder loaded as the workspace and an optional pre-typed composer prompt.
   *  Backed by the `launch_codex_workspace` command (ChatGPT-bundled CLI's
   *  `codex app <path>` + delayed `codex://threads/new?prompt=` follow-up). */
  launchCodexWorkspace(path: string, prompt?: string): AdapterPromise<void>;
  launchCliInTerminal(args: Json): AdapterPromise<void>;
  detectAiTools(): AdapterPromise<Json>;
  pickFolder(): AdapterPromise<string | null>;
  pickFile(kind: string): AdapterPromise<string | null>;
}

/** Desktop-first; web no-ops or browser equivalents (trayAndWindow / osNotifications). */
export interface AppShellApi {
  setTrayState(state: string): AdapterPromise<void>;
  showMainWindow(): AdapterPromise<void>;
  quitApp(): AdapterPromise<void>;
  /** Show or hide the macOS Dock icon (activation policy). Keeps the window
   *  visible either way — hiding the Dock icon does not hide the app. */
  setDockVisible(visible: boolean): AdapterPromise<void>;
  setAutostart(enabled: boolean): AdapterPromise<void>;
  /** Show or hide the floating HQ wordmark widget without restart. */
  setDesktopWidget(enabled: boolean): AdapterPromise<void>;
  consumePendingRoute(): AdapterPromise<string | null>;
  takePendingMessagesTarget(): AdapterPromise<Json | null>;
  setActiveCompany(slug: string): AdapterPromise<void>;
  openDriftDetail(report: Json): AdapterPromise<void>;
  openMeetingPermissionsWindow(): AdapterPromise<void>;
  notificationPermissionState(): AdapterPromise<string>;
  requestNotificationPermission(): AdapterPromise<string>;
  /** Open the host OS's notification settings without the frontend owning a URI. */
  openNotificationSettings(): AdapterPromise<void>;
  /** Desktop-only: post a native OS banner. `route` is echoed on click. */
  showOsNotification(args: {
    title: string;
    body: string;
    route?: string;
  }): AdapterPromise<void>;
}

/** Desktop-only group (capability: canSelfUpdate). */
export interface UpdatesApi {
  getVersions(): AdapterPromise<VersionInfo>;
  checkForUpdates(): AdapterPromise<Json>;
  installUpdate(): AdapterPromise<void>;
  getPendingUpdate(): AdapterPromise<Json | null>;
  checkCoreState(): AdapterPromise<Json>;
  installCoreUpdate(): AdapterPromise<void>;
  replaceFromStaging(): AdapterPromise<void>;
  checkCliUpdate(): AdapterPromise<Json>;
  installCliUpdate(): AdapterPromise<void>;
  dismissCliUpdate(): AdapterPromise<void>;
  availableChannels(): AdapterPromise<string[]>;
}

/** Explicit native install intent. Registry installs use a different CLI path. */
export interface PackageInstallRequest {
  source: string;
  /** Route an entitlement-gated registry slug to `hq packages install`. */
  registry?: boolean;
}

/** Desktop-only group (capability: canManagePackages). */
export interface PackagesApi {
  listPackages(): AdapterPromise<Json[]>;
  /** Instant last-known snapshot; null when no cache. */
  listPackagesCached(): AdapterPromise<Json | null>;
  install(request: PackageInstallRequest): AdapterPromise<Json>;
  update(name: string): AdapterPromise<Json>;
  uninstall(name: string): AdapterPromise<void>;
  checkUpdates(): AdapterPromise<Json>;
  updatePacks(names: string[]): AdapterPromise<Json>;
}

/** Desktop-only group (capability: canSpawnSessions). */
export interface SessionsApi {
  listAgentSessions(): AdapterPromise<Json[]>;
}

/** Local per-platform settings. */
export interface SettingsApi {
  getConfig(): AdapterPromise<Json>;
  getSettings(): AdapterPromise<Json>;
  /** Persist a minimal patch over the latest host settings. */
  updateSettings(patch: Json): AdapterPromise<void>;
  getSetupStatus(): AdapterPromise<Json>;
  getTelemetryConsent(): AdapterPromise<boolean | null>;
}

/**
 * Work-mesh PROJECT_VIEW + local machine cache.
 *
 * Desktop `readLocalSnapshot` returns the on-disk cache
 * (`~/.hq/work-mesh/cache` + fabric-genesis.json). Web returns unavailable
 * for the local snapshot and implements `getProjectView` against hq-pro REST
 * so both hosts share the @hq/core mapper.
 */
export interface WorkMeshApi {
  readLocalSnapshot(): AdapterPromise<Json>;
  /** hq-pro GET /v1/work-mesh/projects/{id}?companyUid= is required. */
  getProjectView(projectId: string, companyUid?: string): AdapterPromise<Json>;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface PlatformAdapter {
  /** Which host this adapter targets. */
  readonly kind: "web" | "desktop";
  /** Capability flags for this platform. */
  readonly capabilities: Readonly<Capabilities>;
  /** Convenience helper over `capabilities`. */
  isAvailable(cap: Capability): boolean;

  readonly identity: IdentityApi;
  readonly messaging: MessagingApi;
  readonly notifications: NotificationsApi;
  readonly meetings: MeetingsApi;
  readonly marketplace: MarketplaceApi;
  readonly company: CompanyApi;
  readonly projects: ProjectsApi;
  readonly library: LibraryApi;
  readonly files: FilesApi;
  readonly agency: AgencyApi;
  readonly feedback: FeedbackApi;
  readonly sync: SyncApi;
  readonly shell: ShellApi;
  readonly appShell: AppShellApi;
  readonly updates: UpdatesApi;
  readonly packages: PackagesApi;
  readonly sessions: SessionsApi;
  readonly settings: SettingsApi;
  readonly workMesh: WorkMeshApi;
}

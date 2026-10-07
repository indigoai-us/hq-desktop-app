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
import type {
  EvidenceOptions,
  ServiceEvidence,
} from "./calls/evidence.js";

export type AdapterResult<T> = { ok: true; value: T } | AdapterFailure;

export interface AdapterFailure {
  ok: false;
  reason: "unavailable" | "error";
  /** Machine hint, e.g. "desktop-only", "not-yet-implemented-api", "http-500". */
  code?: string;
  /** Human-readable detail, safe to surface in dev tooling. */
  message?: string;
  /**
   * Server-selected upgrade link carried by a plan-limit refusal, already
   * checked against the hosts hq-pro returns (see `plan-limit.ts`). Absent on
   * every other failure.
   */
  upgradeUrl?: string;
  /**
   * The running machine named by a refused bot removal (code
   * `AGENTS_V2_BOX_PROTECTED`). The server removes the bot only when the
   * request names this machine; see `AgentDeprovisionOptions`. Absent on
   * every other failure.
   */
  instanceId?: string;
  /**
   * The HTTP status of the refused request. Set only by the two Slack channel
   * calls (`AgentsApi.attachSlack`, `AgentsApi.submitSlackAppToken`), whose
   * callers tell a 403 or 404 from a refusal that carries a server code.
   * Absent on every other failure, and on a request that never got an answer.
   */
  status?: number;
  /**
   * The code of the service behind hq-pro that refused, when the body names
   * one (`upstreamCode`, sent with `CHANNEL_ATTACH_FAILED`). A short machine
   * code, never text from the request.
   */
  upstreamCode?: string;
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

/**
 * Put the HTTP status on a failed result. A success, and a failure with no
 * status (the request never got an answer), come back unchanged.
 */
export function withHttpStatus<T>(
  result: AdapterResult<T>,
  status: number | null | undefined,
): AdapterResult<T> {
  if (result.ok || typeof status !== "number") return result;
  return { ...result, status };
}

/** What stands in for a secret that a failure's text repeated. */
export const REDACTED_SECRET = "[redacted]";

/**
 * Take a secret out of a failed result's text. A server or a transport could
 * repeat part of the request in its error; a secret the caller sent must not
 * leave the request body that way. A success comes back unchanged: the
 * caller owns what the server answered.
 */
export function withoutSecret<T>(
  result: AdapterResult<T>,
  secret: string,
): AdapterResult<T> {
  if (result.ok) return result;
  const secrets = [...new Set([secret, secret.trim()])].filter((s) => s.length > 0);
  if (secrets.length === 0) return result;
  const clean = (text: string | undefined): string | undefined =>
    text === undefined
      ? undefined
      : secrets.reduce((out, s) => out.split(s).join(REDACTED_SECRET), text);
  const code = clean(result.code);
  const message = clean(result.message);
  const upstreamCode = clean(result.upstreamCode);
  if (
    code === result.code &&
    message === result.message &&
    upstreamCode === result.upstreamCode
  ) {
    return result;
  }
  return {
    ...result,
    ...(code !== undefined ? { code } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(upstreamCode !== undefined ? { upstreamCode } : {}),
  };
}

/** Pragmatic payload type where the real shape is still TBD (US-002 audit). */
export type Json = Record<string, unknown>;

export type AdapterPromise<T = Json> = Promise<AdapterResult<T>>;

/**
 * Live-subscription seam for `IdentityApi.subscribeFeature`. Emits fresh
 * resolved values when the underlying flag snapshot changes; the returned
 * function unsubscribes. Callers MUST still do an initial `hasFeature`
 * read at mount — an adapter without a live channel returns a no-op.
 */
export type FeatureSubscribeFn = (
  flag: string,
  onChange: (result: AdapterResult<boolean>) => void,
) => () => void;

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

export interface DaemonSyncStatus {
  running: boolean;
  paused: boolean;
  syncOwner: string;
  owner: string | null;
  lastHeartbeat: string | null;
  lastPassResult: {
    status?: string;
    completedAt?: string;
    errors?: number;
    [key: string]: unknown;
  } | null;
  unitStatus: string;
  reason: string | null;
  logPath: string;
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

/**
 * PATCH /v1/agents/{uid}/profile body. At least one field must be present.
 * Avatars are uploaded bytes (`avatarBase64`); hq-pro does not accept an
 * external image URL here.
 */
export interface UpdateAgentProfileInput {
  displayName?: string;
  title?: string;
  description?: string;
  avatarBase64?: string;
}

export interface AgentProfileWire {
  displayName?: string;
  title?: string;
  description?: string;
  avatarUrl?: string;
  avatarBase64?: string;
}

export interface UpdateAgentProfileResult {
  uid: string;
  profile: AgentProfileWire;
  slackUpdated?: boolean;
}

export interface AvatarPackAuthorWire {
  handle: string;
  displayName: string;
  avatarUrl?: string;
}

export interface AvatarPackListEntry {
  id: string;
  name: string;
  version: string;
  author: AvatarPackAuthorWire;
  count: number;
  thumbnailUrl?: string;
}

export interface AvatarPackListPayload {
  packs: AvatarPackListEntry[];
  expiresAt: number;
}

export interface AvatarPackItemWire {
  id: string;
  name: string;
  tags: string[];
  thumbUrl: string;
  fullUrl: string;
}

export interface AvatarPackDetailPayload {
  id: string;
  name: string;
  version: string;
  author: AvatarPackAuthorWire;
  count: number;
  items: AvatarPackItemWire[];
  expiresAt: number;
}

export interface SelectAgentAvatarInput {
  packId: string;
  itemId: string;
}

export interface SelectAgentAvatarResult {
  uid: string;
  avatarUrl?: string;
  profile?: AgentProfileWire;
  slackUpdated?: boolean;
}

/** Evaluation context for a feature flag. */
export interface FeatureScope {
  companyUid?: string | null;
}

export interface IdentityApi {
  whoami(): AdapterPromise<WhoAmI>;
  /** Native auth envelope; accountId is the Cognito subject used by local writers. */
  getAuthSession?(): AdapterPromise<{
    accountId: string | null;
    generation: number;
    status: string;
    reason: string | null;
  }>;
  isAdmin(): AdapterPromise<boolean>;
  /**
   * `scope.companyUid` evaluates the flag in that company's context, which is
   * the only way a company-targeted flag reads as on. Omitted → person-only.
   */
  hasFeature(flag: string, scope?: FeatureScope): AdapterPromise<boolean>;
  /**
   * One company's value for a flag, for the signed-in person. `hasFeature` is
   * read per person with no company, so it cannot answer for a company flag.
   * Total: resolves `false` for an unreadable, missing or malformed answer and
   * never rejects. Not cached: the caller owns how often it asks. Hosts with
   * no company flag source (web) resolve `false`.
   */
  hasCompanyFeature?(flag: string, companyUid: string): Promise<boolean>;
  /** Status-aware flag read for telemetry that distinguishes explicit-off from missing/unreadable. */
  resolveFeatureFlagStatus?(flag: string): AdapterPromise<{
    enabled: boolean;
    configured: boolean;
  }>;
  /** Force a fresh hq-flags snapshot after the authenticated identity changes. */
  refreshFeatureFlags?(): Promise<void>;
  /**
   * Optional live subscription to a feature flag. When the underlying flag
   * registry publishes a fresh snapshot, `onChange` fires with the resolved
   * value. Returns an unsubscribe function. Adapters without a live channel
   * may return a no-op unsubscribe and never call the callback — callers
   * MUST also do an initial `hasFeature` read at mount.
   */
  subscribeFeature?: FeatureSubscribeFn;
  /** Workspace memberships (companies + roles) for the signed-in person. */
  listWorkspaces(): AdapterPromise<Json[]>;
  /** GET /v1/profile — the caller's editable global member profile. */
  getProfile(): AdapterPromise<GetProfileResult>;
  /** PUT /v1/profile — update name / description / avatar (field-merge). */
  updateProfile(input: UpdateProfileInput): AdapterPromise<{
    profile: MemberProfileWire | null;
  }>;
  /**
   * PATCH /v1/agents/{agentUid}/profile — owner/admin merge of displayName /
   * title / description / avatarBase64 onto `metadata.agentConfig.profile`.
   */
  updateAgentProfile(
    agentUid: string,
    input: UpdateAgentProfileInput,
  ): AdapterPromise<UpdateAgentProfileResult>;
  /** GET /v1/avatar-packs — published gallery catalog. */
  listAvatarPacks(): AdapterPromise<AvatarPackListPayload>;
  /** GET /v1/avatar-packs/{id} — items with presigned thumb/full URLs. */
  getAvatarPack(packId: string): AdapterPromise<AvatarPackDetailPayload>;
  /**
   * POST /v1/agents/{agentUid}/avatar — copy a pack item onto the agent's
   * profile avatarKey.
   */
  selectAgentAvatar(
    agentUid: string,
    input: SelectAgentAvatarInput,
  ): AdapterPromise<SelectAgentAvatarResult>;
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
/** Recipient-side answer to a pending DM connection request. */
export type DmRequestAction = "accept" | "decline" | "block";

export interface ListContactsOptions {
  /** Restrict the roster to one company (`GET /v1/notify/contacts?companyUid=`). */
  companyUid?: string | null;
  /** US-006: when true, contacts with an agent-only last message show their preview. */
  showBotMessages?: boolean;
}

/** Optional owner/admin scope for channel-directory listings. */
export interface ListChannelsOptions {
  /** Company whose project channels the caller administers. */
  companyUid?: string;
  /** Include project channels even when the caller is not a member. */
  includeCompanyProjects?: boolean;
}

/**
 * Filtered view of a message history route (`view` query parameter on
 * GET /v1/notify/channels/{id}/messages and GET /v1/notify/thread). `human`
 * is the only value the server accepts; any other value is a 400.
 */
export type HistoryView = "human";

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
    // "broadcast" is the @here token — participantUid is "here" and the
    // server expands it against the channel's current members.
    participantType: "human" | "agent" | "broadcast";
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

/**
 * Shown when `deleteChannel` hits a server that predates the delete route
 * (API Gateway's generic `{"message":"Not Found"}`, no `code`). Mirrors the
 * string the Sync Rust command returns so every adapter reads the same.
 */
export const DELETE_CHANNEL_UNSUPPORTED_MESSAGE =
  "This server doesn't support deleting channels yet.";

/** Per-channel notification level (`PUT /v1/notify/channels/{id}/notify-level`). */
export type NotifyLevel = "all" | "mentions" | "files" | "muted";

/**
 * Per-person notification preferences (`GET/PUT /v1/notify/prefs`).
 * `pausedUntil` is an ISO-8601 instant (Z), `"forever"`, or null.
 */
export interface NotifyPrefs {
  pausedUntil: string | null;
  dmsDuringPause: boolean;
  dms: boolean;
  mentions: boolean;
  files: boolean;
  allActivity: boolean;
  addedToChannel: boolean;
  updatedAt?: string | null;
}

/** Envelope of both prefs routes. */
export interface NotifyPrefsResponse {
  prefs: NotifyPrefs;
  paused: boolean;
}

/** Partial PUT body; the server merges it onto the stored row. */
export type NotifyPrefsPatch = Partial<Omit<NotifyPrefs, "updatedAt">>;

export interface MessagingApi {
  /**
   * GET /v1/notify/prefs. Optional: hosts without it hide the fine-grained
   * notification settings. A server that predates the route answers 404
   * (`code: "http-404"`), which callers treat as "not available yet".
   */
  getNotifyPrefs?(): AdapterPromise<NotifyPrefsResponse>;
  /** PUT /v1/notify/prefs with a partial body. */
  updateNotifyPrefs?(patch: NotifyPrefsPatch): AdapterPromise<NotifyPrefsResponse>;
  /**
   * PUT /v1/notify/channels/{id}/notify-level `{ level }`. Errors:
   * 400 INVALID_NOTIFY_LEVEL, 403 CHANNEL_NOT_JOINED, 404 on older servers.
   */
  setChannelNotifyLevel?(channelId: string, level: NotifyLevel): AdapterPromise<Json>;
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
  /**
   * DELETE /v1/notify/channels/{channelId} — delete a channel outright.
   * Owner-only (server-enforced). Contract:
   *   200 `{ deleted: "<channelId>" }`
   *   403 `{ error, code: "CHANNEL_NOT_OWNER" }`
   *   404 `{ error, code: "CHANNEL_NOT_FOUND" }`
   *   409 `{ error, code: "CHANNEL_GROUP_NOT_DELETABLE" }` (group DMs)
   * A server that predates the route answers API Gateway's generic 404
   * `{"message":"Not Found"}` (no `code`) — adapters surface that as
   * "This server doesn't support deleting channels yet." rather than a bare
   * "Not Found". After a delete the server fans out a directory-feed change;
   * the deleting client drops the row itself (optimistic `channel:removed`).
   */
  deleteChannel(channelId: string): AdapterPromise<Json>;
  listContacts(opts?: ListContactsOptions): AdapterPromise<Json[]>;
  listDmRequests(): AdapterPromise<Json[]>;
  /**
   * POST /v1/notify/connections/{accept|decline|block} body `{ pairKey }` —
   * desktop `respond_dm_request`. Optional: hosts without the route omit it
   * and the Requests panel shows the request as read-only.
   */
  respondDmRequest?(args: {
    pairKey: string;
    action: DmRequestAction;
  }): AdapterPromise<Json>;
  markChannelRead(id: string): AdapterPromise<void>;
  markDmThreadRead(personUid: string): AdapterPromise<void>;
  searchMessages(
    q: string,
    opts?: MessageSearchOptions,
  ): AdapterPromise<Json[]>;
  /**
   * Channel detail + newest-first message page (windowed timeline).
   *
   * `view: "human"` asks the server to filter the page to the human view and
   * page on its side. A server that applied it echoes `view: "human"` in the
   * response and may add `viewScanTruncated: true` (always with a
   * `nextCursor`). An older server ignores the parameter and returns an
   * ordinary unfiltered page with no `view` field, so callers must check the
   * echo before trusting the page as filtered. Omit it for the unfiltered
   * route.
   */
  fetchChannel(args: {
    channelId: string;
    limit?: number;
    cursor?: string | null;
    /** Exclusive ISO8601 lower bound — only messages after this instant. */
    since?: string | null;
    view?: HistoryView;
  }): AdapterPromise<Json>;
  /** GET /v1/notify/channels/{id}/members — owner/creator + invitees. */
  listChannelMembers(channelId: string): AdapterPromise<Json>;
  /**
   * GET /v1/agent-telescope/agents/{agentUid}/channels/{channelId}/tasks —
   * tasks an agent spawned from messages in ONE room (trace-backed; terminal
   * states retained). Optional: a host without the route omits it and the
   * chat falls back to the agent-wide view.
   */
  listChannelAgentTasks?(agentUid: string, channelId: string): AdapterPromise<Json>;
  /** GET /v1/agent-telescope/agents/{agentUid}/tasks — heartbeat task view. */
  listAgentTasks?(agentUid: string): AdapterPromise<Json>;
  /**
   * POST /v1/notify/channels/{id}/cards/{cardId}/actions — desktop
   * `run_card_action`. Client-generated idempotencyKey; 409 replay is success.
   */
  runCardAction(args: {
    channelId: string;
    cardId: string;
    actionId: string;
    values: Record<string, string>;
    idempotencyKey?: string;
  }): AdapterPromise<Json>;
  /**
   * GET /v1/companies/slug-available?slug={value} — advisory company-handle
   * check for the create-company step. Optional: a host without the route
   * omits it and the step falls back to submit-time validation.
   */
  checkCompanySlug?(slug: string): AdapterPromise<Json>;
  /**
   * POST activate-cloud for a company: owner-only, idempotent cloud vault
   * provisioning (bucket, KMS, owner grants). Optional: a host without the
   * route omits it.
   */
  activateCompanyCloud?(companyUid: string): AdapterPromise<Json>;
  /** GET /v1/companies/{uid}/tabs/{tab} (US-015). */
  getCompanyTab?(companyUid: string, tab: string): AdapterPromise<Json>;
  /** POST /v1/companies/{uid}/tabs/{tab}/actions (US-015). */
  runCompanyTabAction?(args: {
    companyUid: string;
    tab: string;
    cardId: string;
    actionId: string;
    values: Record<string, string>;
    idempotencyKey?: string;
  }): AdapterPromise<Json>;
  sendChannelMessage(
    channelId: string,
    body: string,
    extras?: {
      mentions?: Array<{
        participantUid: string;
        // "broadcast" is the @here token (participantUid "here").
        participantType: "human" | "agent" | "broadcast";
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
  /**
   * Newest-first DM thread page with `withPersonUid`. `cursor` is the
   * `nextCursor` of the previous page. `view` works as on `fetchChannel`.
   */
  fetchDmThread(args: {
    withPersonUid: string;
    limit?: number;
    since?: string | null;
    cursor?: string | null;
    view?: HistoryView;
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
      /**
       * Message lane. "agent" is for the bot only: no notification, and
       * conversation views leave it out for the person. Default: the server's.
       */
      audience?: "human" | "agent" | "both";
      /**
       * Bot recipients only. The server delivers one message per key, so a
       * request the app may repeat reaches the bot once.
       */
      idempotencyKey?: string;
    },
  ): AdapterPromise<Json>;
  /**
   * POST /v1/notify/dm (desktop `send_dm_to_email`) — address a DM by email
   * OR person uid, never both. Returns `{ state: "delivered" }` when the pair
   * is already connected and `{ state: "connectionRequested" }` when the
   * server parked an approval request instead.
   *
   * OPTIONAL: the web adapter does not implement it, and the UI hides every
   * email-invite affordance when it is absent.
   */
  sendDmToEmail?(args: {
    toEmail?: string;
    toPersonUid?: string;
    body: string;
  }): AdapterPromise<Json>;
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
  /**
   * Cross-session new-file activity (GET /v1/notify/file-history) — files a
   * teammate added to a company folder, as reported by the sync runner.
   *
   * Optional: these rows have no NOTIF-store counterpart and no ack endpoint,
   * so a host that cannot serve them simply omits the method and the feed
   * composes without them. Callers must treat it as possibly-absent.
   */
  fetchFileHistory?(opts?: Json): AdapterPromise<Json>;
}

/** `POST /v1/google/connect` — Google OAuth consent URL for a new account. */
export interface CalendarConnectResult {
  url: string;
}

/**
 * macOS privacy (TCC) snapshot for the desktop meeting detector, as returned
 * by the native `meetings_permissions_state` command. Each status is one of
 * `"granted" | "denied" | "not-determined" | "unknown"`. `allRequiredGranted`
 * is true only when accessibility, screen capture, and microphone are all
 * granted — the detector never starts without it.
 */
export interface MeetingPermissionsSnapshot {
  accessibility: string;
  screenCapture: string;
  microphone: string;
  systemAudio: string;
  fullDiskAccess: string;
  allRequiredGranted: boolean;
}

export interface MeetingsApi {
  listMemberships(): AdapterPromise<Json[]>;
  listUpcoming(): AdapterPromise<Json[]>;
  listScheduledBots(): AdapterPromise<Json[]>;
  /**
   * Recorded meeting history, newest first (`GET /v1/meetings`). Pass a
   * company uid for that company's meetings; omit it for the caller's
   * unattributed (personal) meetings. Returns the raw `{ meetings, nextToken }`
   * envelope; callers coerce rows at their parse boundary.
   */
  listRecorded(companyId?: string | null): AdapterPromise<Json>;
  /**
   * One recorded meeting (`GET /v1/meetings/{id}`): source frontmatter plus
   * its signals grouped by type, each with a presigned body URL. Raw
   * envelope; callers coerce it.
   */
  getRecorded(meetingId: string, companyId?: string | null): AdapterPromise<Json>;
  /**
   * Text behind a presigned vault URL from `getRecorded` (the meeting
   * document or a signal body). On desktop the native side reads it: the
   * vault buckets send no CORS headers, so a webview fetch is blocked.
   */
  readRecordedBody(url: string): AdapterPromise<string>;
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
  /**
   * Prompt-less read of the native meeting-detector permissions
   * (`meetings_permissions_state`). Unavailable on hosts without a native
   * detector (web, HQ Work desktop); callers hide their UI on `!ok`.
   */
  permissionsState(): AdapterPromise<MeetingPermissionsSnapshot>;
  /**
   * Open (or focus) the native "Meeting Permissions" setup window
   * (`open_meeting_permissions_window`). It requests each missing macOS
   * permission and starts the detector as soon as everything is granted.
   */
  openPermissionsSetup(): AdapterPromise<void>;
  /**
   * One live-transcript poll (`GET /v1/meetings/{recallBotId}?view=live`).
   * Optional: only hosts with the native fetch implement it; callers show
   * an honest "no live view" state when it is absent.
   */
  fetchLiveTranscript?(
    req: LiveTranscriptRequest,
  ): AdapterPromise<LiveTranscriptResult>;
}

export interface LiveTranscriptRequest {
  recallBotId: string;
  companyId: string;
  sinceRevision?: number | null;
  etag?: string | null;
}

export interface LiveTranscriptSegmentWire {
  segmentId: string;
  participantId?: string | null;
  speaker?: string | null;
  startSeconds: number;
  endSeconds?: number | null;
  text: string;
}

export interface LiveTranscriptPartialWire {
  participantId?: string | null;
  speaker?: string | null;
  startSeconds: number;
  text: string;
}

/** Tagged result of one poll, as produced by the native fetch. */
export type LiveTranscriptResult =
  | {
      kind: "ok";
      revision: number;
      etag?: string | null;
      updatedAt?: string | null;
      provisional?: boolean;
      truncated?: boolean;
      segments: LiveTranscriptSegmentWire[];
      partial?: LiveTranscriptPartialWire | null;
    }
  | { kind: "not-modified" }
  | { kind: "disabled" }
  | { kind: "not-found" };

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
  /**
   * The company's connected apps from hq-pro `GET /v1/integrations/admin`:
   * `{ companyUid, viewer, connections: [{ id, provider, status, scopes,
   * createdByName, updatedAt, … }], audit }`. Desktop only.
   */
  listIntegrations?(companyUid: string): AdapterPromise<Json>;
  /**
   * Raw hq-deploy `/api/apps` rows for one scope (company slug or
   * `personal`): `{ scope, callerSub, apps }`. Desktop only.
   */
  listDeployApps?(scope: string): AdapterPromise<Json>;
  /**
   * Side-panel preview for one deployed app: `{ ogImageUrl, thumbnail }`.
   * Read lazily on selection and cached on disk by app id + deploy time.
   * Desktop only.
   */
  deployAppPreview?(appId: string, url: string, deployedAt: string, refresh: boolean): AdapterPromise<Json>;
  /**
   * Rendered snapshot of one deployed app: `{ snapshot, width, height }`
   * with `snapshot` a PNG data: URL. Captured in a hidden window on selection
   * and cached on disk by app id + deploy time. For a protected app pass
   * `gate`; the desktop then requests an hq-deploy preview pass for `scope`
   * (and fails when the server does not offer one). Desktop only; macOS today.
   */
  deployAppSnapshot?(
    appId: string,
    url: string,
    deployedAt: string,
    refresh: boolean,
    gate?: { scope: string; protected: boolean },
  ): AdapterPromise<Json>;
  /**
   * One hq-deploy access call (`access-policy`, `access-mode`,
   * `allowed-emails` under `/api/apps/:id`) for a scope. Desktop only; the
   * host refuses any other route.
   */
  deployAccessRequest?(
    scope: string,
    method: "GET" | "PUT" | "POST" | "DELETE",
    path: string,
    body?: Json,
  ): AdapterPromise<Json>;
  getSecrets(slug: string): AdapterPromise<Json[]>;
  listMembers(slug: string): AdapterPromise<Json[]>;
  /**
   * OWNER-R9: the company's membership roster with role, acceptedAt, origin and
   * membershipKey (`GET /membership/company/{uid}` → `{members}`). Desktop only.
   */
  listCompanyMemberships?(companyUid: string): AdapterPromise<Json>;
  /** OWNER-R9: unclaimed invites (`GET /membership/company/{uid}/pending` → `{pending}`). */
  listPendingMemberships?(companyUid: string): AdapterPromise<Json>;
  /** OWNER-R9: files and secrets one member can reach (`GET /files/{uid}/members/{personUid}/access`). */
  getMemberAccess?(companyUid: string, personUid: string): AdapterPromise<Json>;
  /** OWNER-R9: change a member's role (`POST /membership/role`). Server enforces who may. */
  setMemberRole?(companyUid: string, membershipKey: string, newRole: string): AdapterPromise<Json>;
  /** OWNER-R9: remove a member or revoke an invite (`POST /membership/revoke`). Server keeps the last owner. */
  revokeMembership?(companyUid: string, membershipKey: string): AdapterPromise<Json>;
  /** Company telemetry; `range` is a `YYYY-MM-DD` window (the host defaults to the last 30 days). */
  getTeamTelemetry(slug: string, range?: { from: string; to: string }): AdapterPromise<Json>;
  claimPendingInvite(slug: string): AdapterPromise<Json>;
  connectToCloud(slug: string): AdapterPromise<Json>;
  getSummary(slug: string): AdapterPromise<Json>;
  getBoard(slug: string): AdapterPromise<Json>;
  getActivity(slug: string): AdapterPromise<Json[]>;
  /**
   * Idempotent create-or-adopt of a company's single home channel
   * (`POST /v1/companies/{uid}/home-channel`). The server creates the
   * channel on the company's first call, or returns the existing one on any
   * later call — never duplicates it. Takes the company's cloud uid (not
   * slug) since callers already have it from the workspace roster.
   */
  ensureHomeChannel(companyUid: string): AdapterPromise<{ homeChannelId: string }>;
  /** Membership-scoped, aggregate eligibility for the first-week return nudge. */
  getFirstWeekReturnNudge(companyUid: string): AdapterPromise<Json>;
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

/**
 * Content digest for a vault PUT. hq-pro signs `x-amz-checksum-sha256` into
 * the upload URL only when `checksumSha256` (base64) matches the
 * `hq-content-sha256` metadata (hex) for the same bytes.
 */
export interface VaultPutIntegrity {
  /** SHA-256 of the bytes, base64 (S3's checksum form). */
  checksumSha256: string;
  /** SHA-256 of the bytes, lowercase hex. */
  contentSha256: string;
}

/** Presign request fields for {@link VaultPutIntegrity}. */
export function vaultPutIntegrityFields(
  integrity: VaultPutIntegrity | undefined,
): { checksumSha256?: string; metadata?: Record<string, string> } {
  if (!integrity) return {};
  return {
    checksumSha256: integrity.checksumSha256,
    metadata: { "hq-content-sha256": integrity.contentSha256 },
  };
}

/** A file in the Files explorer's answers (Rust `vault_index::FileHit`). */
export interface VaultFileHit {
  /** HQ-folder-relative, forward-slash path. */
  path: string;
  name: string;
  isMarkdown: boolean;
}

/** Vault home data (Rust `vault_index::VaultSummary`). */
export interface VaultSummaryWire {
  root: string;
  notes: number;
  files: number;
  links: number;
  /** The vault has more files than the index holds. */
  truncated: boolean;
  /** The notes the most other notes link to. */
  hubs: Array<{ path: string; count: number }>;
  /** Top-level folders by file count. */
  folders: Array<{ name: string; files: number }>;
}

/** Link context for one open note (Rust `vault_index::NoteLinks`). */
export interface VaultNoteLinks {
  resolved: Array<{ target: string; path: string | null }>;
  backlinks: VaultFileHit[];
  /** Total notes linking here; `backlinks` holds at most 200. */
  backlinkCount: number;
  outgoing: VaultFileHit[];
}

/** A note's text, capped for rendering (Rust `vault_index::NotePreview`). */
export interface VaultNotePreview {
  text: string;
  /** Full file size in bytes. */
  size: number;
  /** Only the start of the note is in `text`. */
  truncated: boolean;
}

/**
 * The Files explorer's questions about one vault. `root` is `""` (personal)
 * or `companies/<slug>`; `includeSystem` adds HQ scaffold and dotfiles. The
 * index lives in the native layer, so each answer is a few rows.
 */
export interface VaultApi {
  summary(root: string, includeSystem: boolean): AdapterPromise<VaultSummaryWire>;
  search(root: string, includeSystem: boolean, query: string): AdapterPromise<VaultFileHit[]>;
  noteLinks(
    root: string,
    includeSystem: boolean,
    path: string,
    targets: string[],
  ): AdapterPromise<VaultNoteLinks>;
  readNote(path: string): AdapterPromise<VaultNotePreview>;
  /** Bounded frontmatter-only read for list surfaces that need note metadata. */
  readFrontmatter(path: string): AdapterPromise<string>;
}

export interface AtlasLocalApi {
  /** District roots and direct children, `{ revision, complete, objects }`. */
  firstPage(companySlug: string): AdapterPromise<Json | null>;
  /** Every object under the districts, cached on disk by folder revision. */
  listing(companySlug: string): AdapterPromise<Json | null>;
  /** Text of one object under the districts (project PRDs). */
  readText(companySlug: string, key: string): AdapterPromise<string | null>;
}

/** Result of `FilesApi.createFile`. */
export interface CreatedFile {
  path: string;
  cloudSync: boolean;
}

export interface FilesApi {
  listDir(relPath: string): AdapterPromise<Json[]>;
  /** Files explorer vault index. Desktop only; hosts without it omit it. */
  vault?: VaultApi;
  getFileContent(path: string): AdapterPromise<string>;
  /**
   * Create a new text file at an HQ-relative path in the synced HQ folder
   * (QA-072). Refuses an existing file. `cloudSync` is true when the company
   * is cloud-backed and syncing, so HQ Sync carries the file to the vault.
   * Desktop only; hosts without it omit it.
   */
  createFile?(path: string, contents: string): AdapterPromise<CreatedFile>;
  /**
   * ACL-filtered vault browse (hq-pro GET /v1/files/list). Pass the previous
   * page's `cursor` to continue a listing.
   */
  listVaultPrefix(companyUid: string, prefix: string, cursor?: string): AdapterPromise<Json>;
  /**
   * OWNER-R17: who can open one vault path, with inherited grants and display
   * names (hq-pro GET /files/{companyUid}/acl/tree, the read the web console's
   * access panel uses). Read-only. Hosts without it omit it.
   */
  getAccessTree?(companyUid: string, prefix: string): AdapterPromise<Json>;
  /** OWNER-R17: the company's groups, for names (hq-pro GET /secrets/{companyUid}/groups). Read-only. */
  listAccessGroups?(companyUid: string): AdapterPromise<Json>;
  /**
   * Atlas map listing from the company folder synced to this machine
   * (QA-016). Desktop only. Each call resolves null when the company folder is
   * not on this machine; the caller then falls back to `listVaultPrefix`.
   */
  atlasLocal?: AtlasLocalApi;
  /** Presigned GET for a vault key (hq-pro POST /v1/files/presign). */
  presignVaultGet(companyUid: string, key: string): AdapterPromise<Json>;
  /**
   * Presigned PUT for a vault key (hq-pro POST /v1/files/presign).
   *
   * Pass `integrity` for every upload: vault buckets have S3 Object Lock, and
   * S3 refuses a PUT to a locked bucket unless it carries a signed content
   * checksum. Without it the byte upload fails with 400.
   */
  presignVaultPut(
    companyUid: string,
    key: string,
    contentType: string,
    integrity?: VaultPutIntegrity,
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

/**
 * Fleet-agent control plane (hq-pro `/v1/agents`, `/v1/telemetry/company`,
 * `/v1/fleet/.../owners`). Person JWTs: owner/admin for status, jobs, profile
 * mutations, stop/start/deprovision. `listMobileRoster` is member-safe.
 * Resume-job and run-now are machine-JWT only and are intentionally omitted.
 */
export interface AgentProfilePatch {
  displayName?: string;
  description?: string;
}

/** hq-pro personal Outpost routes (owner-scoped by the caller's token). */
export const OUTPOST_PATHS = {
  status: "/outpost/status",
  jobsStatus: "/outpost/jobs/status",
} as const;

/**
 * The body of an attach-Slack request. `returnTo: "desktop"` says the attach
 * was started from the desktop app: the server's Slack callback can then show
 * a small "done, go back to HQ Desktop" page instead of the console's setup
 * page. A server that does not know the field ignores it.
 */
export const SLACK_ATTACH_BODY = { returnTo: "desktop" } as const;

export const AGENT_PATHS = {
  provisionOptions: (companyUid: string) =>
    `/v1/agents/provision-options?companyUid=${encodeURIComponent(companyUid)}`,
  status: (agentUid: string, brain?: "grok" | "codex" | "claude") => {
    const path = `/v1/agents/${encodeURIComponent(agentUid)}/status`;
    return brain ? `${path}?brain=${encodeURIComponent(brain)}` : path;
  },
  jobs: (agentUid: string) =>
    `/v1/agents/${encodeURIComponent(agentUid)}/jobs`,
  pauseJob: (agentUid: string, jobId: string) =>
    `/v1/agents/${encodeURIComponent(agentUid)}/jobs/${encodeURIComponent(jobId)}/pause`,
  profile: (agentUid: string) =>
    `/v1/agents/${encodeURIComponent(agentUid)}/profile`,
  stop: (agentUid: string) =>
    `/v1/agents/${encodeURIComponent(agentUid)}/stop`,
  start: (agentUid: string) =>
    `/v1/agents/${encodeURIComponent(agentUid)}/start`,
  retryProvisioning: (agentUid: string) =>
    `/v1/agents/${encodeURIComponent(agentUid)}/retry`,
  reauth: (agentUid: string) =>
    `/v1/agents/${encodeURIComponent(agentUid)}/reauth`,
  loginCode: (agentUid: string) =>
    `/v1/agents/${encodeURIComponent(agentUid)}/login-code`,
  slackChannel: (agentUid: string) =>
    `/v1/agents/${encodeURIComponent(agentUid)}/channels/slack`,
  slackAppToken: (agentUid: string) =>
    `/v1/agents/${encodeURIComponent(agentUid)}/channels/slack/app-token`,
  deprovision: (agentUid: string, confirmDestroyInstanceId?: string | null) => {
    const path = `/v1/agents/${encodeURIComponent(agentUid)}`;
    const confirm = (confirmDestroyInstanceId ?? "").trim();
    return confirm
      ? `${path}?confirmDestroyAgentsV2=${encodeURIComponent(confirm)}`
      : path;
  },
  mobileRoster: (companyUid?: string | null) => {
    const uid = (companyUid ?? "").trim();
    return uid
      ? `/v1/agents/mobile-roster?companyUid=${encodeURIComponent(uid)}`
      : "/v1/agents/mobile-roster";
  },
  owners: (companyUid: string, agentUid: string) =>
    `/v1/fleet/${encodeURIComponent(companyUid)}/agents/${encodeURIComponent(agentUid)}/owners`,
  companyTelemetry: (companyUid: string, from: string, to: string) =>
    `/v1/telemetry/company?companyUid=${encodeURIComponent(companyUid)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  myTelemetry: (from: string, to: string) =>
    `/v1/telemetry/me?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
} as const;

/** One company's connected apps (hq-pro integrations-admin; any member may read). */
export const COMPANY_INTEGRATION_PATHS = {
  list: (companyUid: string) =>
    `/v1/integrations/admin?companyUid=${encodeURIComponent(companyUid)}`,
} as const;

/** The caller's personal integrations, as read by the console's Personal Integrations page. */
export const PERSONAL_INTEGRATION_PATHS = {
  googleAccounts: "/v1/google/accounts",
  slackAccounts: "/v1/slack/personal/accounts",
} as const;

export interface AgentProvisionSizeOption {
  key: "basic" | "power" | "dev";
  productName: string;
  instanceType: string;
  listCents: number;
  default: boolean;
  selectable: boolean;
  netMonthlyCents: number | null;
  deltaCents: number | null;
  unavailableReason: string | null;
  notBilled: boolean;
  lanes: number;
  workers: number;
}

export interface AgentProvisionOptionsView {
  defaultInstanceType: string;
  catalogVersion: string;
  options: readonly AgentProvisionSizeOption[];
}

/**
 * Raw hq-pro REST transport for framework-free clients (`@hq/agents`). Paths
 * are relative (`/v1/agents`); the adapter owns the base URL and the auth.
 * Non-2xx answers resolve with their status, never throw, so callers can read
 * the server's refusal body. Only a transport failure rejects.
 */
export type HqProFetch = (
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string> }>;

/**
 * Options for removing a cloud bot. The server refuses to remove a bot whose
 * machine is running unless the request names that machine. The refusal
 * carries the machine id (`AdapterFailure.instanceId`); the caller repeats the
 * request with it once the person has confirmed the removal.
 */
export interface AgentDeprovisionOptions {
  confirmDestroyInstanceId?: string | null;
}

export interface AgentsApi {
  /**
   * The REST transport `@hq/agents` runs on. Absent on adapters that cannot
   * reach hq-pro; callers keep their older path then.
   */
  fetch?: HqProFetch;
  /** GET /v1/agents/provision-options?companyUid= — tenant-priced sizes. */
  getProvisionOptions(
    companyUid: string,
  ): AdapterPromise<AgentProvisionOptionsView>;
  /** GET /v1/agents/{uid}/status — owner/admin. */
  getStatus(agentUid: string, brain?: "grok" | "codex" | "claude"): AdapterPromise<Json>;
  /** Start a fresh provider sign-in after a pairing link has expired. */
  restartBrainApproval?(agentUid: string, brain: "grok" | "codex" | "claude"): AdapterPromise<Json>;
  /** Submit Claude's browser-issued code to the waiting cloud bot. */
  submitClaudeLoginCode?(agentUid: string, code: string): AdapterPromise<Json>;
  /**
   * POST /v1/agents/{uid}/channels/slack with `{ returnTo: "desktop" }`:
   * start connecting the bot to Slack. Owner or admin only. NOT a probe: on
   * most companies it creates a real Slack app for the bot, so call it only
   * when a person asked. `returnTo` tells the server the attach was started
   * from the desktop app, so Slack's callback can send the person back here
   * instead of to the console's setup page (see {@link SLACK_ATTACH_BODY}).
   *
   * A failure carries the HTTP status (`status`), the server's `code`
   * (e.g. `SLACK_ATTACH_ALREADY_CONNECTED`, or `http-404` when the body has
   * none) and `upstreamCode` when the server sent one.
   */
  attachSlack(agentUid: string): AdapterPromise<Json>;
  /**
   * POST /v1/agents/{uid}/channels/slack/app-token with `{ appToken }`: hand
   * the server the app-level token a person made on Slack's site.
   *
   * The token is a secret. It travels in the request body and nowhere else:
   * never in the URL, a log line or a failure's text. A failure carries the
   * HTTP status and the server's `code` (e.g. `SLACK_APP_TOKEN_REJECTED`).
   */
  submitSlackAppToken(agentUid: string, appToken: string): AdapterPromise<Json>;
  /** GET /v1/agents/mobile-roster — member-safe directory. */
  listMobileRoster(companyUid?: string | null): AdapterPromise<Json>;
  /** GET /v1/agents/{uid}/jobs — owner/admin operator list. */
  listJobs(agentUid: string): AdapterPromise<Json>;
  /** POST /v1/agents/{uid}/jobs/{jobId}/pause — owner/admin. */
  pauseJob(agentUid: string, jobId: string): AdapterPromise<Json>;
  /** PATCH /v1/agents/{uid}/profile — owner/admin. */
  updateProfile(
    agentUid: string,
    patch: AgentProfilePatch,
  ): AdapterPromise<Json>;
  /** POST /v1/agents/{uid}/stop — pause the box. */
  stop(agentUid: string): AdapterPromise<Json>;
  /** POST /v1/agents/{uid}/start — resume a stopped box. */
  start(agentUid: string): AdapterPromise<Json>;
  /** POST /v1/agents/{uid}/retry: resume a failed provisioning attempt. */
  retryProvisioning(agentUid: string): AdapterPromise<Json>;
  /**
   * DELETE /v1/agents/{uid}: reverse deprovision / remove. Safe to repeat:
   * the answer carries `terminal: true` once nothing is left to remove.
   */
  deprovision(
    agentUid: string,
    options?: AgentDeprovisionOptions,
  ): AdapterPromise<Json>;
  /** GET /v1/fleet/{companyUid}/agents/{uid}/owners. */
  listOwners(companyUid: string, agentUid: string): AdapterPromise<Json>;
  /** GET /v1/telemetry/company?companyUid=&from=&to= — owner/admin. */
  getCompanyTelemetry(
    companyUid: string,
    from: string,
    to: string,
  ): AdapterPromise<Json>;
  /**
   * GET /v1/telemetry/me?from=&to= — the caller's own cross-company rollups
   * (daily series + totals). Optional so older test doubles stay valid.
   */
  getMyTelemetry?(from: string, to: string): AdapterPromise<Json>;
  /**
   * OWNER-R27: session history recorded on this Mac in the HQ workspace
   * folder (workspace/sessions + workspace/threads), newest first. Native
   * hosts only; `from`/`to` are YYYY-MM-DD.
   */
  listLocalSessions?(
    range: { from: string; to: string },
    page?: { offset?: number; limit?: number },
  ): AdapterPromise<Json>;
  /**
   * POST /outpost/status — the caller's own Outpost row (state, region,
   * instance state, telemetry timestamps). A 404 failure means no Outpost.
   */
  getMyOutpostStatus?(): AdapterPromise<Json>;
  /** GET /outpost/jobs/status — the caller's scheduled-job status rows. */
  listMyOutpostJobs?(): AdapterPromise<Json>;
  /** GET /v1/google/accounts — the caller's connected Google accounts. */
  listMyGoogleAccounts?(): AdapterPromise<Json>;
  /** GET /v1/slack/personal/accounts — the caller's personal Slack accounts. */
  listMySlackAccounts?(): AdapterPromise<Json>;
}

/**
 * hq-pro routes for a company's connected apps. Served by the same API as the
 * agent and messaging routes, so every adapter reaches them the way it
 * reaches `AGENT_PATHS`.
 */
export const INTEGRATION_PATHS = {
  /**
   * The summary view (`view=summary`): the same connections, `access`,
   * `viewer` and audit rows as the full view, without write policy, tool
   * grants, Slack destinations, creator names or audit actor names, which
   * the bot cards and hello never read. The full view took 7 to 9 s for a
   * company with 135 connections. An older server ignores the parameter and
   * answers with the full view, which reads the same.
   */
  connections: (companyUid: string) =>
    `/v1/integrations/admin?companyUid=${encodeURIComponent(companyUid)}&view=summary`,
  grantAccess: "/v1/integrations/factory/access/grant",
  /** The catalog of apps HQ can connect. `limit` is left out when not given; the server bounds it to 1..100. */
  catalog: (companyUid: string, query: string, limit?: number) =>
    `/v1/integrations/factory/catalog?companyUid=${encodeURIComponent(companyUid)}` +
    `&query=${encodeURIComponent(query)}` +
    (typeof limit === "number" && Number.isFinite(limit) ? `&limit=${Math.trunc(limit)}` : ""),
  oauthStart: "/v1/integrations/factory/oauth/start",
  install: "/v1/integrations/factory/install",
  blueprint: "/v1/integrations/factory/blueprint",
} as const;

/** One row of the integration catalog, as the server sends it. Every field may be missing. */
export interface IntegrationCatalogEntry {
  name?: string;
  domain?: string;
  description?: string;
  mcpReady?: boolean;
  /** How the app connects. Missing when the server does not know. */
  authClass?: "none" | "oauth" | "key";
  source?: string;
  /** Opaque id of a curated or community entry. The cleanest handle for install and OAuth. */
  entryId?: string;
}

/** Names the app to connect: by catalog entry when the catalog gave one, else by its website domain. */
export interface IntegrationAppRef {
  companyUid: string;
  domain?: string;
  catalogEntryId?: string;
}

/**
 * The body that names an app for OAuth start and for a blueprint: the
 * company and exactly the handle given, nothing else. In particular no
 * `redirectUri`, so the server's default redirect applies.
 */
export function integrationAppRefBody(input: IntegrationAppRef): {
  companyUid: string;
  domain?: string;
  catalogEntryId?: string;
} {
  return {
    companyUid: input.companyUid,
    ...(input.catalogEntryId ? { catalogEntryId: input.catalogEntryId } : {}),
    ...(input.domain && !input.catalogEntryId ? { domain: input.domain } : {}),
  };
}

/** What `POST /v1/integrations/factory/oauth/start` answers. */
export interface IntegrationOAuthStart {
  provider: string;
  displayName: string;
  /** The provider's own sign-in page. Opened in the system browser. */
  authorizationUrl: string;
  state: string;
  expiresAt: string;
}

/**
 * The body of `POST /v1/integrations/factory/install`, passed through as it
 * is. Three forms, read from hq-pro `origin/main`
 * `src/vault-service/handlers/integrations-admin.ts`:
 *
 * - `{ companyUid, domain }` (3556-3600): an app that needs no credentials.
 *   The server resolves the domain's MCP surface and probes it without auth;
 *   a `bearerToken` on this form is NOT read.
 * - `{ companyUid, catalogEntryId, bearerToken? }` (3513-3550): a catalog
 *   entry; the server supplies the MCP URL and name and reads `bearerToken`
 *   only when the entry's `authClass` is `key`.
 * - `{ companyUid, mcpUrl, authMode: "bearer", bearerToken, authScheme?, provider?, displayName?, domain? }`
 *   (3059-3170, `installDirectMcpIntegration`): a key app named by its MCP
 *   URL, which comes from the blueprint (see {@link IntegrationsApi.blueprint}).
 */
export interface IntegrationInstallInput {
  companyUid: string;
  domain?: string;
  catalogEntryId?: string;
  mcpUrl?: string;
  authMode?: "none" | "bearer";
  /** A pasted key. A secret: it travels in the body and nowhere else. */
  bearerToken?: string;
  authScheme?:
    | { placement: "authorization"; format: "bearer" }
    | { placement: "authorization"; format: "prefix"; prefix: string }
    | { placement: "authorization"; format: "basic"; username?: string }
    | { placement: "header"; header: string };
  provider?: string;
  displayName?: string;
}

/** Who gets to use a connection. A bot's uid is granted as a person. */
export interface ConnectionAccessGrant {
  companyUid: string;
  connectionId: string;
  /** A person uid, or a bot's `agt_` uid. */
  granteeUid: string;
}

/**
 * The request body of a connection grant. `permission` is left out so the
 * server applies its default.
 */
export function connectionGrantBody(input: ConnectionAccessGrant): {
  companyUid: string;
  connectionId: string;
  granteeType: "person";
  granteeId: string;
} {
  return {
    companyUid: input.companyUid,
    connectionId: input.connectionId,
    granteeType: "person",
    granteeId: input.granteeUid,
  };
}

/** A company's connected apps (HQ Integrations). */
export interface IntegrationsApi {
  /**
   * GET /v1/integrations/admin?companyUid=&view=summary: the company's connections, each
   * with its status and who may use it, plus what the caller may manage.
   */
  listConnections(companyUid: string): AdapterPromise<Json>;
  /**
   * POST /v1/integrations/factory/access/grant: let one person or bot use a
   * connection. Only the person who connected it or a company admin may.
   */
  grantConnectionAccess(input: ConnectionAccessGrant): AdapterPromise<Json>;
  /**
   * GET /v1/integrations/factory/catalog?companyUid=&query=&limit=: the apps
   * HQ can connect that match `query`. Owner or admin only; anyone else gets
   * a 403 with code `INTEGRATION_FACTORY_FORBIDDEN`. Answers
   * `{ ok, companyUid, entries: IntegrationCatalogEntry[] }`. A failure
   * carries the HTTP status (`status`) and the server's `code`.
   */
  catalogSearch(companyUid: string, query: string, limit?: number): AdapterPromise<Json>;
  /**
   * POST /v1/integrations/factory/oauth/start with `{ companyUid, domain }`
   * or `{ companyUid, catalogEntryId }` and no `redirectUri`: the server's
   * default redirect lands the browser on the console's callback. Answers
   * {@link IntegrationOAuthStart}. A failure carries `status`, `code` (e.g.
   * `OAUTH_DISCOVERY_FAILED`, `CLIENT_REGISTRATION_REFUSED`,
   * `OAUTH_REGISTRATION_FAILED`, `INTEGRATION_FACTORY_FORBIDDEN`) and
   * `upstreamCode` when the server sent one.
   */
  startOAuth(input: IntegrationAppRef): AdapterPromise<IntegrationOAuthStart>;
  /**
   * POST /v1/integrations/factory/install with the body passed through (see
   * {@link IntegrationInstallInput} for the three forms). A `bearerToken` is
   * sent in the body only and is taken out of any failure's text. A failure
   * carries `status` and `code` (e.g. 402 plan limit, 409
   * `INTEGRATION_FACTORY_INSTALL_IN_PROGRESS`).
   */
  install(input: IntegrationInstallInput): AdapterPromise<Json>;
  /**
   * POST /v1/integrations/factory/blueprint with `{ companyUid, domain }` or
   * `{ companyUid, catalogEntryId }`: what an app needs before it is
   * connected. Owner or admin only.
   *
   * VERIFIED against hq-pro `origin/main`
   * `src/vault-service/handlers/integrations-admin.ts`: the route is at
   * 1231-1246 and `pullIntegrationsShBlueprint` at 2953-3057. The answer is
   * `{ ok: true, companyUid, blueprint, pullPlan }` (2986-2990, 3021-3027,
   * 3040-3044); a catalog entry or a curated domain answers from HQ's own
   * catalog first, anything else from integrations.sh. `blueprint` is
   * `IntegrationBlueprint` from
   * `src/integration-factory/blueprints/integrations-sh.ts:129-162`:
   * `{ provider, displayName, domain, credentials: IntegrationsShCredential[],
   * surfaces: IntegrationsShSurface[], recommendedSurface?, warnings, ... }`.
   *
   * For a key app the pieces come from:
   * - `mcpUrl`: the `url` of `recommendedSurface` when its `kind` is `"mcp"`,
   *   else of the first surface whose `kind` is `"mcp"`
   *   (`src/integration-factory/installations.ts:317-329`,
   *   `installableRemoteMcpSurface`, the same rule the server installs by).
   * - the credential `label` and `generateUrl`: `credentials[]` entries
   *   `{ id, type, label, generateUrl?, setup?, acquisition? }`
   *   (integrations-sh.ts:83-90, parsed at 843-853: `label` falls back to
   *   the id). The surface's `credentialIds` (integrations-sh.ts:106) name
   *   which credential it uses.
   *
   * hq-cli `origin/main` `src/commands/integrations-connect.ts:1391-1428`
   * (`inspect`) prints exactly these: `blueprint.displayName`,
   * `blueprint.domain`, each surface, and `credential.label` with
   * `credential.generateUrl`; it reads the body's `blueprint` field
   * (`src/commands/integrations-api.ts:104-117`, `pullBlueprint`).
   */
  blueprint(input: IntegrationAppRef): AdapterPromise<Json>;
}

export interface FeedbackApi {
  submitBugReport(title: string, body: string): AdapterPromise<Json>;
}

/** Desktop-only group (capability: canSync). */
export interface SyncApi {
  startDaemon(): AdapterPromise<void>;
  stopDaemon(): AdapterPromise<void>;
  daemonStatus(): AdapterPromise<DaemonStatus>;
  daemonSyncStatus(): AdapterPromise<DaemonSyncStatus | null>;
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
  /**
   * Open a validated `codex://` deep link (typically
   * `codex://threads/new?prompt=…`) so the ChatGPT desktop app's Codex area
   * receives an install prompt in its composer. Mirrors
   * `openClaudeCodeLink`: the renderer builds a fixed URL from a pinned
   * constant, the host validates byte-for-byte and dispatches via the OS
   * URL opener.
   */
  openCodexDeepLink(url: string): AdapterPromise<void>;
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
  consumePendingRoute(): AdapterPromise<string | null>;
  takePendingMessagesTarget(): AdapterPromise<Json | null>;
  setActiveCompany(slug: string): AdapterPromise<void>;
  /**
   * The company the native read gate is bound to, or null. A surface that
   * binds a company for one read puts this back afterwards. Hosts without a
   * native gate omit it.
   */
  getActiveCompany?(): AdapterPromise<string | null>;
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
  /**
   * Append one greppable, tagged line to the desktop support log
   * (`~/.hq/logs/hq-sync.log` on the desktop host, `ui:{tag} {message}`).
   * Diagnostic only — best-effort, never throws. Hosts without a real log
   * file (e.g. web) fall back to console output.
   */
  logToFile(tag: string, message: string): AdapterPromise<void>;
}

/** Desktop-only group (capability: canSelfUpdate). */
/** Gate status payload from update_gate_status command. */
export interface UpdateGateStatus {
  pendingVersion: string | null;
  decision: unknown;
  reasons: string[];
  focused: boolean;
}

export interface UpdatesApi {
  getVersions(): AdapterPromise<VersionInfo>;
  checkForUpdates(): AdapterPromise<Json>;
  installUpdate(): AdapterPromise<void>;
  /** Queued update, phase 1: verify + download in the background (progress
   *  arrives on the host `update:progress` event), staging the package. */
  downloadUpdate(): AdapterPromise<Json>;
  /** Queued update, phase 2: install the staged package and restart. */
  installDownloadedUpdate(): AdapterPromise<void>;
  /** The staged-but-not-installed package, if any (hydrates "Restart to update"). */
  getDownloadedUpdate(): AdapterPromise<Json | null>;
  getPendingUpdate(): AdapterPromise<Json | null>;
  checkCoreState(): AdapterPromise<Json>;
  installCoreUpdate(): AdapterPromise<void>;
  replaceFromStaging(): AdapterPromise<void>;
  checkCliUpdate(): AdapterPromise<Json>;
  installCliUpdate(): AdapterPromise<void>;
  dismissCliUpdate(): AdapterPromise<void>;
  availableChannels(): AdapterPromise<string[]>;
  /** Query the focus+hold gate state (and pending version). */
  queryUpdateGate(): AdapterPromise<UpdateGateStatus>;
  /** Install the deferred pending update (blocked while any hold is active). */
  installPendingUpdate(): AdapterPromise<void>;
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

/** Desktop-only group: install + sign in to the local agent CLIs. */
export type SessionProviderId = "claude" | "codex" | "grok";

export interface SessionsApi {
  /** CLI installed + signed-in flags, for Settings → AI tools and Bots. */
  preflight?(): AdapterPromise<Json>;
  slashCommands?(tool: SessionProviderId): AdapterPromise<Json>;
  installProvider?(tool: SessionProviderId): AdapterPromise<string>;
  /**
   * Open the vendor CLI's browser sign-in. `force` signs out first and signs
   * in again even when the CLI still reports a saved login (a dead login
   * `auth status` cannot see).
   */
  loginStart?(tool: SessionProviderId, opts?: SessionLoginStartOptions): AdapterPromise<Json>;
  loginStatus?(tool: SessionProviderId): AdapterPromise<Json>;
  loginCancel?(tool: SessionProviderId): AdapterPromise<Json>;
}

export interface SessionLoginStartOptions {
  force?: boolean;
}

/**
 * Set by `hq bot list` when the bot's last model turn failed because its
 * runtime CLI's sign-in is missing or expired. The bot pauses and retries on
 * its own; a restart makes it retry at once. Absent or null once a turn works.
 */
export interface LocalBotRuntimeSignIn {
  state: "expired";
  runtime: "claude" | "codex" | "grok";
  /** ISO time the sign-in was first seen expired. */
  since: string;
}

/** A personal local bot (local-bots US-009) as reported by `hq bot list --json`. */
export interface LocalBotRow {
  /** Absent on older CLI versions; cloud only after verified activation. */
  hosting?: "local" | "cloud";
  /** The handle: the bot's folder name and what every mention resolves to. */
  name: string;
  /**
   * Free-form label ("Dr Love") when the bot has one. Absent on every CLI
   * that reports only the handle, which is why the app also keeps its own
   * copy (`chat/bot-display-names.ts`); readers fall back to `name`.
   */
  displayName?: string;
  agentUid: string;
  ownerUid: string;
  runtime: "claude" | "codex" | "grok";
  /** Model override; absent = the runtime CLI's own default for the owner's account. */
  model?: string;
  /** Thinking level the bot runs with (`hq bot list` reports the effective value). */
  effort?: string;
  /** True when no thinking level was picked, so `effort` is the default. */
  effortIsDefault?: boolean;
  /** Local process state: running | stopped | failed. */
  state: string;
  pid: number | null;
  processAlive: boolean;
  /** Durable local handoff hold; null destination means it could not be verified. */
  promotionHold?: { companyUid: string | null } | null;
  /** Server-side liveness (heartbeat < 90 s); null when hq-pro was unreachable. */
  online: boolean | null;
  lastHeartbeatAt: string | null;
  /**
   * The bot is mid-turn right now: it took a message and has not finished
   * answering. The CLI reads this from the bot's own in-flight marker on this
   * machine, so it is true while the model is still thinking and nothing has
   * been posted yet, and stays true across an interim progress post. Absent on
   * older CLI versions — treat as unknown, not idle.
   */
  busy?: boolean;
  /** When the oldest turn still in flight started (ISO); null when idle. */
  busySince?: string | null;
  daemonInstalled: boolean;
  daemonLoaded: boolean;
  dir: string;
  /** Configured memory folder, reported by the supervisor; may be absolute for Mac-only memory. */
  memoryDir?: string;
  /** Set when the bot was created from a company/core worker (`--worker`). */
  workerId?: string;
  companySlug?: string;
  /**
   * Bot kind (bot-kinds): `personal` acts as its owner and stays on this Mac;
   * `company` acts as itself inside its companies and can be promoted.
   * Absent on older CLI versions.
   */
  kind?: LocalBotKind;
  /** Company slugs a company bot belongs to (absent for personal bots / older CLI). */
  companies?: string[];
  /** Present while the runtime CLI needs the person to sign in again. */
  runtimeSignIn?: LocalBotRuntimeSignIn | null;
}

/**
 * A local bot this ACCOUNT owns, as `hq bot list --remote --json` reports it.
 *
 * `hq bot list` only knows this computer. A reinstall, a wiped `~/.hq`, or a
 * second Mac leaves the cloud half of a bot intact and the local half gone, so
 * the local listing is empty while the person still owns the bot — which is
 * how a bot's DM came to sit under a spinner for 41 s while its own setup said
 * it could not run here. `here` is the flag that tells the two apart.
 */
export interface RemoteBotRow {
  /** Local folder name (what `adopt`/`start` take). */
  name: string;
  agentUid: string;
  /** `personal` | `company`, as the cloud record has it. */
  kind: string;
  online: boolean;
  lastHeartbeatAt: string | null;
  /** True when this bot is set up on THIS computer. */
  here: boolean;
  /**
   * True when THIS computer could run the bot at all.
   *
   * A company bot's identity lives in HQ Cloud and its runtime refuses to
   * start as a personal local bot, so bringing it "back" to a Mac creates
   * credentials, a state directory and a startup agent for something that can
   * never run (round 4, Defect 7). Absent on a CLI that does not send it yet
   * — `remoteBotRunnableHere` falls back to `kind` then.
   */
  runnable?: boolean;
  /**
   * Why `runnable` is false, as the CLI names it (`company-bot`, and
   * `not-runnable-here` from a refused adopt/restore). Never rendered: it
   * selects one of the app's own written sentences.
   */
  reason?: string;
  /** One-line description of the settings it would come back with. */
  settings: string;
}

/** One bot's outcome in `hq bot restore --json`. */
export interface BotRestoreRow {
  name: string;
  agentUid: string;
  /** `restored` = brought back here; `repaired` = new credentials for one already here. */
  action:
    | "restored"
    | "repaired"
    | "skipped"
    | "failed"
    | "would-restore"
    | "would-repair"
    | "would-skip";
  /** The CLI's own words — logged and counted, never rendered verbatim. */
  detail: string;
  /**
   * Machine-readable reason for a row the CLI refused (`not-runnable-here`
   * for a company bot). Absent on a CLI that does not send it yet; it selects
   * one of the app's own written sentences, and is never rendered.
   */
  reason?: string;
}

/** `hq bot restore [--all] --json`. */
export interface BotRestoreResult {
  ok: boolean;
  dryRun: boolean;
  restored: number;
  repaired: number;
  skipped: number;
  failed: number;
  bots: BotRestoreRow[];
}

/** `hq bot create --kind`: personal bots act as the owner; company bots act as themselves. */
export type LocalBotKind = "personal" | "company";

/** A worker a bot can be created from (`hq bot workers --json`). */
export interface LocalBotWorkerOption {
  id: string;
  /** hqRoot-relative worker folder. */
  path: string;
  company?: string;
  description?: string;
  type?: string;
  /** Human name from worker.yaml; falls back to a title-cased id. */
  name?: string;
  /** Curated one-liner from worker.yaml `summary:`; else the first sentence of `description`. */
  summary?: string;
  /** Number of skills the worker ships. */
  skillCount?: number;
  /** Whether the worker is an HQ core template or a company one. */
  source?: "core" | "company";
}

/** Input to `LocalBotsApi.create` — mirrors `hq bot create` flags. */
export interface LocalBotCreateInput {
  name: string;
  runtime: "claude" | "codex" | "grok";
  /** Optional model override passed to the runtime CLI. */
  model?: string;
  /** Pre-approve every tool/command (default true; headless bots cannot prompt). */
  autoApprove?: boolean;
  /** Create the bot from this worker id instead of a fresh persona. */
  worker?: string;
  /** Optional first message the bot sends when it comes online (≤ 500 chars). */
  intro?: string;
  /**
   * Optional first task (≤ 2000 chars): right after the intro, on first start
   * only, the bot runs one model turn on this prompt as if the owner sent it
   * and DMs the answer (`hq bot create --kickoff`).
   */
  kickoff?: string;
  /** Where the bot's memory lives: HQ-synced (default) or this Mac only. */
  memory?: "synced" | "local";
  /** Personal (acts as the owner) or company (acts as itself); `hq bot create --kind`. */
  kind?: LocalBotKind;
  /** Company slugs for a company bot — one `--company <slug>` each; required when kind is company. */
  companies?: string[];
  /**
   * The human name people see ("Pickles"), `hq bot create --display-name`.
   * The handle (`name`) stays the key; an hq CLI too old for the flag creates
   * the bot without it.
   */
  displayName?: string;
}

/**
 * Desktop-only group (local-bots US-009): personal bots that run on THIS
 * computer under the user's own model login. Every call shells to the hq CLI
 * through the host's launch boundary; nothing here talks to hq-pro directly.
 */
export interface LocalBotsApi {
  list(): AdapterPromise<{ bots: LocalBotRow[] }>;
  create(input: LocalBotCreateInput): AdapterPromise<Json>;
  /** Workers a bot can be created from; optional for older hosts. */
  workers?(): AdapterPromise<{ workers: LocalBotWorkerOption[] }>;
  start(name: string): AdapterPromise<Json>;
  stop(name: string): AdapterPromise<Json>;
  remove(name: string): AdapterPromise<Json>;
  /**
   * Change what a bot thinks with (`hq bot set`), from its next message.
   * A field left out is unchanged; `null` resets it to the default.
   * Optional for older hosts.
   */
  configure?(name: string, settings: LocalBotSettingsInput): AdapterPromise<Json>;
  promote?(name: string, companyUid: string): AdapterPromise<Json>;
  /**
   * The local bots this ACCOUNT owns, each flagged `here` or not
   * (`hq bot list --remote`). The one source of truth for "the person owns
   * this bot and this computer cannot run it". Optional: older hosts and the
   * web build have no such command, and callers fall back to the local list.
   */
  listRemote?(): AdapterPromise<{ bots: RemoteBotRow[] }>;
  /**
   * Bring ONE owned bot back to this computer and start it
   * (`hq bot adopt <name>`): new machine credentials, its saved settings, its
   * worker folder and startup agent. Optional for older hosts.
   */
  adopt?(name: string): AdapterPromise<Json>;
  /**
   * Bring back EVERY owned bot that is not set up here (`hq bot restore`);
   * `all` additionally repairs the ones that are. Optional for older hosts.
   */
  restore?(options?: { all?: boolean }): AdapterPromise<BotRestoreResult>;
}

/** Input to `LocalBotsApi.configure`. */
export interface LocalBotSettingsInput {
  model?: string | null;
  effort?: string | null;
}

/** Local per-platform settings. */
export interface SettingsApi {
  getConfig(): AdapterPromise<Json>;
  getSettings(): AdapterPromise<Json>;
  /** Persist a minimal patch over the latest host settings. */
  updateSettings(patch: Json): AdapterPromise<void>;
  getSetupStatus(): AdapterPromise<Json>;
  /**
   * The welcome channel's guided setup finished on this machine. Optional:
   * hosts without a native settings store have nothing to record.
   */
  markWelcomeSetupComplete?(): AdapterPromise<void>;
  /**
   * The desktop window's first-run guided tour started showing on this
   * machine. Optional: hosts without a native settings store fall back to
   * local storage.
   */
  markWelcomeTourShown?(): AdapterPromise<void>;
  getTelemetryConsent(): AdapterPromise<boolean | null>;
}

/**
 * Optional destination binding for cross-company session migrate (US-017B).
 * Empty `{}` leaves project/task unset on the destination copy.
 */
export interface MigrateSessionDestination {
  projectId?: string;
  taskId?: string;
}

/**
 * Body for POST /v1/work-mesh/sessions/{sessionId}/migrate.
 * This is the only desktop client path that rebinds a session across companies.
 */
export interface MigrateSessionRequest {
  operationId: string;
  digest: string;
  sourceCompanyUid: string;
  destinationCompanyUid: string;
  destination: MigrateSessionDestination;
  expectedVersion: number;
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
  createProjectStory?(projectId: string, companyUid: string, story: {
    id: string; title: string; description: string; status: string; passes: boolean;
  }): AdapterPromise<Json>;
  putProjectView?(projectId: string, companyUid: string, view: Json): AdapterPromise<Json>;
  readLocalSnapshot(): AdapterPromise<Json>;
  /** hq-pro GET /v1/work-mesh/projects/{id}?companyUid= is required. */
  getProjectView(projectId: string, companyUid?: string): AdapterPromise<Json>;
  /**
   * Cross-company session migrate (US-017A/B).
   * POST /v1/work-mesh/sessions/{sessionId}/migrate — only rebind path.
   */
  migrateSession(
    sessionId: string,
    body: MigrateSessionRequest,
  ): AdapterPromise<Json>;
  /**
   * hq-pro GET /v1/work-mesh/threads?companyUid=&projectId= — the work threads
   * of one project. Additive: hosts that cannot reach hq-pro return
   * unavailable, and the project channel simply shows chat only.
   */
  listProjectThreads(
    projectId: string,
    companyUid: string,
    cursor?: string,
  ): AdapterPromise<Json>;
  /**
   * hq-pro GET /v1/work-mesh/threads/{threadId}/events?companyUid= — the
   * append-only event log of one thread (v1 envelope today, v2 session events
   * once Work Mesh Live is enabled; both are parsed by @hq/ui).
   */
  listThreadEvents(
    threadId: string,
    companyUid: string,
    since?: string,
  ): AdapterPromise<Json>;
}

// ---------------------------------------------------------------------------
// Calls (native Meet, contract "hq-meet/1") — US-014
// ---------------------------------------------------------------------------

/** Room lifecycle POSTs under /v1/meet-native/rooms/{roomId}/{action}. */
export type RoomLifecycleAction = "renew" | "leave" | "end" | "start";

/** Knock responses under /v1/meet-native/knocks/{knockId}/{action}. */
export type KnockAction = "accept" | "decline" | "defer" | "cancel";

/** Signed control operations under /v1/meet-native/signaling/{operation}. */
export type SignalingOperation = "admit" | "renew" | "reconcile" | "revoke";

/** Signed completion operations under /v1/meet-native/completion/{operation}. */
export type CompletionOperation =
  | "create"
  | "claim"
  | "status"
  | "upload"
  | "finalize";

/** Paging controls for `discoverOffice`. Both are optional. */
export interface OfficeDiscoverOptions {
  /** 1..OFFICE page size (25). Omit for the service default. */
  limit?: number;
  /** Opaque continuation token from a previous page's `cursor`. */
  cursor?: string;
}

export interface OfficePreferenceInput {
  companyUid: string;
  willingness: string;
  ttlMs?: number;
}

export interface OfficeConnectivityInput {
  companyUid: string;
  connectivity: string;
  ttlMs?: number;
}

export interface CreateRoomInput {
  companyUid: string;
  visibility: "company" | "private";
  /** Defaults to [] — the service rejects more than 7. */
  cohosts?: string[];
}

export interface KnockCreateInput {
  companyUid: string;
  roomId: string;
  callId: string;
  epoch: number;
  target: string;
  note: string;
  idempotencyKey: string;
}

/** POST /v1/meet-native/signaling/send — a signed signal envelope. */
export interface SendSignalRequest {
  signal: Json;
  signature: string;
}

/**
 * Native calling (hq-pro "hq-meet/1").
 *
 * Two invariants the type cannot express but every implementation honours:
 *
 *  1. `preflight()` must record a passing US-011 service evidence receipt on
 *     this adapter instance before any other method does anything. Until then
 *     they all resolve `unavailable` with code "CALLS_PREFLIGHT_REQUIRED".
 *  2. Hosts without native calling (browsers) implement the whole group as
 *     `unavailable` with code "CALLS_UNSUPPORTED_HOST" — never a stub `ok()`.
 *
 * Request bodies carry `version: "hq-meet/1"`; failures preserve the backend
 * error `code` (COMPANY_ACCESS_DENIED, STALE_EPOCH, CALL_SEALED, ...).
 */
export interface CallsApi {
  /** The contract version this adapter speaks. */
  readonly contractVersion: "hq-meet/1";
  /**
   * Validate a US-011 service evidence receipt and, on success, unlock this
   * adapter instance. A failing receipt clears any previous pass.
   */
  preflight(
    evidence: unknown,
    options?: EvidenceOptions,
  ): AdapterPromise<ServiceEvidence>;
  /** The recorded evidence, or the standard refusal when preflight has not passed. */
  preflightStatus(): AdapterResult<ServiceEvidence>;

  /**
   * One page of the company office directory. `options.cursor` continues a
   * previous page; `options.limit` is bounded by the service page size.
   */
  discoverOffice(
    companyUid: string,
    options?: OfficeDiscoverOptions,
  ): AdapterPromise<Json>;
  setOfficePreference(input: OfficePreferenceInput): AdapterPromise<Json>;
  setOfficeConnectivity(input: OfficeConnectivityInput): AdapterPromise<Json>;

  createRoom(input: CreateRoomInput): AdapterPromise<Json>;
  getRoom(roomId: string, companyUid: string): AdapterPromise<Json>;
  /** Body is an `admission` envelope. */
  joinRoom(roomId: string, admission: Json): AdapterPromise<Json>;
  roomLifecycle(
    roomId: string,
    action: RoomLifecycleAction,
    body: Json,
  ): AdapterPromise<Json>;

  createKnock(input: KnockCreateInput): AdapterPromise<Json>;
  listKnocks(companyUid: string, limit?: number): AdapterPromise<Json>;
  getKnock(knockId: string, companyUid: string): AdapterPromise<Json>;
  respondToKnock(
    knockId: string,
    action: KnockAction,
    companyUid: string,
  ): AdapterPromise<Json>;

  /** Body is a signed `control` envelope. */
  signalingControl(
    operation: SignalingOperation,
    control: Json,
  ): AdapterPromise<Json>;
  sendSignal(request: SendSignalRequest): AdapterPromise<Json>;
  /** Body is a signed `iceConfig` envelope. Credentials never enter logs. */
  iceConfig(request: Json): AdapterPromise<Json>;

  /** Durable native live transcript ingress; bearer stays in the native host. */
  liveTranscript(operation: "begin" | "append" | "read" | "list" | "session", request: Json): AdapterPromise<Json>;

  /** Body is a signed `consentControl` envelope. */
  completionConsent(control: Json): AdapterPromise<Json>;
  /** Body is a signed `completionControl` envelope. */
  completion(
    operation: CompletionOperation,
    control: Json,
  ): AdapterPromise<Json>;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export interface PlatformAdapter {
  /** Which host this adapter targets. */
  readonly kind: "web" | "desktop";
  /** Release any host-owned process registrations when the adapter is torn down. */
  readonly dispose?: () => Promise<void>;
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
  readonly agents: AgentsApi;
  readonly integrations: IntegrationsApi;
  readonly feedback: FeedbackApi;
  readonly sync: SyncApi;
  readonly shell: ShellApi;
  readonly appShell: AppShellApi;
  readonly updates: UpdatesApi;
  readonly packages: PackagesApi;
  readonly sessions: SessionsApi;
  /** Optional: only the desktop host can run bots on this machine. */
  readonly bots?: LocalBotsApi;
  readonly settings: SettingsApi;
  readonly workMesh: WorkMeshApi;
  /** Native calling (US-014). Unsupported hosts implement it as refusals. */
  readonly calls: CallsApi;
}

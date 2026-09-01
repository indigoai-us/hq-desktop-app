/**
 * WebPlatformAdapter — implements PlatformAdapter against the hq-pro REST API.
 *
 * Cloud-available methods issue HTTP requests via an injectable `fetch`.
 * Desktop-only capabilities return the standard `unavailable` result with
 * code "desktop-only". Methods whose backing API does not exist yet return
 * `unavailable` with code "not-yet-implemented-api".
 */

import {
  buildReplyThreadPath,
  buildSendReplyRequest,
  failure,
  normalizeReplyThreadValue,
  ok,
  unavailable,
  validateFetchReplyThread,
  validateSendReply,
  type AdapterFailure,
  type AdapterPromise,
  type AdapterResult,
  type Json,
  type PlatformAdapter,
} from "../adapter.js";
import { WEB_CAPABILITIES, type Capability } from "../capabilities.js";
import {
  parseShelfViewer,
  parseSkillPath,
  scopedSkillsFromShelf,
  skillDetailFromShelf,
  type LibrarySkillWire,
} from "../library-shelf.js";

/** Provisional hq-pro REST paths, centralized so they are easy to correct. */
export const WEB_PATHS = {
  whoami: "/v1/identity/whoami",
  isAdmin: "/v1/identity/is-admin",
  hasFeature: (flag: string) =>
    `/v1/identity/features/${encodeURIComponent(flag)}`,

  channels: "/v1/messaging/channels",
  channelDirectory: "/v1/notify/channels",
  contacts: "/v1/notify/contacts",
  dmRequests: "/v1/notify/connections/requests",
  markChannelRead: (id: string) =>
    `/v1/notify/channels/${encodeURIComponent(id)}/read`,
  /** GET two-way DM history. */
  dmThread: "/v1/notify/thread",
  /** POST body `{ withPersonUid }` — pair lastReadAt (US-010). */
  markDmThreadRead: "/v1/notify/thread/read",
  searchMessages: "/v1/messaging/search",
  /** Canonical roster: uid + live companyName. Not written into work-mesh. */
  workspaces: "/membership/me",
  channel: (id: string) => `/v1/notify/channels/${encodeURIComponent(id)}`,
  channelMembers: (id: string) =>
    `/v1/notify/channels/${encodeURIComponent(id)}/members`,
  channelMember: (id: string, personUid: string) =>
    `/v1/notify/channels/${encodeURIComponent(id)}/members/${encodeURIComponent(personUid)}`,
  /** GET/PUT the caller's editable global member profile. */
  profile: "/v1/profile",
  channelMessages: (id: string) =>
    `/v1/notify/channels/${encodeURIComponent(id)}/messages`,
  /** Reply thread (plural). Distinct from GET /v1/notify/thread (1:1 DM). */
  replyThreads: "/v1/notify/threads",
  /** POST body `{ toPersonUid, body }` — hq-pro has no POST /v1/notify/dm/{uid}. */
  dmSend: "/v1/notify/dm",

  notifications: "/v1/notify/notifications",
  /** hq-pro takes POST { id } on this collection path, not /:id/ack. */
  notificationAck: "/v1/notify/notifications/ack",
  notificationsReadAll: "/v1/notify/notifications/read-all",
  notificationAction: (id: string, action: string) =>
    `/v1/notify/notifications/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`,
  dmInbox: "/v1/notify/inbox",
  dmInboxAck: "/v1/notify/inbox/ack",
  sharedWithMe: "/v1/files/shared-with-me",
  sharedWithMeAck: "/v1/files/shared-with-me/ack",
  reactions: "/v1/notify/reactions",

  // Real hq-pro meetings/calendar surface (same as V1 desktop meetings.rs).
  calendarEvents: "/v1/calendar/events",
  googleAccounts: "/v1/google/accounts",
  googleConnect: "/v1/google/connect",
  googleAccount: (id: string) =>
    `/v1/google/accounts/${encodeURIComponent(id)}`,
  calendarCalendars: "/v1/calendar/calendars",
  botList: "/v1/bot/list",
  botInvite: "/v1/bot/invite",
  botJoinNow: "/v1/bot/join-now",
  botCancel: (id: string) => `/v1/bot/${encodeURIComponent(id)}/cancel`,

  /** Public hq-pro listings API (US-005) — not /v1/marketplace/*. */
  listings: "/v1/listings",
  listing: (id: string) => `/v1/listings/${encodeURIComponent(id)}`,
  publishPack: "/v1/listings",
  recordInstall: (id: string) =>
    `/v1/listings/${encodeURIComponent(id)}/installs`,
  yank: (id: string) =>
    `/v1/moderation/listings/${encodeURIComponent(id)}/yank`,
  creatorProfile: (handle: string) =>
    `/v1/creators/${encodeURIComponent(handle)}`,
  myCreator: "/v1/creators/me",
  myCreatorProfile: "/v1/creators/me/profile",
  claimHandle: "/v1/creators/claim",
  creatorAvatar: "/v1/creators/me/avatar",
  creatorAccess: "/v1/creators/request-access",
  creatorApplications: "/v1/creators/applications",
  creatorApplication: (id: string) =>
    `/v1/creators/applications/${encodeURIComponent(id)}`,
  moderationQueue: "/v1/moderation/queue",
  moderationListing: (id: string) =>
    `/v1/moderation/listings/${encodeURIComponent(id)}`,

  companyDeployments: (slug: string) =>
    `/v1/companies/${encodeURIComponent(slug)}/deployments`,
  companySecrets: (slug: string) =>
    `/v1/companies/${encodeURIComponent(slug)}/secrets`,
  companyMembers: (slug: string) =>
    `/v1/companies/${encodeURIComponent(slug)}/members`,
  companyTelemetry: (slug: string) =>
    `/v1/companies/${encodeURIComponent(slug)}/telemetry`,
  companyClaimInvite: (slug: string) =>
    `/v1/companies/${encodeURIComponent(slug)}/claim-invite`,
  companyConnect: (slug: string) =>
    `/v1/companies/${encodeURIComponent(slug)}/connect`,
  companySummary: (slug: string) =>
    `/v1/companies/${encodeURIComponent(slug)}/summary`,
  companyBoard: (slug: string) =>
    `/v1/companies/${encodeURIComponent(slug)}/board`,
  companyActivity: (slug: string) =>
    `/v1/companies/${encodeURIComponent(slug)}/activity`,

  feedback: "/v1/feedback/bug-report",

  workMeshProject: (id: string) =>
    `/v1/work-mesh/projects/${encodeURIComponent(id)}`,

  skillsShelf: (companyUid: string) =>
    `/v1/skills/${encodeURIComponent(companyUid)}/shelf`,
  skillsMe: (companyUid: string) =>
    `/v1/skills/${encodeURIComponent(companyUid)}/me`,
  filesList: "/v1/files/list",
  filesPresign: "/v1/files/presign",
} as const;

export interface WebPlatformAdapterConfig {
  /** hq-pro API base URL, e.g. "https://api.hq.example.com". */
  baseUrl: string;
  /** Injectable fetch; defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Optional headers applied to every request (auth token etc.). */
  headers?: Record<string, string>;
  /**
   * Called on HTTP 401. Browser default sends the user back through
   * /auth/signin. Tests can inject a spy; desktop does not use this adapter.
   */
  onUnauthorized?: () => void;
}

function defaultOnUnauthorized(): void {
  if (typeof window === "undefined") return;
  const path = window.location.pathname;
  if (path.startsWith("/auth/")) return;
  window.location.assign("/auth/signin");
}

const DESKTOP_ONLY: AdapterFailure = unavailable(
  "desktop-only",
  "This capability is only available in the desktop app.",
);

const NO_API: AdapterFailure = unavailable(
  "not-yet-implemented-api",
  "No hq-pro API exists for this capability yet.",
);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unwrapNamedArray(value: unknown, keys: readonly string[]): Json[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Json =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    );
  }
  const rec = asRecord(value);
  if (!rec) return [];
  for (const key of keys) {
    if (Array.isArray(rec[key])) return unwrapNamedArray(rec[key], keys);
  }
  return [];
}

function companyIdFromPayload(payload: Json | undefined): string | null {
  const rec = asRecord(payload);
  const raw = rec?.companyId ?? rec?.company_id;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function withCompanyQuery(path: string, payload: Json | undefined): string {
  const companyId = companyIdFromPayload(payload);
  if (!companyId) return path;
  return `${path}?companyId=${encodeURIComponent(companyId)}`;
}

function inviteBody(payload: Json | undefined): Json {
  const rec = asRecord(payload) ?? {};
  const body: Record<string, unknown> = {
    meetingUrl: rec.meetingUrl ?? rec.meeting_url,
  };
  const eventId = rec.calendarEventId ?? rec.calendar_event_id;
  const seriesId = rec.calendarSeriesId ?? rec.calendar_series_id;
  if (typeof eventId === "string" && eventId) body.calendarEventId = eventId;
  if (typeof seriesId === "string" && seriesId)
    body.calendarSeriesId = seriesId;
  if (Array.isArray(rec.participants)) body.participants = rec.participants;
  return body as Json;
}

function unwrapCalendars(value: unknown): Json {
  if (Array.isArray(value)) {
    return {
      calendars: value,
      selectedCalendarIds: value
        .map((item) => asRecord(item)?.id)
        .filter((id): id is string => typeof id === "string"),
    };
  }
  const rec = asRecord(value) ?? {};
  const calendars = Array.isArray(rec.calendars) ? rec.calendars : [];
  const selected = Array.isArray(rec.selectedCalendars)
    ? rec.selectedCalendars
    : Array.isArray(rec.selected_calendars)
      ? rec.selected_calendars
      : [];
  const selectedCalendarIds = selected
    .map((item) => (typeof item === "string" ? item : asRecord(item)?.id))
    .filter((id): id is string => typeof id === "string");
  return { calendars, selectedCalendarIds };
}

function normalizeMemberships(value: unknown): Json[] {
  return membershipRowsFromPayload(value)
    .map((row) => {
      const rec = row as Record<string, unknown>;
      const companyUid = String(
        rec.companyUid ?? rec.company_uid ?? rec.cloudUid ?? rec.uid ?? "",
      ).trim();
      return {
        companyUid,
        companyName:
          rec.companyName ??
          rec.company_name ??
          rec.displayName ??
          rec.name ??
          null,
        role: rec.role ?? null,
        status: rec.status ?? rec.membershipStatus ?? "active",
      };
    })
    .filter((row) => row.companyUid);
}

function companyFromMembership(row: Json): {
  uid: string;
  slug: string;
  name: string;
} | null {
  const rec = row as Record<string, unknown>;
  const uid = String(
    rec.companyUid ?? rec.company_uid ?? rec.cloudUid ?? rec.uid ?? "",
  ).trim();
  if (!uid) return null;
  const slug = String(
    rec.slug ?? rec.companySlug ?? rec.company_slug ?? "",
  ).trim();
  const name = String(
    rec.companyName ??
      rec.company_name ??
      rec.displayName ??
      rec.name ??
      slug ??
      uid,
  ).trim();
  return { uid, slug: slug || name || uid, name: name || slug || uid };
}

async function scopedSkillsForCompany(
  get: (path: string) => AdapterPromise<Json>,
  company: { uid: string; slug: string; name: string },
): Promise<LibrarySkillWire[]> {
  const [shelf, me] = await Promise.all([
    get(WEB_PATHS.skillsShelf(company.uid)),
    get(WEB_PATHS.skillsMe(company.uid)),
  ]);
  if (!shelf.ok) return [];
  const viewer = me.ok
    ? parseShelfViewer(me.value)
    : { personUid: null, groupIds: [], isActiveMember: true };
  return scopedSkillsFromShelf(shelf.value, viewer, company);
}

function membershipRowsFromPayload(value: unknown): Json[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Json =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    );
  }
  if (typeof value === "object" && value !== null) {
    const rec = value as Record<string, unknown>;
    for (const key of ["memberships", "companies", "workspaces"] as const) {
      if (Array.isArray(rec[key])) return membershipRowsFromPayload(rec[key]);
    }
  }
  return [];
}

export class WebPlatformAdapter implements PlatformAdapter {
  readonly kind = "web" as const;
  readonly capabilities = WEB_CAPABILITIES;

  private readonly baseUrl: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly headers: Record<string, string>;
  private readonly onUnauthorized: () => void;
  private activeCompany: string | null = null;

  constructor(config: WebPlatformAdapterConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    const f = config.fetch ?? globalThis.fetch;
    if (!f) {
      throw new Error("WebPlatformAdapter requires a fetch implementation");
    }
    this.fetchFn = f;
    this.headers = config.headers ?? {};
    this.onUnauthorized = config.onUnauthorized ?? defaultOnUnauthorized;
  }

  isAvailable(cap: Capability): boolean {
    return this.capabilities[cap];
  }

  // -- HTTP plumbing --------------------------------------------------------

  private async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): AdapterPromise<T> {
    try {
      const hasBody = body !== undefined;
      const res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        credentials: "same-origin",
        headers: {
          // Only declare a JSON body when one is actually sent — avoids
          // needless CORS preflights on simple GET/DELETE requests.
          ...(hasBody ? { "content-type": "application/json" } : {}),
          ...this.headers,
        },
        body: hasBody ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        if (res.status === 401) {
          this.onUnauthorized();
        }
        const text = await res.text();
        let code = `http-${res.status}`;
        let message = `${method} ${path} failed`;
        try {
          const parsed = text ? JSON.parse(text) : null;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const rec = parsed as Record<string, unknown>;
            if (typeof rec.code === "string" && rec.code.trim()) {
              code = rec.code.trim();
            }
            if (typeof rec.error === "string" && rec.error.trim()) {
              message = rec.error.trim();
            }
          }
        } catch {
          /* keep http-status defaults */
        }
        return failure(code, message);
      }
      if (res.status === 204) {
        return ok(undefined as T);
      }
      const text = await res.text();
      return ok((text ? JSON.parse(text) : undefined) as T);
    } catch (err) {
      return failure(
        "network",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private get<T>(path: string): AdapterPromise<T> {
    return this.request<T>("GET", path);
  }

  private post<T>(path: string, body?: unknown): AdapterPromise<T> {
    return this.request<T>("POST", path, body);
  }

  // -- Cloud-available groups ----------------------------------------------

  readonly identity: PlatformAdapter["identity"] = {
    whoami: () => this.get(WEB_PATHS.whoami),
    isAdmin: () => this.get(WEB_PATHS.isAdmin),
    hasFeature: (flag) => this.get(WEB_PATHS.hasFeature(flag)),
    listWorkspaces: async () => {
      const result = await this.get<Json>(WEB_PATHS.workspaces);
      if (!result.ok) return result;
      return ok(membershipRowsFromPayload(result.value));
    },
    getProfile: () => this.get(WEB_PATHS.profile),
    updateProfile: (input) => this.request("PUT", WEB_PATHS.profile, input),
  };

  readonly messaging: PlatformAdapter["messaging"] = {
    listChannels: () => this.get(WEB_PATHS.channels),
    fetchChannelDirectory: (cursor) =>
      this.get(
        cursor
          ? `${WEB_PATHS.channelDirectory}?cursor=${encodeURIComponent(cursor)}`
          : WEB_PATHS.channelDirectory,
      ),
    // POST /v1/notify/channels is the live create route (WEB_PATHS.channels
    // was a provisional path with no server handler).
    createChannel: (payload) => this.post(WEB_PATHS.channelDirectory, payload),
    addChannelMember: (channelId, toPersonUid) =>
      this.post(WEB_PATHS.channelMembers(channelId), { toPersonUid }),
    removeChannelMember: (channelId, personUid) =>
      this.request("DELETE", WEB_PATHS.channelMember(channelId, personUid)),
    listContacts: () => this.get(WEB_PATHS.contacts),
    listDmRequests: () => this.get(WEB_PATHS.dmRequests),
    markChannelRead: (id) => this.post(WEB_PATHS.markChannelRead(id), {}),
    markDmThreadRead: async (uid) => {
      const withPersonUid = uid.trim();
      if (!withPersonUid)
        return failure("bad-argument", "withPersonUid required");
      return this.post(WEB_PATHS.markDmThreadRead, { withPersonUid });
    },
    searchMessages: (q, opts) => {
      const params = new URLSearchParams({ q });
      if (opts?.companyUid) params.set("companyUid", opts.companyUid);
      if (opts?.limit != null) params.set("limit", String(opts.limit));
      return this.get(`${WEB_PATHS.searchMessages}?${params.toString()}`);
    },
    fetchChannel: ({ channelId, limit, cursor, since }) => {
      const params = new URLSearchParams();
      if (limit != null) params.set("limit", String(limit));
      if (cursor) params.set("cursor", cursor);
      if (since) params.set("since", since);
      const qs = params.toString();
      return this.get(
        `${WEB_PATHS.channelMessages(channelId)}${qs ? `?${qs}` : ""}`,
      );
    },
    listChannelMembers: (channelId) =>
      this.get(WEB_PATHS.channelMembers(channelId)),
    sendChannelMessage: (channelId, body, extras) =>
      this.post(WEB_PATHS.channelMessages(channelId), {
        body,
        ...(extras?.mentions && extras.mentions.length > 0
          ? { mentions: extras.mentions }
          : {}),
        ...(extras?.attachments && extras.attachments.length > 0
          ? { attachments: extras.attachments }
          : {}),
      }),
    fetchDmThread: ({ withPersonUid, limit, since }) => {
      const params = new URLSearchParams({ withPersonUid });
      if (limit != null) params.set("limit", String(limit));
      if (since) params.set("since", since);
      return this.get(`/v1/notify/thread?${params.toString()}`);
    },
    sendDm: (toPersonUid, body, extras) =>
      this.post(WEB_PATHS.dmSend, {
        toPersonUid,
        body,
        ...(extras?.attachments && extras.attachments.length > 0
          ? { attachments: extras.attachments }
          : {}),
      }),
    fetchReplyThread: async (args) => {
      const invalid = validateFetchReplyThread(args);
      if (invalid) return invalid;
      const result = await this.get<Json>(buildReplyThreadPath(args));
      if (!result.ok) return result;
      return ok(normalizeReplyThreadValue(result.value));
    },
    sendReply: async (args) => {
      const invalid = validateSendReply(args);
      if (invalid) return invalid;
      const req = buildSendReplyRequest(args);
      return this.post<Json>(req.path, req.body);
    },
    fetchReactions: (messageScope, messageId) =>
      this.get(
        `${WEB_PATHS.reactions}?messageScope=${encodeURIComponent(messageScope)}&messageId=${encodeURIComponent(messageId)}`,
      ),
    toggleReaction: ({ messageScope, messageId, emoji, add }) =>
      this.request(add ? "POST" : "DELETE", WEB_PATHS.reactions, {
        messageScope,
        messageId,
        emoji,
      }),
  };

  readonly notifications: PlatformAdapter["notifications"] = {
    fetchNotifications: (opts) =>
      this.get(
        opts && Object.keys(opts).length > 0
          ? `${WEB_PATHS.notifications}?${new URLSearchParams(opts as Record<string, string>).toString()}`
          : WEB_PATHS.notifications,
      ),
    ack: (id) => this.post(WEB_PATHS.notificationAck, { id }),
    readAll: () => this.post(WEB_PATHS.notificationsReadAll, {}),
    runAction: (id, action) =>
      this.post(WEB_PATHS.notificationAction(id, action)),
    fetchDmInbox: (opts) =>
      this.get(
        opts && Object.keys(opts).length > 0
          ? `${WEB_PATHS.dmInbox}?${new URLSearchParams(opts as Record<string, string>).toString()}`
          : WEB_PATHS.dmInbox,
      ),
    ackDmInbox: (eventIds) => this.post(WEB_PATHS.dmInboxAck, { eventIds }),
    fetchSharedWithMe: (opts) =>
      this.get(
        opts && Object.keys(opts).length > 0
          ? `${WEB_PATHS.sharedWithMe}?${new URLSearchParams(opts as Record<string, string>).toString()}`
          : WEB_PATHS.sharedWithMe,
      ),
    ackSharedWithMe: (eventIds) =>
      this.post(WEB_PATHS.sharedWithMeAck, { eventIds }),
  };

  readonly meetings: PlatformAdapter["meetings"] = {
    listMemberships: async () => {
      const result = await this.get<Json>(WEB_PATHS.workspaces);
      if (!result.ok) return result;
      return ok(normalizeMemberships(result.value));
    },
    listUpcoming: async () => {
      const result = await this.get<Json>(WEB_PATHS.calendarEvents);
      if (!result.ok) return result;
      return ok(unwrapNamedArray(result.value, ["events"]));
    },
    listScheduledBots: async () => {
      const result = await this.get<Json>(WEB_PATHS.botList);
      if (!result.ok) return result;
      return ok(unwrapNamedArray(result.value, ["bots"]));
    },
    inviteBot: (payload) =>
      this.post(
        withCompanyQuery(WEB_PATHS.botInvite, payload),
        inviteBody(payload),
      ),
    cancelBot: (id) => this.post(WEB_PATHS.botCancel(id)),
    joinBotNow: (payload) =>
      this.post(
        withCompanyQuery(WEB_PATHS.botJoinNow, payload),
        inviteBody(payload),
      ),
    listAccounts: async () => {
      const result = await this.get<Json>(WEB_PATHS.googleAccounts);
      if (!result.ok) return result;
      return ok(unwrapNamedArray(result.value, ["accounts"]));
    },
    listCalendars: async (account) => {
      const result = await this.get<Json>(
        `${WEB_PATHS.calendarCalendars}?accountId=${encodeURIComponent(account)}`,
      );
      if (!result.ok) return result;
      return ok(unwrapCalendars(result.value));
    },
    connectCalendar: () => this.post(WEB_PATHS.googleConnect),
    disconnectCalendar: (accountId) =>
      this.request("DELETE", WEB_PATHS.googleAccount(accountId)),
  };

  readonly marketplace: PlatformAdapter["marketplace"] = {
    listListings: (opts) => {
      const rec = opts && typeof opts === "object" ? opts : {};
      const q = typeof rec.q === "string" ? rec.q.trim() : "";
      return this.get(
        q
          ? `${WEB_PATHS.listings}?q=${encodeURIComponent(q)}`
          : WEB_PATHS.listings,
      );
    },
    getListing: (id) => this.get(WEB_PATHS.listing(id)),
    // Publishing takes a local pack directory — a browser cannot supply a
    // trustworthy filesystem path. Desktop-only until a web upload flow with
    // explicit auth/DTO semantics exists (codex review, US-004).
    publishPack: async () => DESKTOP_ONLY,
    recordInstall: (id, payload) =>
      this.post(WEB_PATHS.recordInstall(id), payload ?? { scope: "personal" }),
    yank: (id, reason) => this.post(WEB_PATHS.yank(id), { reason }),
    getCreatorProfile: (handle) => this.get(WEB_PATHS.creatorProfile(handle)),
    getMyCreator: () => this.get(WEB_PATHS.myCreator),
    claimHandle: (handle) => this.post(WEB_PATHS.claimHandle, { handle }),
    updateCreatorProfile: (p) =>
      this.request("PUT", WEB_PATHS.myCreatorProfile, p),
    uploadCreatorAvatar: (data) => this.post(WEB_PATHS.creatorAvatar, { data }),
    requestCreatorAccess: () => this.post(WEB_PATHS.creatorAccess),
    listCreatorApplications: () => this.get(WEB_PATHS.creatorApplications),
    decideCreatorApplication: (id, decision) =>
      this.post(WEB_PATHS.creatorApplication(id), { decision }),
    listModerationQueue: () => this.get(WEB_PATHS.moderationQueue),
    decideModerationListing: (id, decision) =>
      this.post(WEB_PATHS.moderationListing(id), { decision }),
    installPack: async () => DESKTOP_ONLY,
  };

  readonly company: PlatformAdapter["company"] = {
    getDeployments: (slug) => this.get(WEB_PATHS.companyDeployments(slug)),
    // Secret material must not become browser-accessible by default; keep
    // unavailable until the web API vends scoped, non-sensitive DTOs
    // (codex review, US-004).
    getSecrets: async () =>
      unavailable(
        "server-only",
        "Company secrets are not exposed to the browser.",
      ),
    listMembers: (slug) => this.get(WEB_PATHS.companyMembers(slug)),
    getTeamTelemetry: (slug) => this.get(WEB_PATHS.companyTelemetry(slug)),
    claimPendingInvite: (slug) => this.post(WEB_PATHS.companyClaimInvite(slug)),
    connectToCloud: (slug) => this.post(WEB_PATHS.companyConnect(slug)),
    getSummary: (slug) => this.get(WEB_PATHS.companySummary(slug)),
    getBoard: (slug) => this.get(WEB_PATHS.companyBoard(slug)),
    getActivity: (slug) => this.get(WEB_PATHS.companyActivity(slug)),
  };

  readonly feedback: PlatformAdapter["feedback"] = {
    submitBugReport: (title, body) =>
      this.post(WEB_PATHS.feedback, { title, body }),
  };

  // -- needs-new-API groups (unavailable on web for now) --------------------

  readonly projects: PlatformAdapter["projects"] = {
    listProjects: async () => NO_API,
    getGoals: async () => NO_API,
    getPrd: async () => NO_API,
    getReadme: async () => NO_API,
    setProjectStatus: async () => NO_API,
    setStoryPasses: async () => NO_API,
    getProjectCreators: async () => NO_API,
  };

  readonly library: PlatformAdapter["library"] = {
    getRoot: async () => {
      const roster = await this.get<Json>(WEB_PATHS.workspaces);
      if (!roster.ok) return roster;
      const companies = membershipRowsFromPayload(roster.value)
        .map(companyFromMembership)
        .filter((row): row is NonNullable<typeof row> => row !== null);
      const skills = (
        await Promise.all(
          companies.map((company) =>
            scopedSkillsForCompany((path) => this.get(path), company),
          ),
        )
      ).flat();
      return ok({ workers: [], skills });
    },
    getCompany: async (slug) => {
      const roster = await this.get<Json>(WEB_PATHS.workspaces);
      if (!roster.ok) return roster;
      const company = membershipRowsFromPayload(roster.value)
        .map(companyFromMembership)
        .find(
          (row) =>
            row && (row.slug === slug || row.uid === slug || row.name === slug),
        );
      if (!company) return ok({ workers: [], skills: [] });
      const skills = await scopedSkillsForCompany(
        (path) => this.get(path),
        company,
      );
      return ok({ workers: [], skills });
    },
    getWorkerDetail: async () =>
      unavailable(
        "not-yet-implemented-api",
        "Workers are not on the cloud skills shelf.",
      ),
    getSkillDetail: async (path) => {
      const parsed = parseSkillPath(path);
      if (!parsed) {
        return unavailable("not-found", "Skill path is missing a company.");
      }
      const shelf = await this.get<Json>(
        WEB_PATHS.skillsShelf(parsed.companyUid),
      );
      if (!shelf.ok) return shelf;
      const detail = skillDetailFromShelf(shelf.value, parsed.skillUid);
      if (!detail) return unavailable("not-found", "Skill not on this shelf.");
      return ok(detail as unknown as Json);
    },
  };

  readonly files: PlatformAdapter["files"] = {
    listDir: async () => NO_API,
    getFileContent: async () => NO_API,
    listVaultPrefix: (companyUid, prefix) =>
      this.get(
        `${WEB_PATHS.filesList}?company=${encodeURIComponent(companyUid)}&prefix=${encodeURIComponent(prefix)}`,
      ),
    presignVaultGet: (companyUid, key) =>
      this.post(WEB_PATHS.filesPresign, {
        company: companyUid,
        op: "get",
        key,
      }),
    presignVaultPut: (companyUid, key, contentType) =>
      this.post(WEB_PATHS.filesPresign, {
        company: companyUid,
        op: "put",
        key,
        contentType,
      }),
    getAuthorizedPreview: async () => NO_API,
    revealInFinder: async () => DESKTOP_ONLY,
  };

  readonly agency: PlatformAdapter["agency"] = {
    listTeams: async () => NO_API,
    listQuestions: async () => NO_API,
    listChat: async () => NO_API,
    answerQuestion: async () => NO_API,
    sendMessage: async () => NO_API,
  };

  // -- Desktop-only groups --------------------------------------------------

  readonly sync: PlatformAdapter["sync"] = {
    startDaemon: async () => DESKTOP_ONLY,
    stopDaemon: async () => DESKTOP_ONLY,
    daemonStatus: async () => DESKTOP_ONLY,
    startSync: async () => DESKTOP_ONLY,
    cancelSync: async () => DESKTOP_ONLY,
    getSyncStatus: async () => DESKTOP_ONLY,
    getActivityLog: async () => DESKTOP_ONLY,
    resolveConflict: async () => DESKTOP_ONLY,
    restoreFromUpstream: async () => DESKTOP_ONLY,
    beginReauth: async () => DESKTOP_ONLY,
    listSyncableWorkspaces: async () => DESKTOP_ONLY,
  };

  readonly shell: PlatformAdapter["shell"] = {
    openInEditor: async () => DESKTOP_ONLY,
    openClaudeCodeLink: async () => DESKTOP_ONLY,
    openFileInClaude: async () => DESKTOP_ONLY,
    launchClaudeCode: async () => DESKTOP_ONLY,
    launchCodexWorkspace: async () => DESKTOP_ONLY,
    launchCliInTerminal: async () => DESKTOP_ONLY,
    detectAiTools: async () => DESKTOP_ONLY,
    pickFolder: async () => DESKTOP_ONLY,
    pickFile: async () => DESKTOP_ONLY,
  };

  readonly appShell: PlatformAdapter["appShell"] = {
    // Browser no-ops / equivalents.
    setTrayState: async () => ok(undefined),
    showMainWindow: async () => ok(undefined),
    quitApp: async () => DESKTOP_ONLY,
    setDockVisible: async () => ok(undefined),
    setAutostart: async () => DESKTOP_ONLY,
    setDesktopWidget: async () => DESKTOP_ONLY,
    consumePendingRoute: async () => ok(null),
    takePendingMessagesTarget: async () => ok(null),
    setActiveCompany: async (slug) => {
      this.activeCompany = slug;
      return ok(undefined);
    },
    openDriftDetail: async () => DESKTOP_ONLY,
    openMeetingPermissionsWindow: async () => DESKTOP_ONLY,
    notificationPermissionState: async () => {
      const n = (globalThis as { Notification?: { permission: string } })
        .Notification;
      return ok(n ? n.permission : "unsupported");
    },
    requestNotificationPermission: async () => {
      const n = (
        globalThis as {
          Notification?: { requestPermission(): Promise<string> };
        }
      ).Notification;
      if (!n) return ok("unsupported");
      try {
        return ok(await n.requestPermission());
      } catch (err) {
        return failure(
          "notification-permission",
          err instanceof Error ? err.message : String(err),
        );
      }
    },
    // Native banners are desktop-only (US-001). Web stays a no-op.
    showOsNotification: async () => ok(undefined),
  };

  readonly updates: PlatformAdapter["updates"] = {
    getVersions: async () => DESKTOP_ONLY,
    checkForUpdates: async () => DESKTOP_ONLY,
    installUpdate: async () => DESKTOP_ONLY,
    getPendingUpdate: async () => DESKTOP_ONLY,
    checkCoreState: async () => DESKTOP_ONLY,
    installCoreUpdate: async () => DESKTOP_ONLY,
    replaceFromStaging: async () => DESKTOP_ONLY,
    checkCliUpdate: async () => DESKTOP_ONLY,
    installCliUpdate: async () => DESKTOP_ONLY,
    dismissCliUpdate: async () => DESKTOP_ONLY,
    availableChannels: async () => DESKTOP_ONLY,
  };

  readonly packages: PlatformAdapter["packages"] = {
    listPackages: async () => DESKTOP_ONLY,
    listPackagesCached: async () => DESKTOP_ONLY,
    install: async () => DESKTOP_ONLY,
    update: async () => DESKTOP_ONLY,
    uninstall: async () => DESKTOP_ONLY,
    checkUpdates: async () => DESKTOP_ONLY,
    updatePacks: async () => DESKTOP_ONLY,
  };

  readonly sessions: PlatformAdapter["sessions"] = {
    listAgentSessions: async () => DESKTOP_ONLY,
  };

  readonly settings: PlatformAdapter["settings"] = {
    // Local, browser-scoped stubs until a web settings store lands.
    getConfig: async () => ok({} as Json),
    getSettings: async () => ok({} as Json),
    getSetupStatus: async () => DESKTOP_ONLY,
    getTelemetryConsent: async () => ok<boolean | null>(null),
  };

  readonly workMesh: PlatformAdapter["workMesh"] = {
    readLocalSnapshot: async () => DESKTOP_ONLY,
    getProjectView: (projectId, companyUid) => {
      const id = projectId.trim();
      const company = companyUid?.trim() ?? "";
      const qs = company ? `?companyUid=${encodeURIComponent(company)}` : "";
      return this.get(`${WEB_PATHS.workMeshProject(id)}${qs}`);
    },
  };
}

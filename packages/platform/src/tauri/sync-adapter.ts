/**
 * Sync-side PlatformAdapter (US-102).
 *
 * Maps HQ Work's PlatformAdapter onto existing Sync Tauri commands and the
 * authenticated hq-pro client in Rust. The webview never holds the bearer and
 * must not grow a second fetch stack.
 */

import {
  type AdapterResult,
  type AdapterPromise,
  type ChannelSummary,
  type Json,
  type PlatformAdapter,
  type VersionProbe,
  type WhoAmI,
  type VersionInfo,
  buildSendReplyRequest,
  failure,
  normalizeReplyThreadValue,
  normalizeNotificationsFeed,
  ok,
  unavailable,
  validateFetchReplyThread,
  validateSendReply,
} from '../adapter.js';
import { TAURI_CAPABILITIES, type Capability } from '../capabilities.js';
import { WEB_PATHS } from '../web/index.js';
import { updateSettings, type SettingsInvoker } from './settings-mutations.js';

export type SyncInvokeFn = (
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export interface SyncPlatformAdapterConfig {
  invoke: SyncInvokeFn;
  /**
   * Tests inject a stub that throws if called. Production REST goes through
   * invoke("hq_pro_fetch") so Cognito stays in Rust.
   */
  fetch?: typeof globalThis.fetch;
}

const NOT_MAPPED = unavailable(
  'not-yet-mapped',
  'This capability is not yet mapped on the Sync host.',
);

/**
 * Distinct from NOT_MAPPED: the Sync host already owns this surface natively
 * (tray, floating widget, notification banners) and the embedded HQ Work UI
 * must not drive a second one. Project non-goal: "Porting the sync engine,
 * tray, or widget anywhere". Refusing loudly beats a silent `ok()`, which
 * would make the embedded settings toggle look effective while nothing moved.
 */
const HOST_OWNED = unavailable(
  'host-owned',
  'The Sync host owns this surface natively; the embedded UI does not drive it.',
);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isJson(value: unknown): value is Json {
  return asRecord(value) !== null;
}

function unwrapNamedArray(value: unknown, keys: readonly string[]): Json[] {
  if (Array.isArray(value)) {
    return value.filter(isJson);
  }
  const rec = asRecord(value);
  if (!rec) return [];
  for (const key of keys) {
    if (Array.isArray(rec[key])) return unwrapNamedArray(rec[key], keys);
  }
  return [];
}

function withQuery(
  path: string,
  params: Record<string, string | number | undefined | null>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    const text = String(value);
    if (!text) continue;
    search.set(key, text);
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

function asWhoAmI(value: unknown): WhoAmI {
  const rec = asRecord(value) ?? {};
  const personUid = String(
    rec.personUid ?? rec.uid ?? rec.sub ?? rec.person_uid ?? '',
  ).trim();
  const email = String(rec.email ?? '').trim();
  const displayNameRaw = rec.displayName ?? rec.name;
  const displayName =
    typeof displayNameRaw === 'string' && displayNameRaw.trim()
      ? displayNameRaw.trim()
      : undefined;
  return { ...rec, personUid, email, displayName };
}

function asChannelSummary(row: Json): ChannelSummary {
  const unread = row.unreadCount ?? row.unread;
  return {
    ...row,
    id: String(row.id ?? row.channelId ?? row.channel_id ?? ''),
    name: String(row.name ?? ''),
    ...(typeof unread === 'number' ? { unreadCount: unread } : {}),
  };
}

function invokeError(err: unknown): ReturnType<typeof failure> {
  return failure(
    'invoke',
    err instanceof Error ? err.message : String(err),
  );
}

export function createSyncPlatformAdapter(
  config: SyncPlatformAdapterConfig,
): PlatformAdapter {
  // Production must not use window.fetch; tests pass a throwing stub.
  void config.fetch;
  const invokeFn = config.invoke;

  async function call<T>(
    cmd: string,
    args?: Record<string, unknown>,
  ): AdapterPromise<T> {
    try {
      return ok((await invokeFn(cmd, args)) as T);
    } catch (err) {
      return invokeError(err);
    }
  }

  async function getVersions(): AdapterPromise<VersionInfo> {
    const [core, cli] = await Promise.all([
      call<string | null>('get_hq_version'),
      call<string | null>('get_hq_cli_version'),
    ]);
    // Version probes are independent. A missing or failed CLI probe must not
    // erase a successfully read Core version (and vice versa); the Settings UI
    // renders the failed row as unchecked with its own remediation.
    const toProbe = (result: AdapterResult<string | null>): VersionProbe =>
      result.ok
        ? { status: result.value ? 'available' : 'missing', value: result.value }
        : { status: 'failed', code: result.code, message: result.message };
    const versions: VersionInfo = {
      ...(core.ok && core.value ? { core: core.value } : {}),
      ...(cli.ok && cli.value ? { cli: cli.value } : {}),
      coreProbe: toProbe(core),
      cliProbe: toProbe(cli),
    };
    return ok(versions);
  }

  async function hqProJson<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): AdapterPromise<T> {
    const raw = await call<unknown>('hq_pro_fetch', {
      url: path,
      method,
      body: body === undefined ? null : JSON.stringify(body),
    });
    if (!raw.ok) return raw;
    const rec = asRecord(raw.value);
    if (rec && typeof rec.status === 'number') {
      const text = typeof rec.body === 'string' ? rec.body : '';
      if (rec.status < 200 || rec.status >= 300) {
        let code = `http-${rec.status}`;
        let message = `${method} ${path} failed`;
        try {
          const parsed = text ? JSON.parse(text) : null;
          const err = asRecord(parsed);
          if (err) {
            if (typeof err.code === 'string' && err.code.trim()) {
              code = err.code.trim();
            }
            if (typeof err.error === 'string' && err.error.trim()) {
              message = err.error.trim();
            }
          }
        } catch {
          /* keep http-status defaults */
        }
        return failure(code, message);
      }
      if (rec.status === 204 || !text.trim()) {
        return ok(undefined as T);
      }
      try {
        return ok(JSON.parse(text) as T);
      } catch (err) {
        return failure(
          'network',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return ok(raw.value as T);
  }

  /**
   * Prototype settings handlers fire these writes without awaiting them, so
   * persist through the process-wide queue to preserve concurrent patches from
   * every settings surface. The native apply commands re-read menubar.json, so
   * invoke them only after the requested value is persisted.
   */
  async function persistThenApplyAppShellPreference(
    key: 'dockIcon' | 'widgetEnabled',
    value: boolean,
    applyCommand: 'apply_dock_icon' | 'apply_widget_settings',
  ): AdapterPromise<void> {
    const settingsInvoker: SettingsInvoker = <T>(
      command: string,
      args?: Record<string, unknown>,
    ) => invokeFn(command, args) as Promise<T>;
    try {
      await updateSettings({ [key]: value }, settingsInvoker);
    } catch (err) {
      return invokeError(err);
    }
    return call<void>(applyCommand);
  }

  /**
   * `agency_root/<company>/<team>` is the on-disk layout, so every agency
   * command takes a company. `AgencyApi` only passes a team, so the company
   * comes from the desktop session scope the window already sets via
   * `setActiveCompany` — the same scope the native Agency surface reads.
   */
  async function activeCompany(): AdapterPromise<string> {
    const result = await call<string | null>('get_desktop_active_company');
    if (!result.ok) return result;
    const slug = (result.value ?? '').trim();
    if (!slug) {
      return failure('no-active-company', 'No active company is selected.');
    }
    return ok(slug);
  }

  const adapter: PlatformAdapter = {
    kind: 'desktop',
    capabilities: TAURI_CAPABILITIES,
    isAvailable: (cap: Capability): boolean => TAURI_CAPABILITIES[cap],

    identity: {
      whoami: async () => {
        type ShellAuthState = {
          authenticated?: boolean;
          accountId?: string | null;
          email?: string | null;
          displayName?: string | null;
        };
        const auth = await call<ShellAuthState>('get_auth_state');
        if (!auth.ok) return auth;
        if (!auth.value?.authenticated) {
          return failure('unauthenticated', 'Not signed in');
        }
        // Native `whoami` binds the canonical `prs_*` person UID and profile
        // fields to the signed-in session (Cognito claims + vault person
        // entity). This is the ONLY identity path: the provisional REST route
        // `GET /v1/identity/whoami` is served by the web console, not the
        // bearer vault API the desktop calls, so it 404s here and never
        // recovers on retry. Main briefly carried a 404-degrade fallback over
        // that dead route (a1aab012) and then reverted it wholesale (d91bfc95),
        // leaving main hard-gated on the 404 again — do not reintroduce it.
        const meResult = await call<unknown>('whoami');
        if (!meResult.ok) {
          // Preserve the reverted fix's resilience intent (a1aab012): an account whose
          // canonical person entity is PERMANENTLY absent must not hard-fail
          // the whole account load with "Couldn't load your account" (it never
          // recovers on retry). Fall back to the proven native session
          // identity already fetched above. Every other failure still
          // propagates so the shell keeps its handling: "Not signed in" →
          // re-sign-in, transient vault errors → identity-error with Retry.
          const nativeUid = auth.value.accountId?.trim();
          const message = meResult.message?.toLowerCase() ?? '';
          if (!message.includes('no person entity') || !nativeUid) {
            return meResult;
          }
          // NOTE: on this fallback path `personUid` is the Cognito subject, not
          // the server-issued `prs_*` person uid the success path returns. It is
          // fine for rendering the account, but must not be assumed `prs_*` by
          // recipient-scoped consumers (e.g. the realtime wake scope in
          // hq-work-host.ts) — resolve the canonical `prs_*` uid natively before
          // coupling any recipient-scope check to it.
          return ok({
            personUid: nativeUid,
            email: auth.value.email?.trim() || '',
            displayName: auth.value.displayName?.trim() || undefined,
          });
        }
        const currentAuth = await call<ShellAuthState>('get_auth_state');
        if (!currentAuth.ok) return currentAuth;
        if (
          !currentAuth.value?.authenticated ||
          !auth.value.accountId ||
          currentAuth.value.accountId !== auth.value.accountId
        ) {
          return failure(
            'identity-changed',
            'Signed-in account changed while loading the profile.',
          );
        }
        const me = asWhoAmI(meResult.value);
        if (!me.personUid) {
          return failure(
            'identity-unavailable',
            'Signed-in account has no canonical person identifier.',
          );
        }
        return ok({
          ...me,
          email: me.email || auth.value.email?.trim() || '',
          displayName:
            me.displayName || auth.value.displayName?.trim() || undefined,
        });
      },
      isAdmin: () => call<boolean>('desktop_alt_is_admin'),
      hasFeature: async (flag) => {
        if (flag === 'meetings') {
          return call<boolean>('meetings_feature_enabled');
        }
        if (flag === 'is_indigo_user') {
          return call<boolean>('is_indigo_user');
        }
        return hqProJson<boolean>('GET', WEB_PATHS.hasFeature(flag));
      },
      listWorkspaces: async () => {
        const result = await call<unknown>('list_syncable_workspaces');
        if (!result.ok) return result;
        return ok(unwrapNamedArray(result.value, ['workspaces', 'memberships']));
      },
      // Same REST route the web adapter uses (`WEB_PATHS.profile`); Sync has no
      // native command for the global member profile, so it goes over hq_pro_fetch.
      getProfile: () => hqProJson('GET', WEB_PATHS.profile),
      updateProfile: (input) => hqProJson('PUT', WEB_PATHS.profile, input),
    },

    messaging: {
      listChannels: async (opts) => {
        const result = await call<unknown>('list_channels', {
          companyUid: opts?.companyUid,
          includeCompanyProjects: opts?.includeCompanyProjects,
        });
        if (!result.ok) return result;
        return ok(
          unwrapNamedArray(result.value, ['channels']).map(asChannelSummary),
        );
      },
      fetchChannelDirectory: (_cursor) => call<Json>('list_channels'),
      createChannel: (payload) => {
        const rec = asRecord(payload) ?? {};
        const scope = String(rec.scope ?? '');
        if (scope === 'group') {
          const participants = Array.isArray(rec.participants)
            ? rec.participants
            : Array.isArray(rec.invite)
              ? rec.invite
              : Array.isArray(rec.invites)
                ? rec.invites
                : [];
          return call('create_group_dm', { participants });
        }
        return call('create_channel', {
          name: rec.name,
          scope: rec.scope,
          companyUid: rec.companyUid ?? rec.company_uid ?? null,
          invite: rec.invite ?? rec.invites ?? null,
          projectId: rec.projectId ?? rec.project_id ?? null,
        });
      },
      addChannelMember: (channelId, toPersonUid) =>
        call('invite_to_channel', {
          channelId,
          personUids: [toPersonUid],
        }),
      // Owner-only server-side (403 otherwise); Sync already exposes the command.
      removeChannelMember: (channelId, personUid) =>
        call('remove_channel_member', { channelId, personUid }),
      // A companyUid scopes the roster to one tenant via the already-registered
      // list_company_members command (GET /v1/notify/contacts?companyUid=…).
      listContacts: async (opts) => {
        const companyUid = opts?.companyUid?.trim();
        const result = companyUid
          ? await call<unknown>('list_company_members', { companyUid })
          : await call<unknown>('list_contacts');
        if (!result.ok) return result;
        return ok(unwrapNamedArray(result.value, ['contacts']));
      },
      listDmRequests: async () => {
        const result = await call<unknown>('list_dm_requests');
        if (!result.ok) return result;
        return ok(unwrapNamedArray(result.value, ['requests']));
      },
      markChannelRead: (id) => call('mark_channel_read', { channelId: id }),
      markDmThreadRead: (personUid) =>
        call('mark_dm_thread_read', { withPersonUid: personUid }),
      searchMessages: async (q, opts) => {
        const result = await call<unknown>('search_messages', {
          q,
          companyUid: opts?.companyUid,
          limit: opts?.limit,
        });
        if (!result.ok) return result;
        return ok(unwrapNamedArray(result.value, ['results', 'hits']));
      },
      fetchChannel: ({ channelId, limit, cursor, since }) => {
        if (since) {
          return hqProJson(
            'GET',
            withQuery(WEB_PATHS.channelMessages(channelId), {
              limit,
              cursor,
              since,
            }),
          );
        }
        return call('fetch_channel', {
          channelId,
          limit,
          cursor: cursor ?? null,
        });
      },
      listChannelMembers: (channelId) =>
        call('list_channel_members', { channelId }),
      sendChannelMessage: (channelId, body, extras) => {
        const mentions = extras?.mentions;
        const attachments = extras?.attachments;
        if (
          (mentions && mentions.length > 0) ||
          (attachments && attachments.length > 0)
        ) {
          return hqProJson('POST', WEB_PATHS.channelMessages(channelId), {
            body,
            ...(mentions && mentions.length > 0 ? { mentions } : {}),
            ...(attachments && attachments.length > 0 ? { attachments } : {}),
          });
        }
        return call('send_channel_message', { channelId, body });
      },
      fetchDmThread: ({ withPersonUid, limit, since }) => {
        if (since) {
          return hqProJson(
            'GET',
            withQuery(WEB_PATHS.dmThread, { withPersonUid, limit, since }),
          );
        }
        return call('fetch_dm_thread', { withPersonUid, limit });
      },
      sendDm: (toPersonUid, body, extras) => {
        const attachments = extras?.attachments;
        if (attachments && attachments.length > 0) {
          return hqProJson('POST', WEB_PATHS.dmSend, {
            toPersonUid,
            body,
            attachments,
          });
        }
        return call('send_dm', { toPersonUid, body });
      },
      fetchReplyThread: async (args) => {
        const invalid = validateFetchReplyThread(args);
        if (invalid) return invalid;
        const result = await call<Json>('fetch_thread', {
          scope: args.scope,
          rootEventId: args.rootEventId,
          channelId: args.channelId ?? null,
          withPersonUid: args.withPersonUid ?? null,
        });
        if (!result.ok) return result;
        const rec = asRecord(result.value) ?? {};
        return ok(
          normalizeReplyThreadValue({
            ...rec,
            scope: args.scope,
          }),
        );
      },
      sendReply: async (args) => {
        const invalid = validateSendReply(args);
        if (invalid) return invalid;
        const mentions = args.mentions;
        const attachments = args.attachments;
        if (
          (mentions && mentions.length > 0) ||
          (attachments && attachments.length > 0)
        ) {
          const req = buildSendReplyRequest(args);
          return hqProJson('POST', req.path, req.body);
        }
        return call('send_thread_reply', {
          scope: args.scope,
          rootEventId: args.rootEventId,
          body: args.body,
          channelId: args.channelId ?? null,
          toPersonUid: args.withPersonUid ?? null,
        });
      },
      fetchReactions: async (messageScope, messageId) => {
        const result = await call<unknown>('fetch_reactions', {
          messageScope,
          messageId,
        });
        if (!result.ok) return result;
        if (Array.isArray(result.value)) {
          return ok({ reactions: result.value } as Json);
        }
        return ok((asRecord(result.value) ?? { reactions: [] }) as Json);
      },
      toggleReaction: ({ messageScope, messageId, emoji, add }) =>
        call('toggle_reaction', { messageScope, messageId, emoji, add }),
    },

    notifications: {
      fetchNotifications: async (opts) => {
        const rec = asRecord(opts) ?? {};
        const rawLimit = rec.limit;
        const limit =
          typeof rawLimit === 'number'
            ? rawLimit
            : typeof rawLimit === 'string' && rawLimit.trim()
              ? Number(rawLimit)
              : undefined;
        const result = await call<unknown>('fetch_notifications', {
          ...(typeof limit === 'number' && Number.isFinite(limit) ? { limit } : {}),
          ...(typeof rec.cursor === 'string' && rec.cursor.trim()
            ? { cursor: rec.cursor }
            : {}),
          unreadOnly: rec.unreadOnly ?? rec.unread_only,
        });
        if (!result.ok) return result;
        return ok(normalizeNotificationsFeed(result.value));
      },
      ack: (id) => call('ack_notification', { id }),
      readAll: () => call('read_all_notifications'),
      runAction: (id, action, actionRef) =>
        call('run_notification_action', {
          id,
          actionKind: action,
          ...(typeof actionRef === 'string' && actionRef.trim()
            ? { actionRef }
            : {}),
        }),
      fetchDmInbox: (opts) => {
        const rec = asRecord(opts) ?? {};
        return hqProJson(
          'GET',
          withQuery(WEB_PATHS.dmInbox, {
            limit: typeof rec.limit === 'number' ? rec.limit : undefined,
            cursor: typeof rec.cursor === 'string' ? rec.cursor : undefined,
            since: typeof rec.since === 'string' ? rec.since : undefined,
          }),
        );
      },
      ackDmInbox: (eventIds) =>
        hqProJson('POST', WEB_PATHS.dmInboxAck, { eventIds }),
      fetchDmThreads: (opts) => {
        const rec = asRecord(opts) ?? {};
        const limit =
          typeof rec.limit === 'number'
            ? rec.limit
            : typeof rec.limit === 'string' && /^\d+$/.test(rec.limit)
              ? Number(rec.limit)
              : undefined;
        return hqProJson(
          'GET',
          withQuery(WEB_PATHS.dmThreads, {
            limit,
            cursor: typeof rec.cursor === 'string' ? rec.cursor : undefined,
          }),
        );
      },
      fetchSharedWithMe: (opts) => {
        const rec = asRecord(opts) ?? {};
        return hqProJson(
          'GET',
          withQuery(WEB_PATHS.sharedWithMe, {
            limit: typeof rec.limit === 'number' ? rec.limit : undefined,
            cursor: typeof rec.cursor === 'string' ? rec.cursor : undefined,
            since: typeof rec.since === 'string' ? rec.since : undefined,
          }),
        );
      },
      ackSharedWithMe: (eventIds) =>
        hqProJson('POST', WEB_PATHS.sharedWithMeAck, { eventIds }),
    },

    meetings: {
      listMemberships: () => call('meetings_list_memberships'),
      listUpcoming: () => call('meetings_list_upcoming'),
      listScheduledBots: () => call('meetings_list_scheduled_bots'),
      inviteBot: (payload) => {
        const rec = asRecord(payload) ?? {};
        return call('meetings_invite_bot', {
          meetingUrl: rec.meetingUrl ?? rec.meeting_url,
          calendarEventId: rec.calendarEventId ?? rec.calendar_event_id ?? null,
          calendarSeriesId:
            rec.calendarSeriesId ?? rec.calendar_series_id ?? null,
          companyId:
            rec.companyId ?? rec.company_id ?? rec.companyUid ?? null,
        });
      },
      cancelBot: (id) => call('meetings_cancel_bot', { botId: id }),
      joinBotNow: (payload) => {
        const rec = asRecord(payload) ?? {};
        return call('meetings_join_bot_now', {
          meetingUrl: rec.meetingUrl ?? rec.meeting_url,
          calendarEventId: rec.calendarEventId ?? rec.calendar_event_id ?? null,
          calendarSeriesId:
            rec.calendarSeriesId ?? rec.calendar_series_id ?? null,
          companyId:
            rec.companyId ?? rec.company_id ?? rec.companyUid ?? null,
        });
      },
      listAccounts: () => call('meetings_list_accounts'),
      listCalendars: (account) =>
        call('meetings_list_calendars_for_account', { accountId: account }),
      connectCalendar: () => hqProJson('POST', WEB_PATHS.googleConnect),
      disconnectCalendar: (accountId) =>
        hqProJson('DELETE', WEB_PATHS.googleAccount(accountId)),
    },

    marketplace: {
      listListings: (opts) =>
        call('list_marketplace_listings', { opts }),
      getListing: (id) => call('get_marketplace_listing', { id }),
      publishPack: (path) => call('publish_marketplace_pack', { path }),
      recordInstall: (listingId, payload) => {
        const details = asRecord(payload);
        const scope = details?.scope;
        if (scope === 'personal') {
          return call('record_marketplace_install', {
            listingId,
            scope: { kind: 'personal' },
          });
        }
        if (scope === 'company' && typeof details?.companySlug === 'string') {
          return call('record_marketplace_install', {
            listingId,
            scope: { kind: 'company', slug: details.companySlug },
          });
        }
        return Promise.resolve(
          failure('invalid-argument', 'Marketplace install scope is required.'),
        );
      },
      yank: (id, reason) => call('yank_marketplace_listing', { id, reason }),
      getCreatorProfile: (handle) =>
        call('get_creator_profile', { handle }),
      getMyCreator: () => call('get_my_creator'),
      claimHandle: (handle) => call('claim_creator_handle', { handle }),
      updateCreatorProfile: (payload) => {
        const profile = asRecord(payload) ?? {};
        return call('update_creator_profile', {
          bio: typeof profile.bio === 'string' ? profile.bio : null,
          socialLinks: Array.isArray(profile.socialLinks) ? profile.socialLinks : null,
          tipUrl: typeof profile.tipUrl === 'string' ? profile.tipUrl : null,
        });
      },
      uploadCreatorAvatar: (filePath) =>
        typeof filePath === 'string'
          ? call('upload_creator_avatar', { filePath })
          : Promise.resolve(
              failure(
                'invalid-argument',
                'Sync avatar uploads require a file path.',
              ),
            ),
      requestCreatorAccess: (payload) => {
        const request = asRecord(payload) ?? {};
        return call('request_creator_access', {
          reason: typeof request.reason === 'string' ? request.reason : null,
          handle: typeof request.handle === 'string' ? request.handle : null,
        });
      },
      listCreatorApplications: () => call('list_creator_applications'),
      decideCreatorApplication: (id, decision) =>
        call('decide_creator_application', { id, decision }),
      listModerationQueue: () => call('list_moderation_queue'),
      decideModerationListing: (id, decision) =>
        call('decide_moderation_listing', { id, decision }),
      installPack: (payload) => {
        const pack = asRecord(payload);
        if (typeof pack?.slug !== 'string' || !pack.scope) {
          return Promise.resolve(
            failure('invalid-argument', 'Marketplace pack slug and scope are required.'),
          );
        }
        return call('install_marketplace_pack', {
          slug: pack.slug,
          version: pack.version,
          scope: pack.scope,
        });
      },
    },

    company: {
      getDeployments: (slug) => call('get_company_deployments', { slug }),
      getSecrets: (slug) => call('get_company_secrets', { slug }),
      listMembers: (slug) =>
        call('list_company_members', { companyUid: slug }),
      getTeamTelemetry: (slug) =>
        call('get_company_team_telemetry', { slug }),
      claimPendingInvite: (slug) =>
        call('claim_pending_company_invite', { slug }),
      connectToCloud: (slug) =>
        call('connect_workspace_to_cloud', { slug }),
      getSummary: (slug) => call('get_company_summary', { slug }),
      getBoard: (slug) => call('get_company_board', { slug }),
      getActivity: (slug) => call('get_company_activity', { slug }),
    },

    projects: {
      listProjects: () => call('get_local_projects'),
      getGoals: (slug) =>
        call('get_local_company_goals', { companySlug: slug }),
      getPrd: (path) => call('get_local_project_prd', { prdPath: path }),
      getReadme: (path) => call('get_local_project_readme', { prdPath: path }),
      setProjectStatus: (projectRef, status) => {
        let identity: Record<string, unknown>;
        try {
          identity = JSON.parse(projectRef) as Record<string, unknown>;
        } catch {
          return Promise.resolve(
            failure('invalid-argument', 'Project identity must be JSON-encoded.'),
          );
        }
        if (
          typeof identity.boardPath !== 'string' ||
          typeof identity.projectId !== 'string'
        ) {
          return Promise.resolve(
            failure('invalid-argument', 'Project identity is missing boardPath or projectId.'),
          );
        }
        return call('set_local_project_status', {
          boardPath: identity.boardPath,
          projectId: identity.projectId,
          prdPath: typeof identity.prdPath === 'string' ? identity.prdPath : null,
          status,
        });
      },
      setStoryPasses: (path, storyId, passes) =>
        call('set_local_story_passes', { prdPath: path, storyId, passes }),
      getProjectCreators: (slug) =>
        call('get_company_project_creators', { slug }),
    },

    library: {
      getRoot: () => call('get_library_root'),
      getCompany: (slug) => call('get_library_company', { companySlug: slug }),
      getWorkerDetail: (path) =>
        call('get_library_worker_detail', { workerPath: path }),
      getSkillDetail: (path) =>
        call('get_library_skill_detail', { skillPath: path }),
    },

    files: {
      listDir: (relPath) => call('list_hq_dir', { relPath }),
      getFileContent: (path) => call('get_company_file_content', { path }),
      listVaultPrefix: (companyUid, prefix) =>
        hqProJson(
          'GET',
          withQuery(WEB_PATHS.filesList, {
            company: companyUid,
            prefix,
          }),
        ),
      presignVaultGet: (companyUid, key) =>
        hqProJson('POST', WEB_PATHS.filesPresign, {
          company: companyUid,
          op: 'get',
          key,
        }),
      presignVaultPut: (companyUid, key, contentType) =>
        hqProJson('POST', WEB_PATHS.filesPresign, {
          company: companyUid,
          op: 'put',
          key,
          contentType,
        }),
      getAuthorizedPreview: (path) =>
        call('get_authorized_file_preview', { path }),
      revealInFinder: (path) => call('reveal_authorized_file', { path }),
      revealHqRoot: () => call('reveal_hq_root'),
    },

    agency: {
      listTeams: () => call('list_agency_teams'),
      listQuestions: () => call('list_agency_questions'),
      listChat: async (team) => {
        const company = await activeCompany();
        if (!company.ok) return company;
        return call('list_agency_chat', { company: company.value, team });
      },
      answerQuestion: async (id, answer) => {
        const company = await activeCompany();
        if (!company.ok) return company;
        // Rust takes team explicitly and `answer` as a plain string.
        const rec = asRecord(answer) ?? {};
        const team = String(rec.team ?? '');
        if (!team) {
          return failure('invalid-argument', 'answer payload is missing team');
        }
        return call('answer_agency_question', {
          company: company.value,
          team,
          id,
          answer: String(rec.answer ?? rec.text ?? ''),
        });
      },
      sendMessage: async (team, message) => {
        const company = await activeCompany();
        if (!company.ok) return company;
        const rec = asRecord(message) ?? {};
        return call('send_agency_message', {
          company: company.value,
          team,
          text: String(rec.text ?? rec.message ?? ''),
        });
      },
    },

    feedback: {
      submitBugReport: (title, body) =>
        call('submit_bug_report', { title, body }),
    },

    sync: {
      startDaemon: () => call('start_daemon'),
      stopDaemon: () => call('stop_daemon'),
      daemonStatus: () => call('daemon_status'),
      startSync: (slug) =>
        call('start_sync', slug ? { companySlug: slug } : undefined),
      cancelSync: () => call('cancel_sync'),
      getSyncStatus: () => call('get_sync_status'),
      getActivityLog: () => call('get_activity_log'),
      resolveConflict: (path, strategy) =>
        call('resolve_conflict', { path, strategy }),
      restoreFromUpstream: async (args) => {
        const rec = asRecord(args) ?? {};
        const path = String(rec.path ?? '');
        if (!path) {
          return failure('invalid-argument', 'restore payload is missing path');
        }
        return call('restore_from_upstream', {
          path,
          expectedUpstreamSha: rec.expectedUpstreamSha ?? null,
          targetRepo: rec.targetRepo ?? null,
          targetRef: rec.targetRef ?? null,
        });
      },
      beginReauth: () => call('begin_reauth'),
      listSyncableWorkspaces: () => call('list_syncable_workspaces'),
    },

    shell: {
      openInEditor: (path) => call('open_in_editor', { path }),
      openClaudeCodeLink: (url) => call('open_claude_code_link', { url }),
      openFileInClaude: (path) =>
        call('open_authorized_file_in_claude', { path }),
      launchClaudeCode: (path) => call('launch_claude_code', { path }),
      launchCodexWorkspace: (path, prompt) =>
        call('launch_codex_workspace', { path, prompt: prompt ?? null }),
      launchCliInTerminal: async (args) => {
        const rec = asRecord(args) ?? {};
        const path = String(rec.path ?? '');
        const tool = String(rec.tool ?? '');
        if (!path || !tool) {
          return failure('invalid-argument', 'launch payload needs path and tool');
        }
        return call('launch_cli_in_terminal', { path, tool });
      },
      detectAiTools: () => call('detect_ai_tools'),
      pickFolder: () => call('pick_folder'),
      pickFile: (kind) =>
        kind === 'image'
          ? call('pick_avatar_file')
          : Promise.resolve(
              unavailable(
                'unsupported-file-kind',
                'Sync only provides a native image picker for creator avatars.',
              ),
            ),
    },

    appShell: {
      setTrayState: (state) => call('set_tray_state', { state }),
      showMainWindow: () => call('show_main_window'),
      quitApp: () => call('quit_app'),
      setDockVisible: (visible) =>
        persistThenApplyAppShellPreference(
          'dockIcon',
          visible,
          'apply_dock_icon',
        ),
      setAutostart: (enabled) =>
        call('set_autostart_enabled', { enabled }),
      consumePendingRoute: () => call('desktop_alt_consume_pending_route'),
      takePendingMessagesTarget: () =>
        call('take_pending_messages_target'),
      setActiveCompany: (slug) =>
        call('set_desktop_active_company', { companySlug: slug }),
      openDriftDetail: (report) => call('open_drift_detail', { report }),
      openMeetingPermissionsWindow: () =>
        call('open_meeting_permissions_window'),
      notificationPermissionState: () =>
        call('notification_permission_state'),
      requestNotificationPermission: () =>
        call('notification_request_permission'),
      openNotificationSettings: () => call('notification_open_settings'),
      setDesktopWidget: (enabled) =>
        persistThenApplyAppShellPreference(
          'widgetEnabled',
          enabled,
          'apply_widget_settings',
        ),
      showOsNotification: async () => HOST_OWNED,
    },

    updates: {
      getVersions,
      checkForUpdates: () => call('check_for_updates'),
      installUpdate: () => call('install_update'),
      getPendingUpdate: () => call('get_pending_update'),
      checkCoreState: () => call('check_core_state'),
      installCoreUpdate: () => call('install_hq_core_update'),
      replaceFromStaging: () => call('run_replace_from_staging'),
      checkCliUpdate: () => call('check_hq_cli_update'),
      installCliUpdate: () => call('install_hq_cli_update'),
      // Rust persists the dismissed release, so it needs the version. The
      // contract passes nothing, so resolve the pending update first —
      // otherwise the same notice reappears on every launch.
      dismissCliUpdate: async () => {
        const pending = await call<Json | null>('check_hq_cli_update');
        if (!pending.ok) return pending;
        const version = String(asRecord(pending.value)?.latest ?? '');
        if (!version) {
          return failure('no-pending-update', 'No CLI update to dismiss.');
        }
        return call('set_hq_cli_update_dismissed', { version });
      },
      availableChannels: () => call('available_channels'),
    },

    packages: {
      listPackages: () => call('list_packages'),
      listPackagesCached: () => call('list_packages_cached'),
      install: ({ source, registry }) =>
        call('install_package', {
          source,
          ...(registry ? { registry: true } : {}),
        }),
      update: (name) => call('update_package', { name }),
      uninstall: (name) => call('uninstall_package', { name }),
      checkUpdates: () => call('check_package_updates'),
      updatePacks: (names) => call('update_packs', { names }),
    },

    sessions: {
      listAgentSessions: () => call('list_agent_sessions'),
    },

    settings: {
      getConfig: () => call('get_config'),
      getSettings: () => call('get_settings'),
      updateSettings: async (patch) => {
        const settingsInvoker: SettingsInvoker = <T>(
          command: string,
          args?: Record<string, unknown>,
        ) => invokeFn(command, args) as Promise<T>;
        try {
          await updateSettings(patch, settingsInvoker);
          return ok(undefined);
        } catch (err) {
          return invokeError(err);
        }
      },
      getSetupStatus: () => call('get_setup_status'),
      getTelemetryConsent: () => call('get_telemetry_consent_status'),
    },

    workMesh: {
      readLocalSnapshot: async () => NOT_MAPPED,
      getProjectView: (projectId, companyUid) =>
        hqProJson(
          'GET',
          withQuery(WEB_PATHS.workMeshProject(projectId.trim()), {
            companyUid: companyUid?.trim() || null,
          }),
        ),
    },
  };

  return adapter;
}

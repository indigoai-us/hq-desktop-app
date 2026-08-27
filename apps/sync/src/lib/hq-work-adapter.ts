/**
 * Sync-side PlatformAdapter (US-102).
 *
 * Maps HQ Work's PlatformAdapter onto existing Sync Tauri commands and the
 * authenticated hq-pro client in Rust. The webview never holds the bearer and
 * must not grow a second fetch stack.
 */

import {
  type AdapterPromise,
  type Capability,
  type ChannelSummary,
  type Json,
  type NotificationItem,
  type PlatformAdapter,
  type WhoAmI,
  TAURI_CAPABILITIES,
  WEB_PATHS,
  buildSendReplyRequest,
  failure,
  normalizeReplyThreadValue,
  ok,
  unavailable,
  validateFetchReplyThread,
  validateSendReply,
} from '@hq/platform';

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
  );
  const email = String(rec.email ?? '');
  const displayNameRaw = rec.displayName ?? rec.name;
  const displayName =
    typeof displayNameRaw === 'string' && displayNameRaw.trim()
      ? displayNameRaw
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

function asNotificationItem(row: Json): NotificationItem {
  const status = String(row.status ?? '');
  const readAt = row.readAt ?? row.read_at;
  const read =
    row.read === true ||
    status === 'read' ||
    (typeof readAt === 'string' && readAt.length > 0);
  return {
    ...row,
    id: String(row.id ?? ''),
    title: String(row.title ?? row.body ?? ''),
    read,
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

  const adapter: PlatformAdapter = {
    kind: 'desktop',
    capabilities: TAURI_CAPABILITIES,
    isAvailable: (cap: Capability): boolean => TAURI_CAPABILITIES[cap],

    identity: {
      whoami: async () => {
        const auth = await call<{ authenticated?: boolean }>('get_auth_state');
        if (!auth.ok) return auth;
        if (!auth.value?.authenticated) {
          return failure('unauthenticated', 'Not signed in');
        }
        const me = await hqProJson<Json>('GET', WEB_PATHS.whoami);
        if (!me.ok) return me;
        return ok(asWhoAmI(me.value));
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
    },

    messaging: {
      listChannels: async () => {
        const result = await call<unknown>('list_channels');
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
      listContacts: async () => {
        const result = await call<unknown>('list_contacts');
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
        const extra = args as { attachments?: Json[] };
        if (extra.attachments && extra.attachments.length > 0) {
          const req = buildSendReplyRequest({
            scope: args.scope,
            rootEventId: args.rootEventId,
            body: args.body,
            withPersonUid: args.withPersonUid,
            channelId: args.channelId,
            attachments: extra.attachments,
          });
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
        const result = await call<unknown>('fetch_notifications', {
          limit: rec.limit,
          cursor: rec.cursor,
          unreadOnly: rec.unreadOnly ?? rec.unread_only,
        });
        if (!result.ok) return result;
        return ok(
          unwrapNamedArray(result.value, ['notifications']).map(
            asNotificationItem,
          ),
        );
      },
      ack: (id) => call('ack_notification', { id }),
      readAll: () => call('read_all_notifications'),
      runAction: (id, action) =>
        call('run_notification_action', { id, actionKind: action }),
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
      recordInstall: (id, payload) =>
        call('record_marketplace_install', { id, payload }),
      yank: (id) => call('yank_marketplace_listing', { id }),
      getCreatorProfile: (handle) =>
        call('get_creator_profile', { handle }),
      getMyCreator: () => call('get_my_creator'),
      claimHandle: (handle) => call('claim_creator_handle', { handle }),
      updateCreatorProfile: (p) => call('update_creator_profile', { p }),
      uploadCreatorAvatar: (data) =>
        call('upload_creator_avatar', { data }),
      requestCreatorAccess: () => call('request_creator_access'),
      listCreatorApplications: () => call('list_creator_applications'),
      decideCreatorApplication: (id, decision) =>
        call('decide_creator_application', { id, decision }),
      listModerationQueue: () => call('list_moderation_queue'),
      decideModerationListing: (id, decision) =>
        call('decide_moderation_listing', { id, decision }),
      installPack: (listing) =>
        call('install_marketplace_pack', { listing }),
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
      getGoals: (slug) => call('get_local_company_goals', { slug }),
      getPrd: (path) => call('get_local_project_prd', { path }),
      getReadme: (path) => call('get_local_project_readme', { path }),
      setProjectStatus: (slug, status) =>
        call('set_local_project_status', { slug, status }),
      setStoryPasses: (path, storyId, passes) =>
        call('set_local_story_passes', { path, storyId, passes }),
      getProjectCreators: (slug) =>
        call('get_company_project_creators', { slug }),
    },

    library: {
      getRoot: () => call('get_library_root'),
      getCompany: (slug) => call('get_library_company', { slug }),
      getWorkerDetail: (path) =>
        call('get_library_worker_detail', { path }),
      getSkillDetail: (path) => call('get_library_skill_detail', { path }),
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
    },

    agency: {
      listTeams: () => call('list_agency_teams'),
      listQuestions: () => call('list_agency_questions'),
      listChat: (team) => call('list_agency_chat', { team }),
      answerQuestion: (id, answer) =>
        call('answer_agency_question', { id, answer }),
      sendMessage: (team, message) =>
        call('send_agency_message', { team, message }),
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
      restoreFromUpstream: (args) =>
        call('restore_from_upstream', { args }),
      beginReauth: () => call('begin_reauth'),
      listSyncableWorkspaces: () => call('list_syncable_workspaces'),
    },

    shell: {
      openInEditor: (path) => call('open_in_editor', { path }),
      openClaudeCodeLink: (url) => call('open_claude_code_link', { url }),
      openFileInClaude: (path) =>
        call('open_authorized_file_in_claude', { path }),
      launchClaudeCode: (path) => call('launch_claude_code', { path }),
      launchCliInTerminal: (args) =>
        call('launch_cli_in_terminal', { args }),
      detectAiTools: () => call('detect_ai_tools'),
      pickFolder: () => call('pick_folder'),
      pickFile: async () => NOT_MAPPED,
    },

    appShell: {
      setTrayState: (state) => call('set_tray_state', { state }),
      showMainWindow: () => call('show_main_window'),
      quitApp: () => call('quit_app'),
      applyDockIcon: () => call('apply_dock_icon'),
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
    },

    updates: {
      getVersions: () => call('get_hq_version'),
      checkForUpdates: () => call('check_for_updates'),
      installUpdate: () => call('install_update'),
      getPendingUpdate: () => call('get_pending_update'),
      checkCoreState: () => call('check_core_state'),
      installCoreUpdate: () => call('install_hq_core_update'),
      replaceFromStaging: () => call('run_replace_from_staging'),
      checkCliUpdate: () => call('check_hq_cli_update'),
      installCliUpdate: () => call('install_hq_cli_update'),
      dismissCliUpdate: () => call('set_hq_cli_update_dismissed'),
      availableChannels: () => call('available_channels'),
    },

    packages: {
      listPackages: () => call('list_packages'),
      install: (source) => call('install_package', { source }),
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

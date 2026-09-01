/**
 * TauriPlatformAdapter — implements PlatformAdapter over Tauri `invoke()`.
 *
 * No @tauri-apps dependency: the invoke function is constructor-injected
 * (full wiring lands in US-011). Each method maps to its audited command
 * name and wraps the result in the shared AdapterResult contract.
 */

import {
  buildReplyThreadPath,
  buildSendReplyRequest,
  failure,
  normalizeReplyThreadValue,
  normalizeNotificationsFeed,
  ok,
  unavailable,
  validateFetchReplyThread,
  validateSendReply,
  type AdapterPromise,
  type Json,
  type PlatformAdapter,
} from "../adapter.js";
import { TAURI_CAPABILITIES, type Capability } from "../capabilities.js";

/** Meetings are cloud-backed — desktop composite routes them via web.meetings. */
const MEETINGS_USE_CLOUD = unavailable(
  "use-cloud",
  "Meetings go through hq-pro REST via the desktop composite adapter.",
);

function membershipRowsFromPayload(value: unknown): Json[] {
  if (Array.isArray(value)) {
    return value.filter(
      (item): item is Json =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    );
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of ["memberships", "companies", "workspaces"] as const) {
      if (Array.isArray(record[key])) return membershipRowsFromPayload(record[key]);
    }
  }
  return [];
}

export type InvokeFn = (
  cmd: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

export interface TauriPlatformAdapterConfig {
  invoke: InvokeFn;
}

export class TauriPlatformAdapter implements PlatformAdapter {
  readonly kind = "desktop" as const;
  readonly capabilities = TAURI_CAPABILITIES;

  private readonly invokeFn: InvokeFn;
  /** Serializes get-settings → merge → save across generic desktop callers. */
  private settingsMutationTail: Promise<void> = Promise.resolve();

  constructor(config: TauriPlatformAdapterConfig) {
    this.invokeFn = config.invoke;
  }

  isAvailable(cap: Capability): boolean {
    return this.capabilities[cap];
  }

  /** Invoke a Tauri command, wrapping the outcome in the result contract. */
  private async call<T>(
    cmd: string,
    args?: Record<string, unknown>,
  ): AdapterPromise<T> {
    try {
      return ok((await this.invokeFn(cmd, args)) as T);
    } catch (err) {
      return failure(
        "invoke",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private queueSettingsPatch(patch: Json): AdapterPromise<void> {
    const capturedPatch = { ...(patch as Record<string, unknown>) };
    const operation = this.settingsMutationTail.then(async () => {
      const current = await this.call<Json>("get_settings");
      if (!current.ok) return current;
      return this.call<void>("save_settings", {
        prefs: { ...(current.value as Record<string, unknown>), ...capturedPatch },
      });
    });
    // A rejected operation must never strand later settings changes.
    this.settingsMutationTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async persistThenApplyPreference(
    key: "dockIcon" | "widgetEnabled",
    value: boolean,
    command: "apply_dock_icon" | "apply_widget_settings",
  ): AdapterPromise<void> {
    const saved = await this.queueSettingsPatch({ [key]: value });
    if (!saved.ok) return saved;
    return this.call(command);
  }

  /**
   * Cloud REST via the existing async `hq_pro_fetch` command. Never add a
   * sync fetch_reply_thread / send_reply command.
   */
  private async hqProJson<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): AdapterPromise<T> {
    const raw = await this.call<unknown>("hq_pro_fetch", {
      url: path,
      method,
      body: body === undefined ? null : JSON.stringify(body),
    });
    if (!raw.ok) return raw;
    const rec =
      raw.value && typeof raw.value === "object" && !Array.isArray(raw.value)
        ? (raw.value as Record<string, unknown>)
        : null;
    if (rec && typeof rec.status === "number") {
      const text = typeof rec.body === "string" ? rec.body : "";
      if (rec.status < 200 || rec.status >= 300) {
        let code = `http-${rec.status}`;
        let message = `${method} ${path} failed`;
        try {
          const parsed = text ? JSON.parse(text) : null;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const err = parsed as Record<string, unknown>;
            if (typeof err.code === "string" && err.code.trim()) {
              code = err.code.trim();
            }
            if (typeof err.error === "string" && err.error.trim()) {
              message = err.error.trim();
            }
          }
        } catch {
          /* keep http-status defaults */
        }
        return failure(code, message);
      }
      try {
        return ok((text ? JSON.parse(text) : undefined) as T);
      } catch (err) {
        return failure(
          "network",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return ok(raw.value as T);
  }

  readonly identity: PlatformAdapter["identity"] = {
    whoami: () => this.hqProJson("GET", "/v1/identity/whoami"),
    isAdmin: () => this.call("is_admin"),
    hasFeature: (flag) => this.call("has_feature", { flag }),
    listWorkspaces: async () => {
      const result = await this.hqProJson<Json>("GET", "/membership/me");
      if (!result.ok) return result;
      return ok(membershipRowsFromPayload(result.value));
    },
    getProfile: () => this.hqProJson("GET", "/v1/profile"),
    updateProfile: (input) => this.hqProJson("PUT", "/v1/profile", input),
  };

  readonly messaging: PlatformAdapter["messaging"] = {
    listChannels: (opts) =>
      this.call("list_channels", {
        companyUid: opts?.companyUid,
        includeCompanyProjects: opts?.includeCompanyProjects,
      }),
    fetchChannelDirectory: (cursor) =>
      this.call("fetch_channel_directory", { cursor }),
    // No create_channel Tauri command exists — route through hq-pro REST like
    // replies/reactions.
    createChannel: (payload) =>
      this.hqProJson("POST", "/v1/notify/channels", payload),
    addChannelMember: (channelId, toPersonUid) =>
      this.hqProJson(
        "POST",
        `/v1/notify/channels/${encodeURIComponent(channelId)}/members`,
        { toPersonUid },
      ),
    removeChannelMember: (channelId, personUid) =>
      this.hqProJson(
        "DELETE",
        `/v1/notify/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(personUid)}`,
      ),
    // Scoped reads go through the existing company-scoped command rather than
    // a new IPC surface: list_company_members is GET /v1/notify/contacts
    // ?companyUid=… and is already registered + capability-listed.
    listContacts: (opts) => {
      const companyUid = opts?.companyUid?.trim();
      return companyUid
        ? this.call("list_company_members", { companyUid })
        : this.call("list_contacts");
    },
    listDmRequests: () => this.call("list_dm_requests"),
    markChannelRead: (id) => this.call("mark_channel_read", { id }),
    markDmThreadRead: (personUid) =>
      this.call("mark_dm_thread_read", { personUid }),
    searchMessages: (q, opts) =>
      this.call("search_messages", {
        q,
        companyUid: opts?.companyUid,
        limit: opts?.limit,
      }),
    fetchChannel: ({ channelId, limit, cursor, since }) =>
      this.call("fetch_channel", {
        channelId,
        limit,
        cursor: cursor ?? null,
        since: since ?? null,
      }),
    listChannelMembers: (channelId) =>
      this.call("list_channel_members", { channelId }),
    sendChannelMessage: (channelId, body, extras) =>
      this.call("send_channel_message", {
        channelId,
        body,
        mentions: extras?.mentions ?? null,
        attachments: extras?.attachments ?? null,
      }),
    fetchDmThread: ({ withPersonUid, limit, since }) =>
      this.call("fetch_dm_thread", {
        withPersonUid,
        limit,
        since: since ?? null,
      }),
    sendDm: (toPersonUid, body, extras) =>
      this.call("send_dm", {
        toPersonUid,
        body,
        attachments: extras?.attachments ?? null,
      }),
    fetchReplyThread: async (args) => {
      const invalid = validateFetchReplyThread(args);
      if (invalid) return invalid;
      const result = await this.hqProJson<Json>(
        "GET",
        buildReplyThreadPath(args),
      );
      if (!result.ok) return result;
      return ok(normalizeReplyThreadValue(result.value));
    },
    sendReply: async (args) => {
      const invalid = validateSendReply(args);
      if (invalid) return invalid;
      const req = buildSendReplyRequest(args);
      return this.hqProJson<Json>("POST", req.path, req.body);
    },
    // Reactions route through the same hq-pro endpoint the web adapter uses.
    // fetchReactions was previously stubbed to `ok({ reactions: [] })`, which
    // was worse than a no-op: the host reconciles against fetchReactions after
    // every toggle, so the "success" empty list wiped the optimistic reaction
    // (and everyone else's) from the open row on desktop.
    fetchReactions: (messageScope, messageId) =>
      this.hqProJson(
        "GET",
        `/v1/notify/reactions?messageScope=${encodeURIComponent(messageScope)}&messageId=${encodeURIComponent(messageId)}`,
      ),
    toggleReaction: ({ messageScope, messageId, emoji, add }) =>
      this.hqProJson(add ? "POST" : "DELETE", "/v1/notify/reactions", {
        messageScope,
        messageId,
        emoji,
      }),
  };

  readonly notifications: PlatformAdapter["notifications"] = {
    fetchNotifications: async (opts) => {
      const result = await this.call<unknown>("fetch_notifications", opts);
      if (!result.ok) return result;
      return ok(normalizeNotificationsFeed(result.value));
    },
    ack: (id) => this.call("ack_notification", { id }),
    readAll: () => this.call("read_all_notifications"),
    runAction: (id, action, actionRef) =>
      this.call("run_notification_action", {
        id,
        actionKind: action,
        ...(typeof actionRef === "string" && actionRef.trim()
          ? { actionRef }
          : {}),
      }),
    fetchDmInbox: (opts) => this.call("fetch_dm_inbox", { opts }),
    ackDmInbox: (eventIds) => this.call("ack_dm_inbox", { eventIds }),
    fetchSharedWithMe: (opts) => this.call("fetch_shared_with_me", { opts }),
    ackSharedWithMe: (eventIds) =>
      this.call("ack_shared_with_me", { eventIds }),
  };

  // Dead-surface cleanup: no Rust meetings commands are registered. Desktop
  // createDesktopAdapter already delegates this group to web.meetings (hq-pro).
  readonly meetings: PlatformAdapter["meetings"] = {
    listMemberships: async () => MEETINGS_USE_CLOUD,
    listUpcoming: async () => MEETINGS_USE_CLOUD,
    listScheduledBots: async () => MEETINGS_USE_CLOUD,
    inviteBot: async () => MEETINGS_USE_CLOUD,
    cancelBot: async () => MEETINGS_USE_CLOUD,
    joinBotNow: async () => MEETINGS_USE_CLOUD,
    listAccounts: async () => MEETINGS_USE_CLOUD,
    listCalendars: async () => MEETINGS_USE_CLOUD,
    connectCalendar: async () => MEETINGS_USE_CLOUD,
    disconnectCalendar: async () => MEETINGS_USE_CLOUD,
  };

  readonly marketplace: PlatformAdapter["marketplace"] = {
    listListings: (opts) => this.call("list_listings", { opts }),
    getListing: (id) => this.call("get_listing", { id }),
    publishPack: (path) => this.call("publish_pack", { path }),
    recordInstall: (id, payload) =>
      this.call("record_install", { id, payload }),
    yank: (id, reason) => this.call("yank_listing", { id, reason }),
    getCreatorProfile: (handle) => this.call("get_creator_profile", { handle }),
    getMyCreator: () => this.call("get_my_creator"),
    claimHandle: (handle) => this.call("claim_handle", { handle }),
    updateCreatorProfile: (p) =>
      this.call("update_creator_profile", {
        bio: p.bio,
        socialLinks: p.socialLinks,
        tipUrl: p.tipUrl,
      }),
    uploadCreatorAvatar: (data) => this.call("upload_creator_avatar", { data }),
    requestCreatorAccess: (payload) =>
      this.call("request_creator_access", {
        reason: payload.reason,
        handle: payload.handle,
      }),
    listCreatorApplications: () => this.call("list_creator_applications"),
    decideCreatorApplication: (id, decision) =>
      this.call("decide_creator_application", { id, decision }),
    listModerationQueue: () => this.call("list_moderation_queue"),
    decideModerationListing: (id, decision) =>
      this.call("decide_moderation_listing", { id, decision }),
    installPack: (listing) => this.call("install_pack", { listing }),
  };

  readonly company: PlatformAdapter["company"] = {
    getDeployments: (slug) => this.call("get_deployments", { slug }),
    getSecrets: (slug) => this.call("get_secrets", { slug }),
    listMembers: (slug) => this.call("list_members", { slug }),
    getTeamTelemetry: (slug) => this.call("get_team_telemetry", { slug }),
    claimPendingInvite: (slug) => this.call("claim_pending_invite", { slug }),
    connectToCloud: (slug) => this.call("connect_to_cloud", { slug }),
    getSummary: (slug) => this.call("get_summary", { slug }),
    getBoard: (slug) => this.call("get_board", { slug }),
    getActivity: (slug) => this.call("get_activity", { slug }),
  };

  readonly projects: PlatformAdapter["projects"] = {
    listProjects: () => this.call("list_projects"),
    getGoals: (slug) => this.call("get_goals", { slug }),
    getPrd: (path) => this.call("get_prd", { path }),
    getReadme: (path) => this.call("get_readme", { path }),
    setProjectStatus: (slug, status) =>
      this.call("set_project_status", { slug, status }),
    setStoryPasses: (path, storyId, passes) =>
      this.call("set_story_passes", { path, storyId, passes }),
    getProjectCreators: (slug) => this.call("get_project_creators", { slug }),
  };

  readonly library: PlatformAdapter["library"] = {
    getRoot: () => this.call("get_library_root"),
    getCompany: (slug) => this.call("get_library_company", { slug }),
    getWorkerDetail: (path) => this.call("get_worker_detail", { path }),
    getSkillDetail: (path) => this.call("get_skill_detail", { path }),
  };

  readonly files: PlatformAdapter["files"] = {
    listDir: (relPath) => this.call("list_dir", { relPath }),
    getFileContent: (path) => this.call("get_file_content", { path }),
    listVaultPrefix: async () =>
      ({
        ok: false,
        reason: "unavailable",
        code: "use-cloud",
      }) as const,
    presignVaultGet: async () =>
      ({
        ok: false,
        reason: "unavailable",
        code: "use-cloud",
      }) as const,
    presignVaultPut: async () =>
      ({
        ok: false,
        reason: "unavailable",
        code: "use-cloud",
      }) as const,
    getAuthorizedPreview: (path) =>
      this.call("get_authorized_preview", { path }),
    // The registered Tauri command is `reveal_folder`
    // (commands::launch::reveal_folder, main.rs invoke_handler). There has
    // never been a `reveal_in_finder` command — that name appeared only here,
    // so EVERY revealInFinder call rejected with "Command reveal_in_finder
    // not found" (silently, wherever the caller swallowed the error).
    revealInFinder: (path) => this.call("reveal_folder", { path }),
    revealHqRoot: () => this.call("reveal_hq_root"),
  };

  readonly agency: PlatformAdapter["agency"] = {
    listTeams: () => this.call("list_teams"),
    listQuestions: () => this.call("list_questions"),
    listChat: (team) => this.call("list_chat", { team }),
    answerQuestion: (id, answer) =>
      this.call("answer_question", { id, answer }),
    sendMessage: (team, message) =>
      this.call("send_message", { team, message }),
  };

  readonly feedback: PlatformAdapter["feedback"] = {
    submitBugReport: (title, body) =>
      this.call("submit_bug_report", { title, body }),
  };

  readonly sync: PlatformAdapter["sync"] = {
    startDaemon: () => this.call("start_daemon"),
    stopDaemon: () => this.call("stop_daemon"),
    daemonStatus: () => this.call("daemon_status"),
    startSync: (slug) => this.call("start_sync", { slug }),
    cancelSync: () => this.call("cancel_sync"),
    getSyncStatus: () => this.call("get_sync_status"),
    getActivityLog: () => this.call("get_activity_log"),
    resolveConflict: (path, strategy) =>
      this.call("resolve_conflict", { path, strategy }),
    restoreFromUpstream: (args) => this.call("restore_from_upstream", { args }),
    beginReauth: () => this.call("begin_reauth"),
    listSyncableWorkspaces: () => this.call("list_syncable_workspaces"),
  };

  readonly shell: PlatformAdapter["shell"] = {
    openInEditor: (path) => this.call("open_in_editor", { path }),
    openClaudeCodeLink: (url) => this.call("open_claude_code_link", { url }),
    openFileInClaude: (path) => this.call("open_file_in_claude", { path }),
    launchClaudeCode: (path) => this.call("launch_claude_code", { path }),
    launchCodexWorkspace: (path, prompt) =>
      this.call("launch_codex_workspace", { path, prompt: prompt ?? null }),
    launchCliInTerminal: (args) =>
      this.call("launch_cli_in_terminal", { args }),
    detectAiTools: () => this.call("detect_ai_tools"),
    pickFolder: () => this.call("pick_folder"),
    pickFile: (kind) => this.call("pick_file", { kind }),
  };

  readonly appShell: PlatformAdapter["appShell"] = {
    setTrayState: (state) => this.call("set_tray_state", { state }),
    showMainWindow: () => this.call("show_main_window"),
    quitApp: () => this.call("quit_app"),
    setDockVisible: (visible) =>
      this.persistThenApplyPreference("dockIcon", visible, "apply_dock_icon"),
    setAutostart: (enabled) => this.call("set_autostart_enabled", { enabled }),
    setDesktopWidget: (enabled) =>
      this.persistThenApplyPreference("widgetEnabled", enabled, "apply_widget_settings"),
    consumePendingRoute: () => this.call("consume_pending_route"),
    takePendingMessagesTarget: () => this.call("take_pending_messages_target"),
    setActiveCompany: (slug) => this.call("set_active_company", { slug }),
    openDriftDetail: (report) => this.call("open_drift_detail", { report }),
    // Command was never registered in generate_handler — structured unavailable
    // instead of an invoke throw that white-screens the settings panel.
    openMeetingPermissionsWindow: async () =>
      unavailable(
        "not-yet-implemented",
        "open_meeting_permissions_window is not registered.",
      ),
    notificationPermissionState: () =>
      this.call("notification_permission_state"),
    requestNotificationPermission: () =>
      this.call("notification_request_permission"),
    openNotificationSettings: () => this.call("notification_open_settings"),
    // Sync owns native notification delivery and there is no generic
    // `show_os_notification` command in its registered handler.
    showOsNotification: async () =>
      unavailable("host-owned", "The Sync host owns OS notification delivery."),
  };

  readonly updates: PlatformAdapter["updates"] = {
    getVersions: async () => {
      const [core, cli] = await Promise.all([
        this.call<string | null>("get_hq_version"),
        this.call<string | null>("get_hq_cli_version"),
      ]);
      return ok({
        ...(core.ok && core.value ? { core: core.value } : {}),
        ...(cli.ok && cli.value ? { cli: cli.value } : {}),
        coreProbe: core.ok
          ? { status: core.value ? "available" : "missing", value: core.value }
          : { status: "failed", code: core.code, message: core.message },
        cliProbe: cli.ok
          ? { status: cli.value ? "available" : "missing", value: cli.value }
          : { status: "failed", code: cli.code, message: cli.message },
      });
    },
    checkForUpdates: () => this.call("check_for_updates"),
    installUpdate: () => this.call("install_update"),
    getPendingUpdate: () => this.call("get_pending_update"),
    checkCoreState: () => this.call("check_core_state"),
    installCoreUpdate: () => this.call("install_hq_core_update"),
    replaceFromStaging: () => this.call("run_replace_from_staging"),
    checkCliUpdate: () => this.call("check_hq_cli_update"),
    installCliUpdate: () => this.call("install_hq_cli_update"),
    dismissCliUpdate: async () => {
      // The registered Sync command persists a concrete release. Resolve it
      // first rather than invoking the old argument-less, unregistered name.
      const pending = await this.call<Json | null>("check_hq_cli_update");
      if (!pending.ok) return pending;
      const record =
        pending.value && typeof pending.value === "object"
          ? (pending.value as Record<string, unknown>)
          : null;
      const version = typeof record?.latest === "string" ? record.latest.trim() : "";
      if (!version) {
        return failure("no-pending-update", "No CLI update to dismiss.");
      }
      return this.call("set_hq_cli_update_dismissed", { version });
    },
    availableChannels: () => this.call("available_channels"),
  };

  readonly packages: PlatformAdapter["packages"] = {
    listPackages: () => this.call("list_packages"),
    listPackagesCached: () => this.call("list_packages_cached"),
    install: ({ source, registry }) =>
      this.call("install_package", {
        source,
        ...(registry ? { registry: true } : {}),
      }),
    update: (name) => this.call("update_package", { name }),
    uninstall: (name) => this.call("uninstall_package", { name }),
    checkUpdates: () => this.call("check_package_updates"),
    updatePacks: (names) => this.call("update_packs", { names }),
  };

  readonly sessions: PlatformAdapter["sessions"] = {
    listAgentSessions: () => this.call("list_agent_sessions"),
  };

  readonly settings: PlatformAdapter["settings"] = {
    getConfig: () => this.call("get_config"),
    getSettings: () => this.call("get_settings"),
    updateSettings: (patch) => this.queueSettingsPatch(patch),
    getSetupStatus: () => this.call("get_setup_status"),
    getTelemetryConsent: () => this.call("get_telemetry_consent"),
  };

  readonly workMesh: PlatformAdapter["workMesh"] = {
    readLocalSnapshot: () => this.call("read_work_mesh_snapshot"),
    getProjectView: (projectId, companyUid) =>
      companyUid?.trim()
        ? this.hqProJson(
            "GET",
            `/v1/work-mesh/projects/${encodeURIComponent(projectId.trim())}?companyUid=${encodeURIComponent(companyUid.trim())}`,
          )
        : this.call("read_work_mesh_project", { projectId }),
  };
}

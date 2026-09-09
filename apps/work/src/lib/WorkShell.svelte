<script lang="ts">
  import { addChannelNotification, readChannelNotifications, saveChannelNotifications } from "./channel-notifications";
  /**
   * ROOT = the full V2 desktop shell (the sidebar-first windowed app), filling
   * 100vw/100vh. The channel rail + title bar ARE the navigation.
   *
   * Same browser path on localhost and Vercel:
   *   session → direct hq-pro REST + MeshClient MQTT wakes → shallow cache.
   * Tauri selects its native adapter. Neither target reads ~/.hq here.
   */
  import { onMount, type Component } from "svelte";
  import {
    createSyncPlatformAdapter,
    resolveHostPlatform,
    WebPlatformAdapter,
    type InvokeFn,
    type PlatformAdapter,
  } from "@hq/platform";
  import {
    DesktopApp,
    createChatWakeBus,
    createRosterRefresher,
    createTenantStorage,
    resolveShellCompanies,
    subscribeRosterRefreshEvents,
    settingsProfileFromSelf,
    statusForRow,
    identitiesFromContacts,
    mentionTargetsFromContacts,
    toSelfIdentity,
    normalizeDm,
    contactHasConversation,
    reactionMapFromMessages,
    EMPTY_OVERLAY,
    type ChannelDirectoryRow,
    type ConversationMessageWire,
    type ConversationRow,
    type BoardTabData,
    type ChannelFileItemModel,
    type ChannelFilePreview,
    type ChannelStatusModel,
    type ChatSidebarApi,
    type PackagesEvents,
    type ReplyThreadScope,
    type RosterStatus,
    type RowExtrasResolver,
    type Workspace,
    type WorkMeshThread,
    conversationDeepLinkFromLocation,
    conversationRowForDeepLink,
    attachmentVaultScopeUid,
  } from "@hq/ui";
  import {
    createChatSidebarApi,
    createNotificationsApi,
  } from "./chat-adapter";
  import {
    persistLastSelected,
    persistLastThread,
    pickMostRecentDirectoryRow,
    readShallowCache,
    resolveLastSelectedId,
    seedConversationCacheFromRail,
  } from "./browser-cache";
  import { openWorkExternalUrl } from "./external-open";
  import { startWebMeshForAdapter } from "./mesh-runtime";
  import { loadWorkThreads } from "./work-thread-loader";
  import { projectIdFromDirectoryRow } from "./live-sidebar";
  import {
    loadLiveProjectMeta,
    loadWebVaultFilePreview,
    type LiveProjectMeta,
  } from "./live-project";
  import {
    createProjectMetaCache,
    subscribeProjectMetaInvalidations,
  } from "./project-meta-cache";
  import {
    configureHqProApiUrl,
    hqProApiUrl,
    hqProFetch,
    redirectToSigninWithCallback,
    type HqProFetch,
  } from "./hq-pro-client";
  import { displayVersion } from "./version";
  import { workRuntimeFor } from "./work-runtime";
  import {
    createTauriAttachmentHandlers,
    hydrateDesktopSelf,
    nativeTenantFromSession,
    signOutFromShell,
  } from "./desktop-shell";
  import { tauriInvoke } from "./tauri-invoke";
  import { tauriListen } from "./tauri-listen";
  import workPackage from "../../package.json";

  type WorkShellHostIdentity = {
    sub?: string | null;
    email?: string | null;
    name?: string | null;
  };

  type WorkShellProps = {
    data: { user?: WorkShellHostIdentity | null };
    runtimeKind?: "desktop" | "web";
    apiUrl?: string;
    /** Native hosts replace the browser's cookie-backed hq-pro transport. */
    fetch?: HqProFetch;
    /** Native hosts must not navigate a static bundle to SvelteKit sign-in. */
    onUnauthorized?: () => void;
    /** Native hosts fetch Vault bytes through their bounded transport. */
    loadFilePreview?: (
      item: ChannelFileItemModel,
      selectedCompanyUid: string | null,
    ) => Promise<ChannelFilePreview>;
    /** Mirrors the safe user shape supplied by the root +layout on the web. */
    hostIdentity?: WorkShellHostIdentity | null;
    /** Native host-owned storage partition for the authenticated account. */
    hostTenantAccountId?: string | null;
    /** Native host-owned boundary for changes to that storage partition. */
    hostTenantGeneration?: number;
    /** Desktop hosts can supply their tested native command seam. */
    invoke?: InvokeFn;
    /** Desktop hosts can supply their tested native event seam. */
    listen?: typeof tauriListen;
    /** Desktop hosts bridge authenticated native wake events onto this bus. */
    wakes?: ReturnType<typeof createChatWakeBus>;
    /** Native hosts expose the app version rather than Work's package version. */
    version?: string;
    /** Native host update edge forwarded to DesktopApp's Updates pane. */
    updateWakeSeq?: number;
    /** Native host app-version refresh used by DesktopApp's Updates pane. */
    refreshAppVersion?: () => Promise<string>;
    /** Native package-operation stream for Library → Installed. */
    packagesEvents?: PackagesEvents | null;
    /** Native notification wake edge forwarded by a desktop host. */
    notificationWakeSeq?: number;
    /** Native hosts can bound first paint without replacing DesktopApp's default. */
    bootTimeoutMs?: number;
    /** Native hosts receive DesktopApp's first successful shell-paint signal. */
    onShellReady?: () => void;
    /** Native external-browser seam for Settings and rendered links. */
    onOpenConsole?: (url: string) => Promise<void> | void;
    onopenurl?: (url: string) => void;
    /** Native route bridge, attached after DesktopApp listeners are ready. */
    onembeddednavigationready?: () => void | (() => void);
    /** Native active-thread bridge for reply realtime optimization. */
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
    /** Native host-only full-column surfaces, forwarded to DesktopApp. */
    extraPages?: Record<
      string,
      {
        label: string;
        createAction?: { label: string; param: () => string | null };
        detail?: string;
        component: Component<{
          param?: string | null;
          onnavigate?: (param: string | null) => void;
        }>;
      }
    >;
    /** Native host decorations for project-channel rows. */
    rowExtras?: RowExtrasResolver | null;
    /**
     * Backoff between failed company-roster fetches (tests shorten it). The
     * default is bounded; a roster that keeps failing stops retrying.
     */
    rosterRetryDelaysMs?: readonly number[];
  };

  // A non-SvelteKit host can supply its runtime kind and public API URL. The
  // Work route supplies the latter from SvelteKit's dynamic public env; the
  // exported shell itself deliberately has no SvelteKit virtual-module edge.
  let {
    data,
    runtimeKind,
    apiUrl,
    fetch: hostFetch,
    onUnauthorized,
    loadFilePreview: hostLoadFilePreview,
    hostIdentity,
    hostTenantAccountId,
    hostTenantGeneration,
    invoke: hostInvoke,
    listen: hostListen,
    wakes: hostWakes,
    version: hostVersion,
    updateWakeSeq,
    refreshAppVersion,
    packagesEvents,
    notificationWakeSeq: hostNotificationWakeSeq,
    bootTimeoutMs,
    onShellReady,
    onOpenConsole: hostOnOpenConsole,
    onopenurl: hostOpenUrl,
    onembeddednavigationready,
    onactivethreadchange,
    extraPages,
    rowExtras = null,
    rosterRetryDelaysMs,
  }: WorkShellProps = $props();

  // Only a real desktop host gets the native command bridge. A phone runs a
  // native shell too, but that shell exposes no commands — see work-runtime.ts.
  const runtime = runtimeKind ?? workRuntimeFor(resolveHostPlatform());
  const nativeInvoke = hostInvoke ?? tauriInvoke;
  const nativeListen = hostListen ?? tauriListen;
  // The Sync embed supplies a settled desktop identity only after its own
  // native lifecycle is ready. It remains the authority for auth refreshes
  // and tenant-generation boundaries; a standalone desktop WorkShell keeps
  // the default native session lifecycle below.
  const hostOwnsNativeSession =
    runtime === "desktop" && hostIdentity !== undefined;
  configureHqProApiUrl(apiUrl);
  const resolveHqProApiUrl = () => hqProApiUrl(apiUrl);
  // The hosted route leaves this undefined, retaining the original singleton
  // and its single browser token cache. Native hosts must supply their
  // authenticated command bridge because a static build has no /api routes.
  const workFetch: HqProFetch = hostFetch ?? hqProFetch;
  const adapter: PlatformAdapter = runtime === "desktop"
    ? createSyncPlatformAdapter({ invoke: nativeInvoke })
    : new WebPlatformAdapter({
        baseUrl: resolveHqProApiUrl(),
        fetch: workFetch,
        onUnauthorized: onUnauthorized ?? redirectToSigninWithCallback,
      });
  const attachmentHandlers =
    adapter.kind === "desktop" ? createTauriAttachmentHandlers(nativeInvoke) : null;
  const wakes = hostWakes ?? createChatWakeBus();
  let localNotificationRows = $state<Record<string, unknown>[]>([]);
  const notificationsApi = createNotificationsApi(adapter, {
    localNotifications: () => localNotificationRows,
    ackLocalNotification: (id) => {
      localNotificationRows = localNotificationRows.map((row) =>
        row.id === id ? { ...row, status: "read" } : row,
      );
      saveChannelNotifications(conversationCacheStorage, localNotificationRows);
    },
    readAllLocalNotifications: () => {
      localNotificationRows = localNotificationRows.map((row) => ({
        ...row,
        status: "read",
      }));
      saveChannelNotifications(conversationCacheStorage, localNotificationRows);
    },
  });
  let localNotificationWakeSeq = $state(0);
  const notificationWakeSeq = $derived(
    (hostNotificationWakeSeq ?? 0) + localNotificationWakeSeq,
  );
  let externalLinkError = $state<string | null>(null);

  // The Cognito subject owns the web storage partition. The shared shell's
  // person identity is hydrated from caller-scoped whoami below.
  const suppliedHostIdentity = hostIdentity ?? data.user ?? null;
  const hostSelf = toSelfIdentity(suppliedHostIdentity);
  const hostAccountId =
    typeof suppliedHostIdentity?.sub === "string" &&
    suppliedHostIdentity.sub.trim()
      ? suppliedHostIdentity.sub.trim()
      : null;
  let self = $state(hostSelf);
  let tenantAccountId = $state<string | null>(
    adapter.kind === "web" ? hostAccountId : null,
  );
  let tenantGeneration = $state(0);
  let tenantHydration = 0;
  let shellEpoch = $state(0);
  const effectiveTenantAccountId = $derived(
    hostOwnsNativeSession
      ? (hostTenantAccountId?.trim() || null)
      : tenantAccountId,
  );
  const effectiveTenantGeneration = $derived(
    hostOwnsNativeSession ? (hostTenantGeneration ?? 0) : tenantGeneration,
  );
  const personUid = $derived(self?.uid ?? "");
  let shallow = $state(readShallowCache(personUid));
  const conversationCacheStorage = $derived(
    createTenantStorage(
      typeof window !== "undefined" ? window.localStorage : null,
      { accountId: effectiveTenantAccountId, companyId: "all" },
    ),
  );
  $effect(() => {
    void personUid;
    localNotificationRows = personUid ? readChannelNotifications(conversationCacheStorage) : [];
  });
  $effect(() => {
    shallow = readShallowCache(personUid);
  });
  $effect(() => {
    seedConversationCacheFromRail(shallow, conversationCacheStorage);
  });
  const sidebarApi = $derived(
    createChatSidebarApi(adapter, shallow.directory, personUid, {
      fetch: workFetch,
    }),
  );
  function refreshableSidebarApi(api: ChatSidebarApi): ChatSidebarApi {
    return {
      ...api,
      fetchChannelDirectory: async (cursor) => {
        const feed = await api.fetchChannelDirectory(cursor);
        shallow = readShallowCache(personUid);
        return feed;
      },
      listContacts: async () => {
        const contacts = await api.listContacts();
        shallow = readShallowCache(personUid);
        return contacts;
      },
    };
  }
  const liveSidebarApi = $derived(refreshableSidebarApi(sidebarApi));

  let companies = $state(
    resolveShellCompanies({
      authed: false,
    }),
  );
  /**
   * Where this session is in loading `companies`: `loading` until the first
   * fetch settles, then `ready` (applied) or `failed` (retry budget spent).
   * #welcome must not lead with "Create a company" while this is `loading`.
   */
  let rosterStatus = $state<RosterStatus>("loading");
  /** True once `whoami` has replaced the host's account identity this tenant. */
  let selfHydrated = false;
  let workThreads = $state<WorkMeshThread[]>([]);
  let projectMetaTick = $state(0);
  const projectMeta = createProjectMetaCache({
    load: (row) => {
      const projectId = projectIdFor(row);
      return loadLiveProjectMeta(
        {
          channelId: row.channelId,
          companyUid: row.companyUid,
          projectId: projectId || row.projectId,
          title: row.title,
        },
        companyLabelFor(row.companyUid),
        { fetch: workFetch },
      );
    },
    canLoad: (row) => {
      const projectId = projectIdFor(row);
      const companyUid = (row.companyUid ?? "").trim();
      const channelId = (row.channelId ?? "").trim();
      return (
        typeof window !== "undefined" &&
        (Boolean(projectId && companyUid) || channelId.startsWith("chn_"))
      );
    },
    onChanged: () => {
      projectMetaTick += 1;
    },
  });

  async function hydrateNativeTenant(): Promise<void> {
    if (adapter.kind !== "desktop") return;
    try {
      const session = nativeTenantFromSession(
        await nativeInvoke("get_auth_session"),
      );
      if (
        !session ||
        session.status !== "active" ||
        session.generation < tenantGeneration
      ) {
        return;
      }
      tenantAccountId = session.accountId;
      tenantGeneration = session.generation;
    } catch {
      /* keep the no-op storage facade until native establishes a tenant */
    }
  }

  function clearTenantState(): void {
    // This page-scoped cache survives the keyed DesktopApp remount. Clear it
    // at the auth-generation boundary before any next-tenant request starts.
    rosterRefresher.cancel();
    projectMeta.invalidateAll();
    projectMetaTick += 1;
    self = null;
    selfHydrated = false;
    shallow = readShallowCache("");
    companies = resolveShellCompanies({ authed: false });
    rosterStatus = "loading";
    workThreads = [];
    selectedCompanyUid = null;
  }

  function ownsTenant(generation: number, hydration: number): boolean {
    return generation === tenantGeneration && hydration === tenantHydration;
  }

  function sameRoster(a: readonly Workspace[], b: readonly Workspace[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((row, index) => {
      const other = b[index];
      return (
        row.slug === other.slug &&
        row.cloudUid === other.cloudUid &&
        row.displayName === other.displayName &&
        row.kind === other.kind &&
        row.state === other.state &&
        row.membershipStatus === other.membershipStatus &&
        row.role === other.role &&
        row.hasLocalFolder === other.hasLocalFolder
      );
    });
  }

  /**
   * Fetch the company roster for the tenant that asked. Resolves `true` when
   * the roster applied (or the tenant moved on — nothing left to retry) and
   * `false` when the fetch failed, so the refresher can back off and retry.
   * Never invents a roster: a failed fetch leaves the last good one in place.
   */
  async function loadRoster(
    expectedGeneration: number,
    hydration: number,
  ): Promise<boolean> {
    let res: Awaited<ReturnType<typeof adapter.identity.listWorkspaces>>;
    try {
      res = await adapter.identity.listWorkspaces();
    } catch {
      return false;
    }
    if (!ownsTenant(expectedGeneration, hydration)) return true;
    if (!res.ok) return false;
    const roster = resolveShellCompanies({
      authed: true,
      membershipRows: res.value,
    });
    if (!sameRoster(companies, roster)) companies = roster;

    const threads = await loadWorkThreads(roster, workFetch);
    if (!ownsTenant(expectedGeneration, hydration)) return true;
    workThreads = threads;
    return true;
  }

  // A failed roster fetch used to leave `companies` empty for the whole
  // session; the sync runner's company events never re-fetched it either.
  // Both paths now go through one bounded refresher. Self hydration rides
  // the same load: on a clean-VM first sign-in a null `whoami` used to end
  // the bootstrap silently, with no retry, so #welcome offered "Create a
  // company" to an owner whose company the backend already had.
  const rosterRefresher = createRosterRefresher({
    load: async () => {
      const generation = tenantGeneration;
      const hydration = tenantHydration;
      if (!selfHydrated) {
        // A hosted page with no session has nothing to hydrate or fetch.
        if (adapter.kind === "web" && !hostSelf) return true;
        const hydratedSelf = await hydrateDesktopSelf(hostSelf, adapter);
        if (!ownsTenant(generation, hydration)) return true;
        if (!hydratedSelf) return false;
        self = hydratedSelf;
        selfHydrated = true;
      }
      return loadRoster(generation, hydration);
    },
    onSettled: (outcome) => {
      if (outcome === "applied") rosterStatus = "ready";
      // A later refresh that gives up keeps the last good roster and its
      // `ready` status; only a session that never loaded reads as failed.
      else if (outcome === "exhausted" && rosterStatus === "loading") {
        rosterStatus = "failed";
      }
    },
    delaysMs: rosterRetryDelaysMs,
  });

  async function bootstrapTenant(expectedGeneration: number): Promise<void> {
    tenantHydration += 1;
    if (!ownsTenant(expectedGeneration, tenantHydration)) return;
    rosterRefresher.cancel();
    selfHydrated = false;
    rosterStatus = "loading";
    await rosterRefresher.refresh();
  }

  /** #welcome's "Couldn't load your companies — Retry": a fresh retry budget. */
  function retryRoster(): void {
    rosterRefresher.cancel();
    rosterStatus = "loading";
    void rosterRefresher.refresh();
  }

  function acceptAuthSession(
    next: NonNullable<ReturnType<typeof nativeTenantFromSession>>,
  ): void {
    if (next.generation < tenantGeneration) return;
    if (
      next.generation === tenantGeneration &&
      next.accountId === tenantAccountId &&
      next.status === "active"
    ) {
      return;
    }

    // The native session event is the only authority allowed to cross tenants.
    // Clear synchronously before starting a B request so the keyed shell
    // cancels the old tenant's async work at the generation boundary.
    tenantAccountId = next.accountId;
    tenantGeneration = next.generation;
    tenantHydration += 1;
    shellEpoch += 1;
    clearTenantState();

    if (next.status !== "active") return;
    void bootstrapTenant(next.generation);
  }

  onMount(async () => {
    if (adapter.kind === "desktop" && !hostOwnsNativeSession) {
      await hydrateNativeTenant();
    }
    await bootstrapTenant(tenantGeneration);
  });

  onMount(() => {
    if (adapter.kind !== "desktop" || hostOwnsNativeSession) return;
    let cancelled = false;
    const unlistenPromise = nativeListen<unknown>(
      "auth:session-changed",
      (event) => {
        if (cancelled) return;
        const next = nativeTenantFromSession(event.payload);
        if (next) acceptAuthSession(next);
      },
    ).catch(() => () => {});

    return () => {
      cancelled = true;
      void unlistenPromise
        .then((unlisten) => {
          try {
            unlisten();
          } catch {
            /* cleanup must never escape Svelte's teardown pass */
          }
        })
        .catch(() => {});
    };
  });

  // The native sync runner provisions website-created companies after sign-in
  // and announces them; re-read the roster so #welcome can lead with the
  // company instead of waiting for a restart.
  onMount(() => {
    const unsubscribe =
      adapter.kind === "desktop"
        ? subscribeRosterRefreshEvents(nativeListen, () => {
            void rosterRefresher.refresh();
          })
        : () => {};
    return () => {
      unsubscribe();
      rosterRefresher.dispose();
    };
  });

  // `channel:updated` narrows to that channel; catch-up has no row identity
  // and can reconcile any project directory entry, so it invalidates broadly.
  onMount(() => subscribeProjectMetaInvalidations(wakes, projectMeta));

  // Channel unread deltas arrive through the desktop poller independently of
  // the NOTIF store. Bridge that wake into the visible feed immediately.
  onMount(() =>
    wakes.on("channel:new-message", (wake) => {
      if (!personUid) return;
      const channel = shallow.directory.find((row) => row.channelId === wake.channelId);
      const next = addChannelNotification(localNotificationRows, wake, personUid, channel?.name?.trim() || "");
      if (next === localNotificationRows) return;
      localNotificationRows = next;
      saveChannelNotifications(conversationCacheStorage, next);
      localNotificationWakeSeq += 1;
    }),
  );

  $effect(() => {
    if (!self) return;
    // The browser mesh is web-only because the static desktop build has no
    // /api/auth/token endpoint for its browser credential transport.
    const mesh = startWebMeshForAdapter(adapter, {
      wakes,
      fetchImpl: hqProFetch,
      onNotifications: () => {
        localNotificationWakeSeq += 1;
      },
    });
    if (!mesh) return;
    return () => mesh.stop();
  });

  function rowFromDirectory(row: ChannelDirectoryRow): ConversationRow {
    const kind =
      row.type === "dm" ? (row.scope === "group" ? "group" : "dm") : "channel";
    return {
      id: `ch:${row.channelId}`,
      kind,
      title: row.name || row.channelId,
      companyUid: row.companyUid ?? null,
      unreadDot: (row.unreadCount ?? 0) > 0,
      lastActivityAt: Date.parse(row.lastActivityAt ?? "") || 0,
      pinned: false,
      memberCount: row.memberCount,
      members: row.members,
      channelId: row.channelId,
      channelScope: row.scope,
      projectId: row.projectId ?? null,
    };
  }

  function projectIdFor(row: ConversationRow): string | null {
    return projectIdFromDirectoryRow({
      projectId: row.projectId,
      channelId: row.channelId,
      title: row.title,
    });
  }

  const seedDirectory = $derived(shallow.directory);
  const searchRows = $derived([
    ...shallow.directory.map(rowFromDirectory),
    ...shallow.contacts.map((contact) => normalizeDm(contact)),
  ]);
  const conversationDeepLink = $derived(conversationDeepLinkFromLocation());
  const initialReplyRootEventId = $derived(
    conversationDeepLink.replyRootEventId,
  );
  const initialRow = $derived.by((): ConversationRow | null => {
    const fromLink = conversationRowForDeepLink(
      conversationDeepLink,
      searchRows,
    );
    if (fromLink) return fromLink;
    const wanted = resolveLastSelectedId(shallow);
    if (wanted?.startsWith("ch:")) {
      const hit = shallow.directory.find(
        (row) => `ch:${row.channelId}` === wanted,
      );
      if (hit) return rowFromDirectory(hit);
    }
    if (wanted?.startsWith("dm:")) {
      const uid = wanted.slice(3);
      const hit = shallow.contacts.find((contact) => contact.personUid === uid);
      if (hit && contactHasConversation(hit)) return normalizeDm(hit);
    }
    const recent = pickMostRecentDirectoryRow(shallow.directory);
    return recent ? rowFromDirectory(recent) : null;
  });
  let selectedCompanyUid = $state<string | null>(null);

  const messagesByRow = $derived((row: ConversationRow) => {
    const last = shallow.lastThread;
    if (last && last.key === row.id) return last.messages;
    return [] as ConversationMessageWire[];
  });
  const reactionsByRow = $derived((row: ConversationRow) =>
    reactionMapFromMessages(messagesByRow(row)),
  );
  function companyLabelFor(uid: string | null | undefined): string | null {
    if (!uid) return null;
    const hit = companies.find((row) => row.cloudUid === uid);
    return hit?.displayName?.trim() || hit?.slug || null;
  }

  function attachmentCompanyUid(row: ConversationRow | null): string | null {
    return attachmentVaultScopeUid({
      row,
      selfUid: personUid,
    });
  }

  $effect(() => {
    if (selectedCompanyUid !== null || !initialRow) return;
    selectedCompanyUid = attachmentCompanyUid(initialRow);
  });

  function ensureProjectMeta(row: ConversationRow): LiveProjectMeta | null {
    void projectMetaTick;
    return projectMeta.read(row);
  }

  const boardByRow = $derived((row: ConversationRow): BoardTabData | null => {
    // Board is GET /v1/work-mesh/projects/{id} only. Do not paint
    // work-mesh activity as Board tasks.
    return ensureProjectMeta(row)?.board ?? null;
  });
  const filesByRow = $derived(
    (row: ConversationRow): ChannelFileItemModel[] => {
      return ensureProjectMeta(row)?.files ?? [];
    },
  );
  const loadFilePreview = (item: ChannelFileItemModel) =>
    hostLoadFilePreview?.(item, selectedCompanyUid) ??
    loadWebVaultFilePreview(item, selectedCompanyUid, { fetch: workFetch });
  const channelStatusByRow = $derived(
    (row: ConversationRow): ChannelStatusModel | null => {
      const live = ensureProjectMeta(row);
      if (live?.status) return live.status;
      const projectId = projectIdFor(row);
      const id = row.channelId ?? "";
      const overlay = projectId
        ? {
            ...EMPTY_OVERLAY,
            statusByChannelId: {
              [id]: {
                companyLabel: companyLabelFor(row.companyUid),
                projectId,
                storiesTotal: 0,
                storiesComplete: 0,
                repos: [],
                liveAgents: [],
              },
            },
          }
        : EMPTY_OVERLAY;
      return statusForRow(row, overlay, () => null, {
        workThreads: workThreads.filter(
          (thread) => thread.companyUid === row.companyUid,
        ),
        identities: identitiesFromContacts(shallow.contacts),
      });
    },
  );

  function cacheLiveMessages(
    row: ConversationRow,
    messages: ConversationMessageWire[],
  ): void {
    persistLastThread(personUid, row.id, messages);
  }

  function rememberSelectedRow(row: ConversationRow): void {
    selectedCompanyUid = attachmentCompanyUid(row);
    persistLastSelected(personUid, row.id);
  }

  async function signOut(): Promise<void> {
    if (adapter.kind === "desktop" && onUnauthorized) {
      onUnauthorized();
      return;
    }
    await signOutFromShell({
      adapter,
      invoke: nativeInvoke,
      navigate: (url) => window.location.assign(url),
      onDesktopSignedOut: () => {
        self = null;
        companies = resolveShellCompanies({ authed: false });
        workThreads = [];
      },
    });
  }

  function openUrl(url: string): void {
    externalLinkError = null;
    try {
      openWorkExternalUrl(url, adapter.kind);
    } catch (error) {
      externalLinkError =
        error instanceof Error
          ? error.message
          : "This external link could not be opened.";
    }
  }
</script>

<div class="shell-root">
  {#key shellEpoch}
    <DesktopApp
      {adapter}
      version={hostVersion ?? displayVersion(`v${workPackage.version}`)}
      sidebarApi={liveSidebarApi}
      {notificationsApi}
      {messagesByRow}
      {reactionsByRow}
      {boardByRow}
      {filesByRow}
      {loadFilePreview}
      {channelStatusByRow}
      putAttachmentObject={attachmentHandlers?.putAttachmentObject}
      getAttachmentObject={attachmentHandlers?.getAttachmentObject}
      identities={identitiesFromContacts(shallow.contacts)}
      mentionCandidates={mentionTargetsFromContacts(shallow.contacts)}
      coreFixtures={false}
      onopenurl={hostOpenUrl ?? openUrl}
      {wakes}
      {companies}
      {rosterStatus}
      onretryroster={retryRoster}
      {self}
      tenantAccountId={effectiveTenantAccountId}
      tenantGeneration={effectiveTenantGeneration}
      {initialRow}
      {initialReplyRootEventId}
      {seedDirectory}
      {notificationWakeSeq}
      {bootTimeoutMs}
      {onShellReady}
      {searchRows}
      hydrateLiveMessages={true}
      onlivemessages={cacheLiveMessages}
      onselectrow={rememberSelectedRow}
      settingsProfile={settingsProfileFromSelf(self)}
      onsignout={signOut}
      onOpenConsole={hostOnOpenConsole ?? openUrl}
      {onembeddednavigationready}
      {packagesEvents}
      {updateWakeSeq}
      {refreshAppVersion}
      {onactivethreadchange}
      {extraPages}
      {rowExtras}
    />
  {/key}
  {#if externalLinkError}
    <div
      class="external-link-notice"
      role="alert"
      data-testid="external-link-error"
    >
      <span>{externalLinkError}</span>
      <button
        type="button"
        aria-label="Dismiss external link warning"
        onclick={() => (externalLinkError = null)}>Dismiss</button
      >
    </div>
  {/if}
</div>

<style>
  .shell-root {
    position: relative;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }

  .external-link-notice {
    position: absolute;
    right: 1rem;
    bottom: 1rem;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 0.75rem;
    max-width: min(32rem, calc(100% - 2rem));
    padding: 0.75rem 1rem;
    color: #fff;
    background: #8a1c1c;
    border-radius: 0.5rem;
    box-shadow: 0 0.25rem 0.75rem rgb(0 0 0 / 25%);
  }

  .external-link-notice button {
    color: inherit;
    background: transparent;
    border: 1px solid currentcolor;
    border-radius: 0.25rem;
    cursor: pointer;
  }
</style>

<script lang="ts">
  /**
   * ROOT = the full V2 desktop shell (the sidebar-first windowed app), filling
   * 100vw/100vh. The channel rail + title bar ARE the navigation.
   *
   * Same browser path on localhost and Vercel:
   *   session → direct hq-pro REST + MeshClient MQTT wakes → shallow cache.
   * Tauri selects its native adapter. Neither target reads ~/.hq here.
   */
  import { onMount } from "svelte";
  import {
    createSyncPlatformAdapter,
    WebPlatformAdapter,
    type InvokeFn,
    type PlatformAdapter,
  } from "@hq/platform";
  import {
    DesktopApp,
    createChatWakeBus,
    createTenantStorage,
    resolveShellCompanies,
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
    type ChannelStatusModel,
    type ChatSidebarApi,
    type Workspace,
    type WorkMeshThread,
    conversationDeepLinkFromLocation,
    conversationRowForDeepLink,
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
    createHqProFetch,
    hqProApiUrl,
    hqProFetch,
    redirectToSigninWithCallback,
    type HqProFetch,
  } from "./hq-pro-client";
  import { displayVersion } from "./version";
  import {
    createTauriAttachmentHandlers,
    hydrateDesktopSelf,
    nativeTenantFromSession,
    signOutFromShell,
  } from "./desktop-shell";
  import { tauriInvoke } from "./tauri-invoke";
  import { tauriListen } from "./tauri-listen";
  import workPackage from "../../package.json";

  type WorkShellProps = {
    data: { user?: Parameters<typeof toSelfIdentity>[0] };
    runtimeKind?: "desktop" | "web";
    apiUrl?: string;
  };

  // A non-SvelteKit host can supply its runtime kind and public API URL. The
  // Work route supplies the latter from SvelteKit's dynamic public env; the
  // exported shell itself deliberately has no SvelteKit virtual-module edge.
  let { data, runtimeKind, apiUrl }: WorkShellProps = $props();

  type TauriWindow = Window & {
    __TAURI__?: {
      core?: { invoke?: InvokeFn };
      tauri?: { invoke?: InvokeFn };
    };
  };

  function isTauriRuntime(): boolean {
    return (
      (import.meta.env as Record<string, string | boolean | undefined>).TAURI ===
        "1" ||
      (typeof window !== "undefined" &&
        Boolean((window as TauriWindow).__TAURI__))
    );
  }

  const runtime = runtimeKind ?? (isTauriRuntime() ? "desktop" : "web");
  const resolveHqProApiUrl = () => hqProApiUrl(apiUrl);
  const adapter: PlatformAdapter = runtime === "desktop"
    ? createSyncPlatformAdapter({ invoke: tauriInvoke })
    : new WebPlatformAdapter({
        baseUrl: resolveHqProApiUrl(),
        fetch: hqProFetch,
        onUnauthorized: redirectToSigninWithCallback,
      });
  const workFetch: HqProFetch =
    apiUrl === undefined
      ? hqProFetch
      : createHqProFetch({ baseUrl: resolveHqProApiUrl });
  const attachmentHandlers =
    adapter.kind === "desktop" ? createTauriAttachmentHandlers(tauriInvoke) : null;
  const notificationsApi = createNotificationsApi(adapter);
  const wakes = createChatWakeBus();
  let notificationWakeSeq = $state(0);
  let externalLinkError = $state<string | null>(null);

  // The Cognito subject owns the web storage partition. The shared shell's
  // person identity is hydrated from caller-scoped whoami below.
  const hostSelf = toSelfIdentity(data.user ?? null);
  const hostAccountId =
    typeof data.user?.sub === "string" && data.user.sub.trim()
      ? data.user.sub.trim()
      : null;
  let self = $state(hostSelf);
  let tenantAccountId = $state<string | null>(
    adapter.kind === "web" ? hostAccountId : null,
  );
  let tenantGeneration = $state(0);
  let tenantHydration = 0;
  let shellEpoch = $state(0);
  const personUid = $derived(self?.uid ?? "");
  let shallow = $state(readShallowCache(personUid));
  const conversationCacheStorage = $derived(
    createTenantStorage(
      typeof window !== "undefined" ? window.localStorage : null,
      { accountId: tenantAccountId, companyId: "all" },
    ),
  );
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
  let workThreads = $state<WorkMeshThread[]>([]);
  let projectMetaTick = $state(0);
  const projectMeta = createProjectMetaCache({
    load: (row) => {
      const projectId = projectIdFor(row);
      return loadLiveProjectMeta(
        { ...row, projectId: projectId || row.projectId },
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
        await tauriInvoke("get_auth_session"),
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
    projectMeta.invalidateAll();
    projectMetaTick += 1;
    self = null;
    shallow = readShallowCache("");
    companies = resolveShellCompanies({ authed: false });
    workThreads = [];
    selectedCompanyUid = null;
  }

  function ownsTenant(generation: number, hydration: number): boolean {
    return generation === tenantGeneration && hydration === tenantHydration;
  }

  async function bootstrapTenant(expectedGeneration: number): Promise<void> {
    const hydration = ++tenantHydration;
    const [hydratedSelf] = await Promise.all([
      hydrateDesktopSelf(hostSelf, adapter),
    ]);
    if (!ownsTenant(expectedGeneration, hydration)) return;
    self = hydratedSelf;
    if (!self) return;
    let roster: Workspace[];
    try {
      const res = await adapter.identity.listWorkspaces();
      if (!ownsTenant(expectedGeneration, hydration)) return;
      roster = resolveShellCompanies({
        authed: true,
        membershipRows: res.ok ? res.value : undefined,
      });
      companies = roster;
    } catch {
      /* keep empty — never invent a roster */
      return;
    }

    const threads = await loadWorkThreads(roster, workFetch);
    if (!ownsTenant(expectedGeneration, hydration)) return;
    workThreads = threads;
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
    if (adapter.kind === "desktop") await hydrateNativeTenant();
    await bootstrapTenant(tenantGeneration);
  });

  onMount(() => {
    if (adapter.kind !== "desktop") return;
    let cancelled = false;
    const unlistenPromise = tauriListen<unknown>(
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

  // `channel:updated` narrows to that channel; catch-up has no row identity
  // and can reconcile any project directory entry, so it invalidates broadly.
  onMount(() => subscribeProjectMetaInvalidations(wakes, projectMeta));

  $effect(() => {
    if (!self) return;
    // The browser mesh is web-only because the static desktop build has no
    // /api/auth/token endpoint for its browser credential transport.
    const mesh = startWebMeshForAdapter(adapter, {
      wakes,
      fetchImpl: hqProFetch,
      onNotifications: () => {
        notificationWakeSeq += 1;
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
    const fromRow = row?.companyUid?.trim();
    if (fromRow) return fromRow;
    const first = (companies ?? []).find((company) => company.cloudUid?.trim());
    return first?.cloudUid?.trim() || null;
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
    await signOutFromShell({
      adapter,
      invoke: tauriInvoke,
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
      version={displayVersion(`v${workPackage.version}`)}
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
      onopenurl={openUrl}
      {wakes}
      {companies}
      {self}
      {tenantAccountId}
      {tenantGeneration}
      {initialRow}
      {initialReplyRootEventId}
      {seedDirectory}
      {notificationWakeSeq}
      {searchRows}
      hydrateLiveMessages={true}
      onlivemessages={cacheLiveMessages}
      onselectrow={rememberSelectedRow}
      settingsProfile={settingsProfileFromSelf(self)}
      onsignout={signOut}
      onOpenConsole={openUrl}
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

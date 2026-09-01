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
    TauriPlatformAdapter,
    WebPlatformAdapter,
    type InvokeFn,
    type PlatformAdapter,
  } from "@hq/platform";
  import {
    DesktopApp,
    createChatWakeBus,
    resolveShellCompanies,
    settingsProfileFromSelf,
    statusForRow,
    identitiesFromContacts,
    mentionTargetsFromContacts,
    toSelfIdentity,
    normalizeThreads,
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
    type Workspace,
    type WorkMeshThread,
    conversationDeepLinkFromLocation,
    conversationRowForDeepLink,
  } from "@hq/ui";
  import {
    createChatSidebarApi,
    createNotificationsApi,
  } from "$lib/chat-adapter";
  import {
    persistLastSelected,
    persistLastThread,
    pickMostRecentDirectoryRow,
    readShallowCache,
    resolveLastSelectedId,
    seedConversationCacheFromRail,
  } from "$lib/browser-cache";
  import { startWebMeshForAdapter } from "$lib/mesh-runtime";
  import { projectIdFromDirectoryRow } from "$lib/live-sidebar";
  import {
    loadLiveProjectMeta,
    loadVaultFilePreview,
    type LiveProjectMeta,
  } from "$lib/live-project";
  import { hqProApiUrl, hqProFetch } from "$lib/hq-pro-client";
  import {
    createTauriAttachmentHandlers,
    hydrateDesktopSelf,
    signOutFromShell,
  } from "$lib/desktop-shell";
  import { tauriInvoke } from "$lib/tauri-invoke";

  let { data } = $props();

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

  const adapter: PlatformAdapter = isTauriRuntime()
    ? new TauriPlatformAdapter({ invoke: tauriInvoke })
    : new WebPlatformAdapter({ baseUrl: hqProApiUrl(), fetch: hqProFetch });
  const attachmentHandlers =
    adapter.kind === "desktop" ? createTauriAttachmentHandlers(tauriInvoke) : null;
  const notificationsApi = createNotificationsApi(adapter);
  const wakes = createChatWakeBus();
  let notificationWakeSeq = $state(0);

  // Self identity from the VERIFIED session (uid = Cognito sub). Null when
  // the session has no uid. This is the ONLY host-supplied identity — the
  // shared shell does the "you" tagging + admin gating from it.
  const hostSelf = toSelfIdentity(data.user ?? null);
  let self = $state(hostSelf);
  const personUid = $derived(self?.uid ?? "");
  const shallow = $derived(readShallowCache(personUid));
  $effect(() => {
    seedConversationCacheFromRail(shallow);
  });
  const sidebarApi = $derived(
    createChatSidebarApi(adapter, shallow.directory, personUid),
  );

  let companies = $state(
    resolveShellCompanies({
      authed: false,
    }),
  );
  let workThreads = $state<WorkMeshThread[]>([]);
  const projectMeta = new Map<string, LiveProjectMeta>();
  const projectMetaPending = new Set<string>();
  const projectMetaMiss = new Set<string>();
  let projectMetaTick = $state(0);

  async function refreshWorkThreads(roster: Workspace[]): Promise<void> {
    const uids = [
      ...new Set(
        roster
          .map((row) => row.cloudUid?.trim())
          .filter((uid): uid is string => Boolean(uid)),
      ),
    ];
    if (uids.length === 0) {
      workThreads = [];
      return;
    }
    const collected: WorkMeshThread[] = [];
    await Promise.all(
      uids.flatMap((uid) =>
        ["in-progress", "claimed", "blocked"].map(async (status) => {
          try {
            const res = await hqProFetch(
              `/v1/work-mesh/threads?companyUid=${encodeURIComponent(uid)}&status=${encodeURIComponent(status)}&limit=50`,
            );
            if (!res.ok) return;
            collected.push(...normalizeThreads(await res.json(), uid));
          } catch {
            /* absent-safe */
          }
        }),
      ),
    );
    workThreads = collected;
  }

  onMount(async () => {
    self = await hydrateDesktopSelf(hostSelf, adapter);
    if (!self) return;
    try {
      const res = await adapter.identity.listWorkspaces();
      companies = resolveShellCompanies({
        authed: true,
        membershipRows: res.ok ? res.value : undefined,
      });
    } catch {
      /* keep empty — never invent a roster */
    }
    await refreshWorkThreads(companies);
  });

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

  function ensureProjectMeta(row: ConversationRow): LiveProjectMeta | null {
    const key = row.channelId || row.projectId || row.id;
    if (!key) return null;
    void projectMetaTick;
    const cached = projectMeta.get(key);
    if (cached) return cached;
    if (projectMetaMiss.has(key) || projectMetaPending.has(key)) return null;
    const projectId = projectIdFor(row);
    const companyUid = (row.companyUid ?? "").trim();
    const channelId = (row.channelId ?? "").trim();
    if (
      typeof window === "undefined" ||
      ((!projectId || !companyUid) && !channelId.startsWith("chn_"))
    ) {
      projectMetaMiss.add(key);
      return null;
    }
    projectMetaPending.add(key);
    void loadLiveProjectMeta(
      { ...row, projectId: projectId || row.projectId },
      companyLabelFor(row.companyUid),
    ).then((meta) => {
      projectMetaPending.delete(key);
      if (meta) projectMeta.set(key, meta);
      else projectMetaMiss.add(key);
      projectMetaTick += 1;
    });
    return null;
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
        workThreads,
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
    window.open(url, "_blank", "noopener,noreferrer");
  }
</script>

<div class="shell-root">
  <DesktopApp
    {adapter}
    version="0.10.41"
    {sidebarApi}
    {notificationsApi}
    {messagesByRow}
    {reactionsByRow}
    {boardByRow}
    {filesByRow}
    loadFilePreview={loadVaultFilePreview}
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
</div>

<style>
  .shell-root {
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
</style>

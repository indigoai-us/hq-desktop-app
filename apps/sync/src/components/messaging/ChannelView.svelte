<script lang="ts">
  // Channel conversation pane (US-018 / US-005 project channels). Renders one
  // channel's thread + composer by REUSING the shared
  // <Conversation showAuthors={true}/>. The header shows the channel identity,
  // a scope chip (personal/group/company), and a member-count button that opens
  // <ChannelRoster/> — or for project channels, a status popover (live agents,
  // PRD rollup, branch/repo/preview, members + agents).
  //
  // If the caller is invited-but-not-joined, the composer is replaced by a join
  // CTA: joining (join_channel) flips membership to "joined" and the composer
  // appears. The pane owns its own message fetch, send, mark-read, and the
  // live `channel:new-message` refresh for the channel it's showing.
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import { open as openExternal } from '@tauri-apps/plugin-shell';
  import { safeUnlisten } from '../../lib/listener-registry';
  import { untrack } from 'svelte';
  import Conversation, { type ConversationMessage } from './Conversation.svelte';
  import ChannelRoster from './ChannelRoster.svelte';
  import {
    type Channel,
    type ChannelMember,
    type ChannelMessage as ChannelMessageWire,
    channelDisplayName,
    companyNameFor,
    scopeChipLabel,
    isInvitedNotJoined,
  } from '../../lib/channels';
  import { type ReactionEvent, channelScope } from '../../lib/reactions';
  import { ReactionController } from '../../lib/reactionController.svelte';
  import {
    createOutboundMessage,
    retrySend,
    runSend,
    type OutboundMessage,
    type SendStatus,
  } from './sendStateMachine';
  import { loadLocalProjects, loadLocalProjectPrd } from '../../desktop-alt/lib/local-projects';
  import type { Project } from '../../desktop-alt/lib/projects-model';
  import type { MissionControlSnapshot } from '../../desktop-alt/lib/sessions';
  import {
    buildChannelStatusModel,
    projectChannelHeaderParts,
    resolveMemberPillCount,
    type ChannelStatusModel,
    type StatusMemberInput,
    type StatusSessionInput,
  } from '../../desktop-alt/chat/channel-status-model';
  import { isProjectChannel } from '../../desktop-alt/chat/project-channel-model';
  import BoardTab from '../../desktop-alt/chat/BoardTab.svelte';
  import ChannelFilesTab from './ChannelFilesTab.svelte';
  import type { FileAttachmentModel } from './channelMessageModels';

  interface Props {
    channel: Channel;
    // The caller's own personUid — passed through to the roster so it can
    // suppress a self-remove button.
    selfPersonUid?: string | null;
    // Bubbled up so the parent (MessagesShell) can clear the rail unread + the
    // channel's metadata when membership/member-count changes here.
    onchannelchange?: (channel: Channel) => void;
    onread?: (channelId: string) => void;
    // Threads (US-022). Forwarded to <Conversation/> so a root message's
    // reply-count affordance opens the ThreadPanel in MessagesShell. Called with
    // the root message's eventId; the parent supplies this channel's id as the
    // thread scope. `activeRootEventId` highlights the open thread's root bubble.
    onopenthread?: (rootEventId: string) => void;
    activeRootEventId?: string | null;
  }

  let {
    channel,
    selfPersonUid = null,
    onchannelchange,
    onread,
    onopenthread,
    activeRootEventId = null,
  }: Props = $props();

  interface ChannelMessageRow extends ConversationMessage {
    fromEmail?: string;
  }

  interface ChannelDetail {
    // Optional: the `/messages` endpoint may return only the message page (the
    // caller already holds the channel from the list). Consumed via a guard
    // below — `if (detail.channel)`.
    channel?: Channel;
    messages: ChannelMessageWire[];
    nextCursor?: string | null;
  }

  const PAGE_SIZE = 50;

  // Local mutable copy of the channel metadata (membership/member-count can
  // change in place via join/roster actions).
  let current = $state<Channel>(untrack(() => channel));
  let messages = $state<ChannelMessageRow[]>([]);
  let loading = $state(false);
  let loadingOlder = $state(false);
  let nextCursor = $state<string | null>(null);
  let threadError = $state<string | null>(null);
  let loadGeneration = 0;
  let activeChannelId: string | null = null;

  let sending = $state(false);
  let sendError = $state<string | null>(null);
  let sendGeneration = 0;
  /** In-flight / failed optimistic sends keyed by clientId. */
  let outboundById = $state<Map<string, OutboundMessage>>(new Map());

  let joining = $state(false);
  let joinError = $state<string | null>(null);
  let joinGeneration = 0;

  let rosterOpen = $state(false);
  let statusOpen = $state(false);
  let memberCount = $state<number | null>(
    // Group DMs often ship a roster but no memberCount — count the OTHER
    // members + self so the pill has a real number (G8).
    untrack(() =>
      channel.memberCount ??
      (channel.scope === 'group' && channel.members?.length
        ? channel.members.length + 1
        : null),
    ),
  );

  /** Project channel tabs (US-005 / US-008 Files). Chat + Board + Files. */
  type ProjectTab = 'chat' | 'board' | 'files';
  let projectTab = $state<ProjectTab>('chat');
  /** Deep-link target from an in-chat file attachment card (US-008). */
  let highlightVaultPath = $state<string | null>(null);
  let statusModel = $state<ChannelStatusModel | null>(null);
  let statusLoading = $state(false);

  // Reactions (US-025) for the open channel. Recreated when the selected channel
  // changes (each channel is its own messageScope), kept in step with the visible
  // messages. Only meaningful for a joined channel (the invited preview has no
  // reactions surface).
  let reactionsCtl = $state<ReactionController | null>(null);

  const title = $derived(channelDisplayName(current));
  const chip = $derived(scopeChipLabel(current));
  const isPersonal = $derived(current.scope === 'personal');
  const isGroup = $derived(current.scope === 'group');
  const isProject = $derived(isProjectChannel(current));
  const companyLabel = $derived(companyNameFor(current) ?? current.companyName?.trim() ?? null);
  const projectHeader = $derived(projectChannelHeaderParts(title, companyLabel));
  const invited = $derived(isInvitedNotJoined(current));
  const conversationLabel = $derived(isGroup ? title : `#${title}`);
  const composerPlaceholder = $derived(
    `Message ${isGroup ? title : `# ${title}`} — or type / to run an agent…`,
  );
  const hasOlder = $derived(!!nextCursor);

  async function loadProjectStatus(): Promise<void> {
    if (!isProjectChannel(current)) {
      statusModel = null;
      return;
    }
    statusLoading = true;
    try {
      const projectId = current.projectId?.trim() || title;
      let projects: Project[] = [];
      try {
        projects = await loadLocalProjects();
      } catch (err) {
        console.error('channel-view: get_local_projects failed', err);
      }
      const project =
        projects.find(
          (p) =>
            p.id === projectId ||
            p.id === current.projectId ||
            (p.title || p.name || '').toLowerCase() === title.toLowerCase(),
        ) ?? null;

      let prd: Awaited<ReturnType<typeof loadLocalProjectPrd>> | null = null;
      if (project?.prdPath) {
        try {
          prd = await loadLocalProjectPrd(project.prdPath);
        } catch (err) {
          console.error('channel-view: get_local_project_prd failed', err);
        }
      }

      let sessions: StatusSessionInput[] = [];
      try {
        const snap = await invoke<MissionControlSnapshot>('list_agent_sessions');
        sessions = (snap?.sessions ?? []).map((s) => ({
          project: s.project,
          company: s.company,
          cwd: s.cwd,
          status: s.status,
          tool: s.tool,
          model: s.model,
          source: s.source,
          startedAt: s.startedAt,
        }));
      } catch (err) {
        console.error('channel-view: list_agent_sessions failed', err);
      }

      let members: StatusMemberInput[] = [];
      try {
        const resp = await invoke<{ members?: ChannelMember[] }>('list_channel_members', {
          channelId: current.channelId,
        });
        members = (resp?.members ?? []).map((m) => ({
          personUid: m.personUid,
          displayName: m.displayName,
          email: m.email,
          role: m.role,
        }));
        if (members.length > 0) {
          memberCount = members.length;
        }
      } catch (err) {
        console.error('channel-view: list_channel_members failed', err);
      }

      // Real data only (design-gap G8): no fixture members/agents/PRD on the
      // live path — sections simply hide when their data is absent.
      const statusMembers = members;
      const statusPrd = prd
        ? {
            name: prd.name,
            branchName: prd.branchName,
            userStories: (prd.userStories ?? []).map((s) => ({
              id: s.id,
              title: s.title,
              passes: s.passes,
            })),
            metadata: prd.metadata,
            prdPath: project?.prdPath ?? null,
          }
        : null;
      statusModel = buildChannelStatusModel({
        project: project ?? {
          id: projectId,
          title,
          name: title,
          company: current.companyName ?? '',
          prdPath: '',
          storiesTotal: 0,
          storiesComplete: 0,
        },
        prd: statusPrd,
        sessions,
        members: statusMembers,
        companyLabel,
      });
      // Only adopt the model's count when it was built from a real roster
      // fetch. When the roster call failed or returned empty, the model was
      // built from visual-QA fixture members — letting that overwrite the
      // channel-metadata count made the header pill drift (e.g. 6 → 5) after
      // simply opening and closing the popover.
      memberCount = resolveMemberPillCount(members.length, statusModel, memberCount);
    } finally {
      statusLoading = false;
    }
  }

  function openMembersSurface(): void {
    if (isProjectChannel(current)) {
      statusOpen = true;
      void loadProjectStatus();
      return;
    }
    rosterOpen = true;
  }

  async function openPreview(url: string): Promise<void> {
    try {
      await openExternal(url);
    } catch (err) {
      console.error('channel-view: open preview failed', err);
    }
  }

  // Owner determination: the creator is the channel owner. The Channel wire
  // shape doesn't carry the caller's role, so the roster (which lists per-member
  // roles) is the source of truth — it resolves the caller's own role against
  // `selfPersonUid` and only shows the owner-only remove/invite affordances when
  // the caller IS the owner. ChannelView simply hands the roster `selfPersonUid`
  // and lets it decide; the server also rejects a non-owner's remove/invite POST
  // as defense-in-depth.

  function mapWireMessage(row: ChannelMessageWire): ChannelMessageRow {
    const direction = row.direction === 'out' ? 'out' : 'in';
    return {
      eventId: row.eventId,
      fromPersonUid: row.fromPersonUid,
      fromEmail: row.fromEmail ?? '',
      fromDisplayName: row.fromDisplayName?.trim() || row.fromEmail || 'Unknown',
      body: row.body ?? '',
      details: row.details ?? null,
      prompt: row.prompt ?? null,
      createdAt: row.createdAt,
      direction,
      messageKind: row.messageKind ?? null,
      systemEvent: row.systemEvent ?? null,
      attachment: row.attachment ?? null,
    };
  }

  function patchOutboundRow(outbound: OutboundMessage): void {
    const status: SendStatus = outbound.status;
    messages = messages.map((m) =>
      m.eventId === outbound.clientId
        ? {
            ...m,
            sendStatus: status,
            body: outbound.body,
          }
        : m,
    );
  }

  async function load(): Promise<void> {
    const requestedChannelId = current.channelId;
    const generation = ++loadGeneration;
    loading = true;
    threadError = null;
    sendError = null;
    nextCursor = null;
    try {
      const detail = await invoke<ChannelDetail>('fetch_channel', {
        channelId: requestedChannelId,
        limit: PAGE_SIZE,
        cursor: null,
      });
      if (
        generation !== loadGeneration ||
        current.channelId !== requestedChannelId
      ) return;
      // Server returns newest-first; render oldest → newest.
      const page = (detail.messages ?? []).map(mapWireMessage).reverse();
      // Preserve any in-flight optimistic rows for this channel so a live
      // refresh never silently drops an unacked send.
      const optimistic = messages.filter(
        (m) =>
          m.eventId.startsWith('local-send-') &&
          (m.sendStatus === 'sending' ||
            m.sendStatus === 'pending' ||
            m.sendStatus === 'failed'),
      );
      messages = [...page, ...optimistic];
      nextCursor = detail.nextCursor ?? null;
      if (detail.channel) {
        current = { ...current, ...detail.channel };
        memberCount = current.memberCount ?? memberCount;
        onchannelchange?.(current);
      }
      // Opening a joined channel marks it read.
      if (!invited) void markRead(requestedChannelId);
    } catch (err) {
      if (
        generation !== loadGeneration ||
        current.channelId !== requestedChannelId
      ) return;
      threadError = typeof err === 'string' ? err : 'Could not load this channel';
      console.error('channel-view: fetch_channel failed', err);
    } finally {
      if (generation === loadGeneration) loading = false;
    }
  }

  async function loadOlder(): Promise<void> {
    const cursor = nextCursor;
    if (!cursor || loadingOlder || loading) return;
    const requestedChannelId = current.channelId;
    const generation = loadGeneration;
    loadingOlder = true;
    try {
      const detail = await invoke<ChannelDetail>('fetch_channel', {
        channelId: requestedChannelId,
        limit: PAGE_SIZE,
        cursor,
      });
      if (
        generation !== loadGeneration ||
        current.channelId !== requestedChannelId
      ) return;
      const older = (detail.messages ?? []).map(mapWireMessage).reverse();
      // Dedupe by eventId in case of cursor overlap.
      const seen = new Set(messages.map((m) => m.eventId));
      const fresh = older.filter((m) => !seen.has(m.eventId));
      messages = [...fresh, ...messages];
      nextCursor = detail.nextCursor ?? null;
    } catch (err) {
      if (
        generation !== loadGeneration ||
        current.channelId !== requestedChannelId
      ) return;
      console.error('channel-view: fetch_channel (older) failed', err);
    } finally {
      if (
        generation === loadGeneration &&
        current.channelId === requestedChannelId
      ) {
        loadingOlder = false;
      }
    }
  }

  function retryThread(): Promise<void> {
    return load();
  }

  async function markRead(channelId = current.channelId): Promise<void> {
    try {
      await invoke('mark_channel_read', { channelId });
      onread?.(channelId);
    } catch (err) {
      // Non-fatal — the unread will reconcile on the next poll.
      console.error('channel-view: mark_channel_read failed', err);
    }
  }

  async function send(text: string): Promise<void> {
    const body = text.trim();
    if (!body) return;
    const requestedChannelId = current.channelId;
    const generation = ++sendGeneration;
    sendError = null;

    // Optimistic append — message appears immediately as "Sending…".
    const outbound = createOutboundMessage(body);
    const nextMap = new Map(outboundById);
    nextMap.set(outbound.clientId, outbound);
    outboundById = nextMap;

    const row: ChannelMessageRow = {
      eventId: outbound.clientId,
      fromPersonUid: 'me',
      fromEmail: '',
      fromDisplayName: 'You',
      body: outbound.body,
      details: null,
      prompt: null,
      createdAt: outbound.createdAt,
      direction: 'out',
      sendStatus: 'sending',
    };
    messages = [...messages, row];
    sending = true;

    const result = await runSend(outbound, {
      send: async (msgBody) => {
        await invoke('send_channel_message', {
          channelId: requestedChannelId,
          body: msgBody,
        });
      },
      onChange: (msg) => {
        if (
          generation !== sendGeneration &&
          current.channelId !== requestedChannelId
        ) {
          // Still patch if the row exists — never drop.
        }
        const map = new Map(outboundById);
        map.set(msg.clientId, { ...msg });
        outboundById = map;
        patchOutboundRow(msg);
      },
    });

    // Per-message failure lives on the row ("Failed — tap to retry") so we
    // never surface a composer-level error that would block clearing the
    // textarea — the message is already on the timeline and must not be dropped.
    if (
      generation === sendGeneration &&
      current.channelId === requestedChannelId
    ) {
      sending = false;
      sendError = null;
      void result;
    } else {
      // Channel swapped mid-send: leave the row in the old channel's discarded
      // state; the outbound map is cleared on channel change.
      sending = false;
    }
  }

  async function retryFailedSend(eventId: string): Promise<void> {
    const outbound = outboundById.get(eventId);
    if (!outbound || outbound.status !== 'failed') return;
    const requestedChannelId = current.channelId;
    sendError = null;
    sending = true;
    await retrySend(outbound, {
      send: async (msgBody) => {
        await invoke('send_channel_message', {
          channelId: requestedChannelId,
          body: msgBody,
        });
      },
      onChange: (msg) => {
        const map = new Map(outboundById);
        map.set(msg.clientId, { ...msg });
        outboundById = map;
        patchOutboundRow(msg);
      },
    });
    if (current.channelId === requestedChannelId) {
      sending = false;
      sendError = null;
    }
  }

  async function join(): Promise<void> {
    if (joining) return;
    const requestedChannelId = current.channelId;
    const generation = ++joinGeneration;
    joining = true;
    joinError = null;
    try {
      const updated = await invoke<Channel>('join_channel', {
        channelId: requestedChannelId,
      });
      if (
        generation !== joinGeneration ||
        current.channelId !== requestedChannelId
      ) return;
      current = { ...current, ...updated, membership: updated.membership ?? 'joined' };
      onchannelchange?.(current);
      // Now a member — load the thread + mark read.
      await load();
    } catch (err) {
      if (
        generation !== joinGeneration ||
        current.channelId !== requestedChannelId
      ) return;
      joinError = typeof err === 'string' ? err : 'Could not join this channel';
      console.error('channel-view: join_channel failed', err);
    } finally {
      if (
        generation === joinGeneration &&
        current.channelId === requestedChannelId
      ) {
        joining = false;
      }
    }
  }

  function handleRosterCount(count: number): void {
    memberCount = count;
    current = { ...current, memberCount: count };
    onchannelchange?.(current);
  }

  /** In-chat file card → Files tab (US-008). Window event still fires from the card. */
  function handleOpenFile(model: FileAttachmentModel): void {
    const path = model.vaultPath?.trim() || model.name?.trim() || '';
    projectTab = 'files';
    highlightVaultPath = path || null;
  }

  // Reload when the selected channel changes (parent swaps `channel`).
  $effect(() => {
    // Touch channelId so the effect re-runs on selection change.
    const id = channel.channelId;
    // Metadata updates for the SAME channel are applied by the local command /
    // event paths below. Do not subscribe this selection effect to the whole
    // object or onchannelchange would feed a fresh object back from the parent
    // and repeatedly restart the channel load.
    const nextChannel = untrack(() => channel);
    if (activeChannelId === id) return;
    activeChannelId = id;
    loadGeneration += 1;
    sendGeneration += 1;
    joinGeneration += 1;
    current = nextChannel;
    memberCount = nextChannel.memberCount ?? null;
    messages = [];
    nextCursor = null;
    loadingOlder = false;
    outboundById = new Map();
    sending = false;
    joining = false;
    sendError = null;
    joinError = null;
    rosterOpen = false;
    statusOpen = false;
    statusModel = null;
    projectTab = 'chat';
    highlightVaultPath = null;
    void id;
    void load();
  });

  // Reactions controller lifecycle: one per channel id. Recreated on channel
  // swap so each channel keeps its own messageScope; disposed on teardown.
  $effect(() => {
    const id = channel.channelId;
    if (!id) {
      reactionsCtl?.dispose();
      reactionsCtl = null;
      return;
    }
    const controller = new ReactionController(channelScope(id));
    reactionsCtl = controller;
    return () => controller.dispose();
  });

  // Keep the active-conversation registration + loaded reactions in step with the
  // visible channel messages (skip optimistic local-* ids — no server reactions
  // yet). Only for a joined channel (the invited preview has no toggle surface).
  $effect(() => {
    const controller = reactionsCtl;
    if (!controller || invited) return;
    const ids = messages
      .filter((m) => !m.eventId.startsWith('local-'))
      .map((m) => m.eventId);
    void controller.setMessages(ids);
  });

  // Live refresh: a `channel:new-message` for THIS channel reloads the thread
  // (and re-marks read since the user is looking at it). Other channels are
  // handled by the parent list. `channel:updated` for this channel patches the
  // local metadata.
  $effect(() => {
    const unlisteners: Array<() => void> = [];
    let disposed = false;
    const track = (unlisten: () => void) => {
      const safe = safeUnlisten(unlisten);
      if (disposed) safe();
      else unlisteners.push(safe);
    };
    void listen<{ channelId: string; unread?: number }>('channel:new-message', (e) => {
      if (e.payload.channelId === current.channelId) {
        void load();
      }
    }).then(track);
    // Reactions on a message in this channel changed (US-025). The controller
    // ignores events for any other scope, so this is safe even mid-swap.
    void listen<ReactionEvent>('message:reaction', (e) => {
      reactionsCtl?.applyEvent(e.payload);
    }).then(track);
    void listen<Channel>('channel:updated', (e) => {
      if (e.payload.channelId === current.channelId) {
        current = { ...current, ...e.payload };
        memberCount = current.memberCount ?? memberCount;
        onchannelchange?.(current);
      }
    }).then(track);
    return () => {
      disposed = true;
      for (const fn of unlisteners) fn();
    };
  });
</script>

<header
  class="channel-header chat-shell"
  class:project={isProject}
  class:group-dm={isGroup}
  data-tauri-drag-region
  data-testid={isGroup ? 'group-dm-header' : 'channel-header'}
>
  <div class="channel-title-block">
    <div class="channel-title">
      {#if isGroup}
        <h2 data-testid="group-dm-title">{title}</h2>
        <span class="channel-sub">group message</span>
      {:else if isProject}
        <h2 data-testid="project-channel-title">{projectHeader.title}</h2>
        <span class="channel-sub" data-testid="project-channel-sub">{projectHeader.subtitle}</span>
      {:else}
        <span class="channel-hash" aria-hidden="true">#</span>
        <h2>{title}</h2>
        <span class="channel-sub">{chip}</span>
      {/if}
    </div>
  </div>
  <div class="channel-header-trailing">
    {#if isProject}
      <nav class="project-tabs" aria-label="Project channel views" data-testid="project-channel-tabs">
        <button
          type="button"
          class="project-tab"
          class:active={projectTab === 'chat'}
          aria-current={projectTab === 'chat' ? 'page' : undefined}
          data-testid="project-tab-chat-btn"
          onclick={() => (projectTab = 'chat')}
        >
          <span class="project-tab-icon" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
              <path d="M2.75 3.5h10.5v7.25H7.2L4 13.25V10.75H2.75V3.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
            </svg>
          </span>
          <span>Chat</span>
        </button>
        <button
          type="button"
          class="project-tab"
          class:active={projectTab === 'board'}
          aria-current={projectTab === 'board' ? 'page' : undefined}
          data-testid="project-tab-board-btn"
          onclick={() => (projectTab = 'board')}
        >
          <span class="project-tab-icon" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
              <rect x="2.5" y="2.5" width="4" height="11" rx="0.75" stroke="currentColor" stroke-width="1.2" />
              <rect x="9.5" y="2.5" width="4" height="7" rx="0.75" stroke="currentColor" stroke-width="1.2" />
            </svg>
          </span>
          <span>Board</span>
        </button>
        <button
          type="button"
          class="project-tab"
          class:active={projectTab === 'files'}
          aria-current={projectTab === 'files' ? 'page' : undefined}
          data-testid="project-tab-files-btn"
          onclick={() => (projectTab = 'files')}
        >
          <span class="project-tab-icon" aria-hidden="true">
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
              <path d="M4 2.75h4.2L12 5.55V13.25H4V2.75Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
              <path d="M8.2 2.9v2.8H12" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
            </svg>
          </span>
          <span>Files</span>
        </button>
      </nav>
    {/if}
    <!-- G8: the members pill shows on every conversation kind, group DMs included. -->
    {#if !invited}
      <button
        class="member-count-btn"
        type="button"
        data-testid="channel-member-count"
        onclick={openMembersSurface}
        title={isProject ? 'Members and status' : 'View members'}
        aria-label={memberCount != null
          ? `View ${memberCount} ${memberCount === 1 ? 'member' : 'members'}`
          : 'View members'}
        aria-expanded={isProject ? statusOpen : rosterOpen}
      >
        <span class="member-count-icon" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none">
            <circle cx="6" cy="5.5" r="2.25" stroke="currentColor" stroke-width="1.2" />
            <path d="M2.5 12.5c.4-2 1.9-3 3.5-3s3.1 1 3.5 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            <circle cx="11" cy="6" r="1.75" stroke="currentColor" stroke-width="1.2" />
            <path d="M11.5 9.5c1.2.2 2.2 1.1 2.5 2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
        </span>
        <span class="member-count-num">
          {#if memberCount != null}
            {memberCount}
          {:else}
            —
          {/if}
        </span>
        <span class="member-count-chevron" aria-hidden="true">⌄</span>
      </button>
    {/if}
  </div>
</header>

{#if isProject && projectTab === 'board'}
  <BoardTab
    channel={current}
    {messages}
    onOpenInChannel={() => (projectTab = 'chat')}
  />
{:else if isProject && projectTab === 'files'}
  <ChannelFilesTab
    channelId={current.channelId}
    highlightVaultPath={highlightVaultPath}
  />
{:else if invited}
  <!-- Invited-but-not-joined: the thread is a read-only preview. `readonly`
       hides the composer and renders a static "preview" note in its place — the
       Join CTA below is the only write affordance. Without readonly the composer
       rendered fully (textarea + Send + ⌘↵) but onsend was a no-op, so a typed
       message silently vanished with no error and no hint to join first. -->
  <Conversation
    {messages}
    showAuthors={true}
    {loading}
    error={threadError}
    onretryload={retryThread}
    sending={false}
    sendError={null}
    placeholder=""
    readonly={true}
    onsend={() => {}}
  />
  <div class="join-cta">
    <p class="join-text">
      You've been invited to <strong>{conversationLabel}</strong>. Join to read the full
      conversation and post.
    </p>
    {#if joinError}
      <p class="join-error" role="alert">{joinError}</p>
    {/if}
    <button
      class="btn btn-join"
      type="button"
      onclick={join}
      disabled={joining}
      aria-busy={joining}
    >
      {#if joining}
        <span class="inline-spinner" aria-hidden="true"></span>
      {/if}
      {joining ? 'Joining…' : isGroup ? 'Join conversation' : `Join #${title}`}
    </button>
  </div>
{:else}
  <Conversation
    {messages}
    showAuthors={true}
    {loading}
    error={threadError}
    onretryload={retryThread}
    {sending}
    {sendError}
    placeholder={composerPlaceholder}
    onsend={send}
    {onopenthread}
    {activeRootEventId}
    reactions={reactionsCtl?.map ?? {}}
    ontogglereaction={reactionsCtl ? reactionsCtl.toggle : undefined}
    onloadolder={loadOlder}
    {loadingOlder}
    {hasOlder}
    onretrysend={retryFailedSend}
    onopenfile={handleOpenFile}
  />
{/if}

<!-- Escape dismisses the members/status popovers regardless of where focus
     sits (aligned with the other popovers) — the backdrop keydown alone only
     fired when focus was inside the popover. -->
<svelte:window
  onkeydown={(e) => {
    if (e.key !== 'Escape') return;
    if (statusOpen) {
      statusOpen = false;
      e.stopPropagation();
    } else if (rosterOpen) {
      rosterOpen = false;
      e.stopPropagation();
    }
  }}
/>

{#if rosterOpen && !isProject}
  <ChannelRoster
    channelId={current.channelId}
    {selfPersonUid}
    onclose={() => (rosterOpen = false)}
    oncountchange={handleRosterCount}
  />
{/if}

{#if statusOpen && isProject}
  <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
  <div
    class="status-backdrop"
    data-testid="project-status-popover"
    role="presentation"
    onclick={(e) => {
      if (e.target === e.currentTarget) statusOpen = false;
    }}
    onkeydown={(e) => {
      if (e.key === 'Escape') statusOpen = false;
    }}
  >
    <div
      class="status-popover"
      role="dialog"
      aria-label="Members and status"
      aria-busy={statusLoading}
      tabindex="-1"
      onclick={(e) => e.stopPropagation()}
    >
      <header class="status-head">
        <span class="status-head-label">Status</span>
        <button type="button" class="status-close" onclick={() => (statusOpen = false)}>
          Close
        </button>
      </header>

      {#if statusLoading && !statusModel}
        <p class="status-empty" role="status">Loading…</p>
      {:else if statusModel}
        {#if statusModel.liveAgents.length > 0}
          <section class="status-section" aria-label="Live agents">
            {#each statusModel.liveAgents as agent (agent.id)}
              <div class="status-agent-row">
                <div class="status-agent-name">{agent.displayName}</div>
                <div class="status-agent-label">{agent.label}</div>
                <div
                  class="status-progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={agent.progressPercent}
                >
                  <span class="status-progress-fill" style={`width: ${agent.progressPercent}%`}></span>
                </div>
              </div>
            {/each}
          </section>
        {/if}

        <!-- Story rollup on its own row — avoids colliding with agent progress (D-06). -->
        <section class="status-section status-stories" aria-label="Stories">
          <p class="status-rollup" data-testid="status-story-rollup">
            {statusModel.stories.label}
            {#if statusModel.stories.total > 0}
              <span class="status-rollup-pct"> · {statusModel.stories.percent}%</span>
            {/if}
          </p>
        </section>

        <section class="status-section" aria-label="Project">
          <div class="status-section-label">Project</div>
          <div class="status-kv">
            <span class="status-k">Branch</span>
            <span class="status-v">{statusModel.project.branch ?? '—'}</span>
          </div>
          <div class="status-kv">
            <span class="status-k">Repo</span>
            <span class="status-v">{statusModel.project.repo ?? '—'}</span>
          </div>
          <div class="status-kv">
            <span class="status-k">Preview</span>
            {#if statusModel.project.previewUrl}
              <button
                type="button"
                class="status-link"
                onclick={() => void openPreview(statusModel!.project.previewUrl!)}
              >
                Open preview
              </button>
            {:else}
              <span class="status-v">—</span>
            {/if}
          </div>
        </section>

        <section class="status-section" aria-label="Members">
          <div class="status-section-label">
            <span>Members</span>
            <span class="status-section-count">({statusModel.members.length})</span>
          </div>
          {#if statusModel.members.length === 0}
            <p class="status-empty">No human members listed</p>
          {:else}
            <ul class="status-list">
              {#each statusModel.members as m (m.personUid)}
                <li class="status-person">
                  <span class="status-person-name">{m.displayName}</span>
                  {#if m.role}
                    <span class="status-person-role">{m.role}</span>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        <!-- G8: agent-status section renders only when agent data exists. -->
        {#if statusModel.agents.length > 0}
          <section class="status-section" aria-label="Agents">
            <div class="status-section-label">
              <span>Agents</span>
              <span class="status-section-count">({statusModel.agents.length})</span>
            </div>
            <ul class="status-list">
              {#each statusModel.agents as a (a.personUid)}
                <li class="status-person">
                  <span
                    class="status-dot"
                    class:running={a.statusIcon === 'running'}
                    aria-hidden="true"
                  ></span>
                  <span class="status-person-name">{a.displayName}</span>
                  <span class="status-person-role">{a.statusIcon}</span>
                </li>
              {/each}
            </ul>
          </section>
        {/if}
      {:else}
        <p class="status-empty" role="status">Status unavailable</p>
      {/if}
    </div>
  </div>
{/if}

<style>
  .channel-header {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 52px;
    padding: 0 20px;
    border-bottom: 1px solid var(--line, var(--border, var(--pop-divider)));
    flex-shrink: 0;
  }

  .channel-header.project {
    align-items: center;
  }

  .channel-title-block {
    display: flex;
    flex-direction: row;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    flex: 1;
  }

  .channel-title {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }

  .channel-title h2 {
    margin: 0;
    color: var(--t1, inherit);
    font-size: 15px;
    font-weight: 600;
    line-height: 1.45;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .channel-sub {
    color: var(--t3, var(--muted-3, var(--pop-muted)));
    font-size: 12px;
    font-weight: 400;
    line-height: 1.45;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* D-11: tabs right-aligned as icon+label; full hit-target buttons. */
  .channel-header-trailing {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex: 0 0 auto;
    margin-left: auto;
  }

  .project-tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    background: var(--raised, transparent);
    border: none;
    border-radius: 8px;
    padding: 2px;
  }

  .project-tab {
    appearance: none;
    -webkit-appearance: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 4px 10px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--t2, var(--muted-2, var(--pop-muted)));
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    line-height: 1;
    cursor: pointer;
    transition: color 0.12s;
  }

  .project-tab:hover {
    color: var(--t1, var(--fg, var(--pop-text)));
  }

  .project-tab.active {
    color: var(--t1, var(--fg, var(--pop-text)));
    background: var(--sel, var(--pop-hover));
  }

  .project-tab:focus-visible {
    outline: 2px solid var(--fg, var(--pop-text));
    outline-offset: 2px;
  }

  .project-tab-icon {
    display: grid;
    place-items: center;
    flex: 0 0 auto;
  }

  .member-count-btn {
    appearance: none;
    -webkit-appearance: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid transparent;
    border-radius: 8px;
    background: var(--btn-bg, transparent);
    color: var(--t2, var(--pop-text));
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
  }

  .member-count-btn:hover {
    border-color: var(--line2, var(--pop-divider));
    color: var(--t1, var(--fg, var(--pop-text)));
  }

  .member-count-icon {
    display: grid;
    place-items: center;
    color: var(--muted-2, var(--pop-muted));
  }

  .member-count-num {
    font-variant-numeric: tabular-nums;
    font-weight: 500;
  }

  .member-count-chevron {
    color: var(--muted-2, var(--pop-muted));
    font-size: 11px;
    line-height: 1;
  }

  .status-backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: flex;
    align-items: flex-start;
    justify-content: flex-end;
    padding: 3.5rem 1.25rem 1.25rem;
    background: color-mix(in srgb, var(--pop-bg, #111) 20%, transparent);
  }

  .status-popover {
    width: min(320px, 100%);
    max-height: min(70vh, 520px);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.75rem 0.875rem 1rem;
    border: 1px solid var(--border, var(--pop-divider));
    border-radius: 0;
    /* Opaque surface (D-03). */
    background: var(--v4-surface-solid, var(--c-bg, #fff));
    color: var(--fg, var(--pop-text));
    font-family: var(--font-sans);
    box-shadow: var(--v4-shadow-popover, 0 12px 32px rgba(0, 0, 0, 0.18));
  }

  .status-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .status-head-label {
    font-size: var(--text-base);
    font-weight: 500;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted-2, var(--pop-muted));
  }

  .status-close {
    appearance: none;
    border: none;
    background: transparent;
    color: var(--muted-2, var(--pop-muted));
    font: inherit;
    font-size: var(--text-base);
    font-weight: 400;
    cursor: pointer;
    padding: 0;
  }

  .status-section {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding-top: 0.5rem;
    border-top: 1px solid var(--border, var(--pop-divider));
  }

  .status-section-label {
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--muted-2, var(--pop-muted));
  }

  .status-agent-row {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding-bottom: 0.35rem;
  }

  .status-agent-name {
    font-size: var(--text-base);
    font-weight: 500;
    color: var(--fg, var(--pop-text));
  }

  .status-agent-label {
    font-size: var(--type-metadata, 12px);
    font-weight: 400;
    color: var(--muted-2, var(--pop-muted));
  }

  .status-progress {
    height: 2px;
    width: 100%;
    margin-top: 0.15rem;
    background: color-mix(in srgb, var(--fg, #fff) 12%, transparent);
    border-radius: 0;
    overflow: hidden;
  }

  .status-progress-fill {
    display: block;
    height: 100%;
    background: var(--fg, var(--pop-text));
    border-radius: 0;
  }

  .status-stories {
    /* Clear separation from agent progress rows (D-06 collision fix). */
    margin-top: 0.15rem;
  }

  .status-rollup {
    margin: 0;
    font-size: var(--text-base);
    font-weight: 400;
    color: var(--muted-2, var(--pop-muted));
  }

  .status-rollup-pct {
    font-variant-numeric: tabular-nums;
  }

  .status-section-count {
    font-weight: 400;
    color: var(--muted-2, var(--pop-muted));
  }

  .status-kv {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: var(--text-base);
  }

  .status-k {
    flex: 0 0 auto;
    min-width: 3.5rem;
    font-weight: 400;
    color: var(--muted-2, var(--pop-muted));
  }

  .status-v {
    min-width: 0;
    font-weight: 400;
    color: var(--fg, var(--pop-text));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-link {
    appearance: none;
    border: none;
    border-bottom: 1px solid var(--fg, var(--pop-text));
    border-radius: 0;
    background: transparent;
    color: var(--fg, var(--pop-text));
    font: inherit;
    font-size: var(--text-base);
    font-weight: 400;
    padding: 0;
    cursor: pointer;
  }

  .status-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .status-person {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-size: var(--text-base);
    font-weight: 400;
  }

  .status-person-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-person-role {
    color: var(--muted-2, var(--pop-muted));
    font-weight: 400;
  }

  .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--muted-2, var(--pop-muted));
    flex-shrink: 0;
  }

  .status-dot.running {
    background: var(--v4-ok, #6a6);
  }

  .status-empty {
    margin: 0;
    font-size: var(--text-base);
    font-weight: 400;
    color: var(--muted-2, var(--pop-muted));
  }

  .channel-hash {
    font-size: 15px;
    font-weight: 600;
    color: var(--t3, var(--muted, var(--pop-muted)));
  }

  .channel-title h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--t1, var(--fg, var(--pop-text)));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .scope-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.1875rem;
    flex-shrink: 0;
    font-size: 12px;
    font-weight: 400;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--t3, var(--muted-2, var(--pop-muted)));
  }

  .scope-chip.personal {
    background: transparent;
    color: var(--muted-2);
  }

  .scope-glyph {
    font-size: var(--text-base);
    line-height: 1;
  }

  .member-count-btn {
    margin-left: auto;
    flex-shrink: 0;
    border: 1px solid transparent;
    border-radius: 8px;
    background: var(--btn-bg, transparent);
    color: var(--t2, var(--muted-2, var(--pop-muted)));
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    padding: 5px 12px;
    white-space: nowrap;
    cursor: pointer;
    transition:
      transform 120ms var(--ease-out, cubic-bezier(0.23, 1, 0.32, 1)),
      color 120ms ease,
      border-color 120ms ease;
  }

  .join-cta {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    padding: 1rem 1.25rem 1.25rem;
    border-top: 1px solid var(--border, var(--pop-divider));
  }

  .join-text {
    margin: 0;
    font-size: var(--text-base);
    line-height: 1.5;
    color: var(--muted-2, var(--pop-muted));
  }

  .join-text strong {
    color: var(--fg, var(--pop-text));
    font-weight: 600;
  }

  .join-error {
    margin: 0;
    font-size: var(--text-base);
    color: var(--red, var(--popover-danger));
  }

  .btn {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    padding: 0.4375rem 0.875rem;
    border-radius: 7px;
    font-size: var(--text-base);
    font-weight: 600;
    cursor: pointer;
    border: none;
    font-family: inherit;
    transition: background-color 0.12s ease;
  }

  .inline-spinner {
    width: 0.75rem;
    height: 0.75rem;
    flex: 0 0 auto;
    border: 1.5px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: channel-spin 0.72s linear infinite;
  }

  .btn-join {
    background: var(--accent, var(--c-btn-bg));
    color: var(--accent-fg, var(--c-btn-fg));
  }

  .btn-join:hover:not(:disabled) {
    filter: brightness(0.94);
  }

  .btn-join:disabled {
    opacity: 0.45;
    cursor: default;
  }

  /* Channel metadata is informative, not a stack of controls in rounded
     containers. Keep it quiet and inline in both Messages surfaces. */
  :global(html[data-window='dm-detail']) .channel-header {
    gap: 0.625rem;
    padding: 0.75rem 1.125rem;
  }

  :global(html[data-window='dm-detail']) .scope-chip {
    gap: 0.1875rem;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--pop-muted);
    font-size: 0.6875rem;
    font-weight: 560;
  }

  :global(html[data-window='dm-detail']) .scope-chip.personal {
    background: transparent;
    color: var(--pop-muted);
  }

  :global(html[data-window='dm-detail']) .member-count-btn {
    font-size: 0.6875rem;
  }

  .member-count-btn:active:not(:disabled),
  .btn:active:not(:disabled) {
    transform: scale(0.97);
  }

  .member-count-btn:focus-visible,
  .btn:focus-visible {
    outline: 2px solid var(--pop-text);
    outline-offset: 2px;
  }

  :global(html[data-window='dm-detail']) .btn {
    transition: transform 120ms var(--ease-out, cubic-bezier(0.23, 1, 0.32, 1));
  }

  :global(html[data-window='dm-detail']) .btn-join {
    border-radius: 6px;
    background: var(--pop-text);
    color: var(--pop-bg);
  }

  :global(html[data-window='dm-detail']) .btn-join:hover:not(:disabled) {
    background: var(--pop-text);
    filter: none;
  }

  @keyframes channel-spin {
    to { transform: rotate(360deg); }
  }

  @media (hover: hover) and (pointer: fine) {
    .member-count-btn:hover {
      border-color: var(--line2, currentColor);
      color: var(--t1, var(--fg, var(--pop-text)));
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .inline-spinner {
      animation-duration: 1.4s;
    }

    .member-count-btn,
    .btn {
      transition: none;
    }

    .member-count-btn:active:not(:disabled),
    .btn:active:not(:disabled) {
      transform: none;
    }
  }
</style>

/**
 * Production-contract chat fixtures for the browser dev-harness (US-019).
 *
 * Shapes mirror hq-pro vault-service contracts:
 *   - channels / messages / systemEvent / attachment (lib/channels.ts, message-attachments.ts)
 *   - NOTIF store rows (lib/notification-types.ts, handlers/notifications.ts)
 *   - pairUnreads (handlers/notify-dm.ts)
 *   - channel files index (CHAN_FILE rows)
 *
 * Timestamps for sidebar day-grouping use relative offsets from a frozen
 * "now" so LAST WEEK / TODAY buckets stay stable across runs. Message
 * `createdAt` values for timeline content use fixed ISO strings so assertions
 * never depend on wall-clock clock skew.
 */

/**
 * Frozen anchor used only for *message timeline* `createdAt` strings so
 * assertions never depend on wall clock. Sidebar day-buckets (`lastActivityAt`)
 * must be relative to real `Date.now()` so LAST WEEK / TODAY still group
 * correctly whenever the harness is opened.
 */
export const HARNESS_CHAT_NOW_MS = Date.parse('2026-08-12T18:00:00.000Z');

/** Absolute ISO helper for message timelines (fixed, not wall-clock). */
export function harnessIso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Relative ISO from an injectable now (defaults to wall clock for sidebar). */
export function harnessMinsAgo(mins: number, nowMs: number = Date.now()): string {
  return new Date(nowMs - mins * 60_000).toISOString();
}

/** Days ago (for LAST WEEK bucket — must use wall clock). */
export function harnessDaysAgo(days: number, nowMs: number = Date.now()): string {
  return new Date(nowMs - days * 86_400_000).toISOString();
}

// ── Channels list (list_channels) ────────────────────────────────────────────

export const CHAT_PROJECT_CHANNEL_ID = 'ch_proj_desktop_v2';
export const CHAT_GROUP_DM_ID = 'ch_group_release';
export const CHAT_COMPANY_CHANNEL_ID = 'ch_core';
export const CHAT_LAST_WEEK_CHANNEL_ID = 'ch_archive_notes';
export const CHAT_PINNED_CHANNEL_ID = 'ch_corey_exec';

/** Pins persisted to localStorage under `hq.chat.pins` (sidebar model key). */
export const CHAT_PIN_IDS = [`ch:${CHAT_PINNED_CHANNEL_ID}`, `dm:prs_ada`] as const;

/** Build channel list with activity relative to `nowMs` (wall clock by default). */
export function buildChatChannels(nowMs: number = Date.now()) {
  return [
    {
      channelId: CHAT_PINNED_CHANNEL_ID,
      name: 'corey-exec',
      scope: 'company',
      companyUid: 'cmp_indigo',
      companyName: 'Indigo',
      visibility: 'private',
      membership: 'joined',
      unread: 0,
      memberCount: 5,
      lastActivityAt: harnessMinsAgo(45, nowMs),
      lastMessageAt: harnessMinsAgo(45, nowMs),
      createdAt: '2026-05-01T12:00:00.000Z',
    },
    {
      channelId: CHAT_PROJECT_CHANNEL_ID,
      name: 'hq-desktop-v2-chat',
      scope: 'project',
      companyUid: 'cmp_indigo',
      companyName: 'Indigo',
      projectId: 'in-proj-201',
      visibility: 'invite',
      membership: 'joined',
      unread: 3,
      memberCount: 6,
      lastActivityAt: harnessMinsAgo(8, nowMs),
      lastMessageAt: harnessMinsAgo(8, nowMs),
      createdAt: '2026-07-01T12:00:00.000Z',
    },
    {
      channelId: CHAT_COMPANY_CHANNEL_ID,
      name: 'hq-core',
      scope: 'company',
      companyUid: 'cmp_indigo',
      companyName: 'Indigo',
      visibility: 'company',
      membership: 'joined',
      unread: 4,
      memberCount: 18,
      lastActivityAt: harnessMinsAgo(32, nowMs),
      lastMessageAt: harnessMinsAgo(32, nowMs),
      createdAt: '2026-04-01T12:00:00.000Z',
    },
    {
      channelId: CHAT_GROUP_DM_ID,
      name: '',
      scope: 'group',
      visibility: 'private',
      membership: 'joined',
      unread: 2,
      memberCount: 3,
      lastActivityAt: harnessMinsAgo(12, nowMs),
      lastMessageAt: harnessMinsAgo(12, nowMs),
      createdAt: '2026-06-01T12:00:00.000Z',
      members: [
        { personUid: 'prs_jacob', displayName: 'Jacob Patel' },
        { personUid: 'prs_alan', displayName: 'Alan Turing' },
      ],
    },
    {
      channelId: 'ch_personal_scratch',
      name: 'scratch',
      scope: 'personal',
      visibility: 'private',
      membership: 'joined',
      unread: 0,
      memberCount: 1,
      lastActivityAt: harnessMinsAgo(90, nowMs),
      lastMessageAt: harnessMinsAgo(90, nowMs),
      createdAt: '2026-03-01T12:00:00.000Z',
    },
    {
      // Older than 7 day-buckets → LAST WEEK collapse group.
      channelId: CHAT_LAST_WEEK_CHANNEL_ID,
      name: 'archive-notes',
      scope: 'company',
      companyUid: 'cmp_indigo',
      companyName: 'Indigo',
      visibility: 'company',
      membership: 'joined',
      unread: 0,
      memberCount: 4,
      lastActivityAt: harnessDaysAgo(10, nowMs),
      lastMessageAt: harnessDaysAgo(10, nowMs),
      createdAt: '2026-01-15T12:00:00.000Z',
    },
    {
      channelId: 'ch_liverecover_ops',
      name: 'ops',
      scope: 'company',
      companyUid: 'cmp_liverecover',
      companyName: 'LiveRecover',
      visibility: 'company',
      membership: 'joined',
      unread: 1,
      memberCount: 9,
      lastActivityAt: harnessMinsAgo(200, nowMs),
      lastMessageAt: harnessMinsAgo(200, nowMs),
      createdAt: '2026-05-20T12:00:00.000Z',
    },
  ];
}

/** Snapshot of channel ids for source-contract sweeps. */
export const CHAT_CHANNEL_IDS = [
  CHAT_PINNED_CHANNEL_ID,
  CHAT_PROJECT_CHANNEL_ID,
  CHAT_COMPANY_CHANNEL_ID,
  CHAT_GROUP_DM_ID,
  'ch_personal_scratch',
  CHAT_LAST_WEEK_CHANNEL_ID,
  'ch_liverecover_ops',
] as const;

// ── Contacts / DMs (list_contacts) ───────────────────────────────────────────

export function buildChatContacts(nowMs: number = Date.now()) {
  return [
    {
      personUid: 'prs_ada',
      email: 'ada@getindigo.ai',
      displayName: 'Ada Lovelace',
      companyUid: 'cmp_indigo',
      source: 'company',
      lastMessageAt: harnessMinsAgo(22, nowMs),
      lastMessageBody: 'Please do — restyling it to match the desktop view right now.',
      lastMessageDirection: 'out',
    },
    {
      personUid: 'prs_grace',
      email: 'grace@getindigo.ai',
      displayName: 'Grace Hopper',
      companyUid: 'cmp_indigo',
      source: 'company',
      lastMessageAt: harnessMinsAgo(55, nowMs),
      lastMessageBody: 'Pushed the conflict-versioning notes — take a look when you get a sec?',
      lastMessageDirection: 'in',
    },
    {
      personUid: 'prs_alan',
      email: 'alan@example.com',
      displayName: 'Alan Turing',
      companyUid: null,
      source: 'connection',
      lastMessageAt: harnessDaysAgo(9, nowMs),
      lastMessageBody: 'Meeting recap is synced to the Liverecover folder.',
      lastMessageDirection: 'in',
    },
    {
      personUid: 'prs_katherine',
      email: 'katherine@getindigo.ai',
      displayName: 'Katherine Johnson',
      companyUid: 'cmp_indigo',
      source: 'company',
      lastMessageAt: harnessMinsAgo(140, nowMs),
      lastMessageBody: 'Orbit math notes are ready for review.',
      lastMessageDirection: 'in',
    },
  ];
}

/** pairUnreads payload (dm:pair-unreads event / inbox additive field). */
export const CHAT_PAIR_UNREADS = {
  pairUnreads: [
    { withPersonUid: 'prs_ada', unreadCount: 2 },
    { withPersonUid: 'prs_grace', unreadCount: 1 },
  ],
} as const;

// ── Project channel timeline (fetch_channel) ─────────────────────────────────

/**
 * Full row-type matrix for the project channel chat tab:
 * human messages, every known system event type, run-complete card, file card.
 * Ordered newest-first (server wire convention); ChannelView reverses for paint.
 */
export const PROJECT_CHANNEL_MESSAGES = [
  {
    eventId: 'msg_human_out',
    fromPersonUid: 'prs_me',
    fromEmail: 'corey@getindigo.ai',
    fromDisplayName: 'Corey Epstein',
    body: 'Landing the chat shell fixtures now — composer states next.',
    createdAt: '2026-08-12T17:52:00.000Z',
    direction: 'out',
  },
  {
    eventId: 'msg_human_in',
    fromPersonUid: 'prs_maya',
    fromEmail: 'maya@getindigo.ai',
    fromDisplayName: 'Maya Chen',
    body: 'Timeline looks complete — every system event + the file card.',
    createdAt: '2026-08-12T17:50:00.000Z',
    direction: 'in',
  },
  {
    eventId: 'msg_file_card',
    fromPersonUid: 'prs_maya',
    fromEmail: 'maya@getindigo.ai',
    fromDisplayName: 'Maya Chen',
    body: 'Attached the acceptance checklist.',
    createdAt: '2026-08-12T17:48:00.000Z',
    direction: 'in',
    attachment: {
      vaultPath: 'companies/indigo/projects/event-driven-hq-cloud-sync/acceptance.md',
      name: 'acceptance.md',
      sizeBytes: 4820,
      kind: 'text/markdown',
    },
  },
  {
    eventId: 'msg_run_complete',
    fromPersonUid: 'agt_izzy',
    fromEmail: 'izzy@agents.getindigo.ai',
    fromDisplayName: 'Izzy',
    body: 'Run complete',
    messageKind: 'system',
    createdAt: '2026-08-12T17:45:00.000Z',
    direction: 'in',
    systemEvent: {
      v: 1,
      type: 'run_complete',
      title: 'Run complete',
      summary: 'US-019 harness fixtures — all green',
      previewUrl: 'https://example.invalid/preview/us-019',
      diffUrl: 'https://example.invalid/diff/us-019',
      meshThreadId: 'mesh_thread_019',
      meshEventId: 'mesh_evt_complete',
    },
  },
  {
    eventId: 'msg_sys_deploy',
    fromPersonUid: 'agt_izzy',
    fromEmail: 'izzy@agents.getindigo.ai',
    fromDisplayName: 'Izzy',
    body: 'Deployed',
    messageKind: 'system',
    createdAt: '2026-08-12T17:40:00.000Z',
    direction: 'in',
    systemEvent: {
      v: 1,
      type: 'deploy',
      title: 'Deployed',
      summary: 'Preview harness build promoted',
      meshThreadId: 'mesh_thread_019',
      meshEventId: 'mesh_evt_deploy',
    },
  },
  {
    eventId: 'msg_sys_pr',
    fromPersonUid: 'agt_izzy',
    fromEmail: 'izzy@agents.getindigo.ai',
    fromDisplayName: 'Izzy',
    body: 'PR opened',
    messageKind: 'system',
    createdAt: '2026-08-12T17:35:00.000Z',
    direction: 'in',
    systemEvent: {
      v: 1,
      type: 'pr_opened',
      title: 'PR opened',
      summary: 'feature/hq-desktop-v2-chat → main',
      meshThreadId: 'mesh_thread_019',
      meshEventId: 'mesh_evt_pr',
    },
  },
  {
    eventId: 'msg_sys_file_added',
    fromPersonUid: 'agt_izzy',
    fromEmail: 'izzy@agents.getindigo.ai',
    fromDisplayName: 'Izzy',
    body: 'File added',
    messageKind: 'system',
    createdAt: '2026-08-12T17:30:00.000Z',
    direction: 'in',
    systemEvent: {
      v: 1,
      type: 'file_added',
      title: 'File added',
      summary: 'prd.json updated',
      meshThreadId: 'mesh_thread_019',
      meshEventId: 'mesh_evt_file',
    },
  },
  {
    eventId: 'msg_sys_progress',
    fromPersonUid: 'agt_izzy',
    fromEmail: 'izzy@agents.getindigo.ai',
    fromDisplayName: 'Izzy',
    body: 'Run progress',
    messageKind: 'system',
    createdAt: '2026-08-12T17:25:00.000Z',
    direction: 'in',
    systemEvent: {
      v: 1,
      type: 'run_progress',
      title: 'Run progress',
      summary: 'Implementing harness fixtures (60%)',
      meshThreadId: 'mesh_thread_019',
      meshEventId: 'mesh_evt_progress',
    },
  },
  {
    eventId: 'msg_sys_started',
    fromPersonUid: 'agt_izzy',
    fromEmail: 'izzy@agents.getindigo.ai',
    fromDisplayName: 'Izzy',
    body: 'Run started',
    messageKind: 'system',
    createdAt: '2026-08-12T17:20:00.000Z',
    direction: 'in',
    systemEvent: {
      v: 1,
      type: 'run_started',
      title: 'Run started',
      summary: 'US-019 E2E closeout',
      meshThreadId: 'mesh_thread_019',
      meshEventId: 'mesh_evt_start',
    },
  },
  {
    eventId: 'msg_agent_note',
    fromPersonUid: 'agt_izzy',
    fromEmail: 'izzy@agents.getindigo.ai',
    fromDisplayName: 'Izzy',
    body: 'Starting the harness parity pass.',
    details: 'Repo: apps/sync · story: US-019',
    prompt: '/run-project hq-desktop-v2-chat --story US-019',
    createdAt: '2026-08-12T17:15:00.000Z',
    direction: 'in',
  },
] as const;

/**
 * Composer optimistic states for the dedicated Conversation preview
 * (`?view=chat&screen=composer`). Not wire-shaped — client sendStatus only.
 */
export const COMPOSER_STATE_MESSAGES = [
  {
    eventId: 'local-send-failed',
    fromPersonUid: 'prs_me',
    fromDisplayName: 'Corey Epstein',
    body: 'This send failed — tap to retry.',
    createdAt: '2026-08-12T17:55:00.000Z',
    direction: 'out' as const,
    sendStatus: 'failed' as const,
  },
  {
    eventId: 'local-send-sending',
    fromPersonUid: 'prs_me',
    fromDisplayName: 'Corey Epstein',
    body: 'Still sending this one…',
    createdAt: '2026-08-12T17:54:30.000Z',
    direction: 'out' as const,
    sendStatus: 'sending' as const,
  },
  {
    eventId: 'msg_delivered',
    fromPersonUid: 'prs_me',
    fromDisplayName: 'Corey Epstein',
    body: 'Delivered — previous outbound.',
    createdAt: '2026-08-12T17:54:00.000Z',
    direction: 'out' as const,
    sendStatus: 'delivered' as const,
  },
  {
    eventId: 'msg_peer',
    fromPersonUid: 'prs_maya',
    fromDisplayName: 'Maya Chen',
    body: 'Composer states: Sending / Delivered / Failed.',
    createdAt: '2026-08-12T17:53:00.000Z',
    direction: 'in' as const,
  },
];

// ── Channel files (fetch_channel_files) ──────────────────────────────────────

export const CHANNEL_FILES_RESPONSE = {
  files: [
    {
      eventId: 'file_evt_1',
      messageEventId: 'msg_file_card',
      fromUid: 'prs_maya',
      fromDisplayName: 'Maya Chen',
      createdAt: '2026-08-12T17:48:00.000Z',
      attachment: {
        vaultPath: 'companies/indigo/projects/event-driven-hq-cloud-sync/acceptance.md',
        name: 'acceptance.md',
        sizeBytes: 4820,
        kind: 'text/markdown',
      },
    },
    {
      eventId: 'file_evt_2',
      messageEventId: 'msg_file_prd',
      fromUid: 'agt_izzy',
      fromDisplayName: 'Izzy',
      createdAt: '2026-08-12T16:10:00.000Z',
      attachment: {
        vaultPath: 'companies/indigo/projects/event-driven-hq-cloud-sync/prd.json',
        name: 'prd.json',
        sizeBytes: 18240,
        kind: 'application/json',
      },
    },
    {
      eventId: 'file_evt_3',
      messageEventId: 'msg_file_notes',
      fromUid: 'prs_corey',
      fromDisplayName: 'Corey Epstein',
      createdAt: '2026-08-11T14:00:00.000Z',
      attachment: {
        vaultPath: 'companies/indigo/projects/event-driven-hq-cloud-sync/notes.md',
        name: 'notes.md',
        sizeBytes: 960,
        kind: 'text/markdown',
      },
    },
  ],
  nextCursor: null,
} as const;

// ── Notifications (fetch_notifications → NOTIF store wire) ───────────────────

/**
 * One unread (or mixed) row per notification type in the production catalog,
 * plus UI taxonomy types the desktop maps (mention, agent_finished_story, …).
 */
export const CHAT_NOTIFICATIONS = [
  {
    id: 'notif_dm',
    type: 'dm',
    status: 'unread',
    createdAt: '2026-08-12T17:40:00.000Z',
    actorPersonUid: 'prs_ada',
    actorName: 'Ada Lovelace',
    title: 'New message',
    body: 'Please do — restyling it to match the desktop view.',
    targetRef: 'dm:prs_ada',
    actionable: false,
  },
  {
    id: 'notif_file_share',
    type: 'file_share',
    status: 'unread',
    createdAt: '2026-08-12T17:30:00.000Z',
    actorPersonUid: 'prs_jacob',
    actorName: 'Jacob Patel',
    title: 'Shared a file',
    body: 'companies/indigo/financials/Q2-model.xlsx',
    targetRef: 'share:share-1',
    actionable: false,
  },
  {
    id: 'notif_mention',
    type: 'mention',
    status: 'unread',
    createdAt: '2026-08-12T17:20:00.000Z',
    actorPersonUid: 'prs_maya',
    actorName: 'Maya Chen',
    title: 'Mentioned you',
    body: '@Corey can you review the harness fixtures?',
    targetRef: `channel:${CHAT_PROJECT_CHANNEL_ID}`,
    actionable: false,
  },
  {
    id: 'notif_agent_finished',
    type: 'agent_finished_story',
    status: 'unread',
    createdAt: '2026-08-12T17:10:00.000Z',
    actorPersonUid: 'agt_izzy',
    actorName: 'Izzy',
    title: 'Story finished',
    body: 'US-018 chat shell retirement — ready for review',
    targetRef: `channel:${CHAT_PROJECT_CHANNEL_ID}`,
    actionable: false,
  },
  {
    id: 'notif_agent_review',
    type: 'agent_review_request',
    status: 'unread',
    createdAt: '2026-08-12T17:00:00.000Z',
    actorPersonUid: 'agt_izzy',
    actorName: 'Izzy',
    title: 'Review requested',
    body: 'Please review the Core popover rescue card',
    targetRef: `channel:${CHAT_PROJECT_CHANNEL_ID}`,
    actionable: true,
    actionKind: 'agent_owner_approve',
    actionRef: 'story_us016',
  },
  {
    id: 'notif_security',
    type: 'security_alert',
    status: 'unread',
    createdAt: '2026-08-12T16:50:00.000Z',
    actorName: 'HQ',
    title: 'Security alert',
    body: 'Unexpected membership activation in a non-sandbox company',
    targetRef: 'company:cmp_indigo',
    actionable: false,
  },
  {
    id: 'notif_connection',
    type: 'connection_request',
    status: 'unread',
    createdAt: '2026-08-12T16:40:00.000Z',
    actorPersonUid: 'prs_lin',
    actorName: 'Lin Manuel',
    title: 'Connection request',
    body: 'Hi! We met at the HQ demo — would love to connect here.',
    actionable: true,
    actionKind: 'connection_accept',
    actionRef: 'pk1',
  },
  {
    id: 'notif_membership',
    type: 'membership_invite',
    status: 'unread',
    createdAt: '2026-08-12T16:30:00.000Z',
    actorPersonUid: 'prs_maya',
    actorName: 'Maya Chen',
    title: 'Company invite',
    body: 'Join Sender Agency on HQ',
    companyUid: 'cmp_sender',
    actionable: true,
    actionKind: 'membership_accept',
    actionRef: 'inv_sender_1',
  },
  {
    id: 'notif_access_request',
    type: 'access_request',
    status: 'read',
    readAt: '2026-08-12T16:00:00.000Z',
    createdAt: '2026-08-12T15:00:00.000Z',
    actorPersonUid: 'prs_rao',
    actorName: 'Rao Patel',
    title: 'Access request',
    body: 'Requesting read on companies/indigo/financials/',
    actionable: false,
  },
  {
    id: 'notif_access_grant',
    type: 'access_grant',
    status: 'read',
    readAt: '2026-08-12T14:50:00.000Z',
    createdAt: '2026-08-12T14:40:00.000Z',
    actorPersonUid: 'prs_maya',
    actorName: 'Maya Chen',
    title: 'Access granted',
    body: 'You can now read companies/indigo/financials/',
    actionable: false,
  },
  {
    id: 'notif_agent_owner_invite',
    type: 'agent_owner_invite',
    status: 'unread',
    createdAt: '2026-08-12T14:30:00.000Z',
    actorPersonUid: 'prs_corey',
    actorName: 'Corey Epstein',
    title: 'Agent owner invite',
    body: 'Own fleet agent Izzy for Indigo',
    actionable: true,
    actionKind: 'agent_owner_approve',
    actionRef: 'agt_izzy',
  },
  {
    id: 'notif_agent_owner_decision',
    type: 'agent_owner_decision',
    status: 'read',
    readAt: '2026-08-11T12:00:00.000Z',
    createdAt: '2026-08-11T11:00:00.000Z',
    actorPersonUid: 'prs_maya',
    actorName: 'Maya Chen',
    title: 'Agent owner decision',
    body: 'You are now owner of agent Lin',
    actionable: false,
  },
  {
    id: 'notif_sponsorship_request',
    type: 'sponsorship_request',
    status: 'unread',
    createdAt: '2026-08-12T14:00:00.000Z',
    actorPersonUid: 'prs_alan',
    actorName: 'Alan Turing',
    title: 'Sponsorship request',
    body: 'Requesting sponsorship for a new company seat',
    actionable: true,
    actionKind: 'sponsorship_approve',
    actionRef: 'spon_1',
  },
  {
    id: 'notif_sponsorship_decision',
    type: 'sponsorship_decision',
    status: 'read',
    readAt: '2026-08-10T10:00:00.000Z',
    createdAt: '2026-08-10T09:00:00.000Z',
    actorPersonUid: 'prs_corey',
    actorName: 'Corey Epstein',
    title: 'Sponsorship decision',
    body: 'Your sponsorship was approved',
    actionable: false,
  },
  {
    id: 'notif_connection_decision',
    type: 'connection_decision',
    status: 'read',
    readAt: '2026-08-09T10:00:00.000Z',
    createdAt: '2026-08-09T09:00:00.000Z',
    actorPersonUid: 'prs_grace',
    actorName: 'Grace Hopper',
    title: 'Connection accepted',
    body: 'Grace Hopper accepted your connection',
    actionable: false,
  },
  {
    id: 'notif_role_changed',
    type: 'role_changed',
    status: 'read',
    readAt: '2026-08-08T10:00:00.000Z',
    createdAt: '2026-08-08T09:00:00.000Z',
    actorPersonUid: 'prs_corey',
    actorName: 'Corey Epstein',
    title: 'Role changed',
    body: 'You are now admin of LiveRecover',
    companyUid: 'cmp_liverecover',
    actionable: false,
  },
  {
    id: 'notif_creator_app',
    type: 'creator_application',
    status: 'unread',
    createdAt: '2026-08-12T13:00:00.000Z',
    actorPersonUid: 'prs_preview_creator',
    actorName: 'Alex Builds',
    title: 'Creator application',
    body: 'alex-builds applied to publish packs',
    actionable: false,
  },
  {
    id: 'notif_creator_decision',
    type: 'creator_decision',
    status: 'read',
    readAt: '2026-08-07T10:00:00.000Z',
    createdAt: '2026-08-07T09:00:00.000Z',
    actorName: 'HQ',
    title: 'Creator decision',
    body: 'Your creator application was approved',
    actionable: false,
  },
  {
    id: 'notif_feedback',
    type: 'feedback_update',
    status: 'read',
    readAt: '2026-08-06T10:00:00.000Z',
    createdAt: '2026-08-06T09:00:00.000Z',
    actorName: 'HQ',
    title: 'Feedback update',
    body: 'Your feedback ticket was updated',
    actionable: false,
  },
  {
    id: 'notif_agent_channel',
    type: 'agent_channel_action_needed',
    status: 'unread',
    createdAt: '2026-08-12T12:30:00.000Z',
    actorPersonUid: 'agt_jack',
    actorName: 'Jack',
    title: 'Agent channel action needed',
    body: 'Slack OAuth re-attach required',
    actionable: true,
    actionKind: 'agent_owner_approve',
    actionRef: 'agt_jack_oauth',
  },
  {
    id: 'notif_agent_upgrade_req',
    type: 'agent_upgrade_request',
    status: 'unread',
    createdAt: '2026-08-12T12:00:00.000Z',
    actorPersonUid: 'prs_maya',
    actorName: 'Maya Chen',
    title: 'Agent upgrade request',
    body: 'Request to upgrade Izzy box size',
    actionable: false,
  },
  {
    id: 'notif_agent_upgrade_dec',
    type: 'agent_upgrade_decision',
    status: 'read',
    readAt: '2026-08-05T10:00:00.000Z',
    createdAt: '2026-08-05T09:00:00.000Z',
    actorPersonUid: 'prs_corey',
    actorName: 'Corey Epstein',
    title: 'Agent upgrade decision',
    body: 'Upgrade request approved',
    actionable: false,
  },
] as const;

export function chatNotificationsResponse(): {
  notifications: typeof CHAT_NOTIFICATIONS;
  unreadCount: number;
  nextCursor: null;
} {
  const unreadCount = CHAT_NOTIFICATIONS.filter((n) => n.status === 'unread').length;
  return {
    notifications: CHAT_NOTIFICATIONS,
    unreadCount,
    nextCursor: null,
  };
}

// ── Core popover scenario fixtures ───────────────────────────────────────────

export const CHAT_CONFLICT_FIXTURE = {
  path: 'companies/indigo/projects/hq-desktop-v2-chat/prd.json',
  localHash: 'local-chat-preview',
  remoteHash: 'remote-chat-preview',
  canAutoResolve: false,
} as const;

export const CHAT_CORE_DRIFT_STATE = {
  channel: 'release' as const,
  targetRepo: 'indigoai-us/hq-core',
  targetVersion: '15.0.17',
  targetRef: 'v15.0.17',
  localVersion: '15.0.16',
  floorSha: 'floor-chat-preview',
  isEligible: true,
  versionBehind: true,
  driftReport: {
    count: 2,
    modified: [
      {
        path: 'core/policies/desktop-design.md',
        size: 1840,
        gitShaLocal: 'local-design',
        gitShaUpstream: 'upstream-design',
      },
    ],
    missing: [],
    added: [],
    scannedAt: '2026-08-12T12:00:00.000Z',
    hqVersion: '15.0.16',
    targetRepo: 'indigoai-us/hq-core',
    targetRef: 'v15.0.17',
  },
  unchangedCount: 842,
  userOnlyCount: 17,
  scannedAt: '2026-08-12T12:00:00.000Z',
};

export const CHAT_CORE_NO_DRIFT_STATE = {
  ...CHAT_CORE_DRIFT_STATE,
  versionBehind: false,
  targetVersion: '15.0.16',
  driftReport: {
    ...CHAT_CORE_DRIFT_STATE.driftReport,
    count: 0,
    modified: [],
    missing: [],
    added: [],
    hqVersion: '15.0.16',
  },
};

export const CHAT_APP_UPDATE = {
  version: '0.10.107-beta.1',
  body: 'Chat shell parity and harness sweep.',
  date: '2026-08-12',
} as const;

// ── Screen / scenario catalog (harness query params) ─────────────────────────

/**
 * Sub-states selectable via `?view=chat&screen=…` and/or `?scenario=…`.
 * Documented for the e2e sweep and human preview.
 */
export const CHAT_HARNESS_SCREENS = [
  'sidebar',
  'channel',
  'composer',
  'board',
  'files',
  'dm',
  'group-dm',
  'notifications',
  'palette',
  'filter',
  'scope',
  'core',
  'meetings',
  'library',
] as const;

export type ChatHarnessScreen = (typeof CHAT_HARNESS_SCREENS)[number];

export const CHAT_HARNESS_SCENARIOS = [
  'default',
  'composer-states',
  'acl-denied',
  'core-conflicts',
  'core-empty',
  'drift',
  'no-drift',
  'update-available',
  'paused',
  'conflict',
  'sync-error',
] as const;

export type ChatHarnessScenario = (typeof CHAT_HARNESS_SCENARIOS)[number];

/** Map screen → desktop_alt pending route (null = stay on default / messages). */
export function chatScreenToPendingRoute(screen: string | null): string | null {
  switch (screen) {
    case 'notifications':
      return 'notifications';
    case 'meetings':
      return 'meetings';
    case 'library':
      return 'library';
    case 'home':
      return 'home';
    case 'dm':
    case 'group-dm':
    case 'channel':
    case 'board':
    case 'files':
    case 'composer':
    case 'sidebar':
    case 'palette':
    case 'filter':
    case 'scope':
    case 'core':
    case null:
    case '':
    case 'chat':
      return 'messages';
    default:
      return null;
  }
}

/** Default channel / person to open for a given screen. */
export function chatScreenOpenTarget(screen: string | null): {
  channelId?: string;
  personUid?: string;
} {
  switch (screen) {
    case 'group-dm':
      return { channelId: CHAT_GROUP_DM_ID };
    case 'dm':
      return { personUid: 'prs_ada' };
    case 'board':
    case 'files':
    case 'channel':
    case 'composer':
    default:
      return { channelId: CHAT_PROJECT_CHANNEL_ID };
  }
}

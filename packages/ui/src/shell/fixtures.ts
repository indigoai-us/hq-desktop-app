/**
 * Shared zero-network display fixtures for the V2 shell (design source:
 * hq-sync desktop-alt / ?view=v2). Web and desktop both inject these so the
 * same packages/ui chrome paints without a live backend.
 *
 * Wiring real data is a later step — this only exists so the shell paints the
 * channel rail (PINNED / TODAY / YESTERDAY), the selected channel, and the
 * composer offline. Not used on the authenticated data path.
 */

import type {
  ChannelDirectoryFeed,
  ChannelDirectoryRow,
} from "../chat/channel-directory-reconciler.js";
import type {
  ChannelStatusModel,
  StatusMemberInput,
} from "../chat/channel-status-model.js";
import { buildChannelStatusModel } from "../chat/channel-status-model.js";
import type {
  ChannelDetailResponse,
  ChatSidebarApi,
  ContactsResponse,
  ConversationApi,
  ConversationMessageWire,
  DmThreadResponse,
  NotificationsApi,
  RequestsResponse,
} from "../chat/chat-api.js";
import type {
  BoardTabData,
  ChannelFileItemModel,
} from "../chat/messaging/channelTabModels.js";
import type { ReactionMap } from "../chat/messaging/reactions.js";
import type { ConversationRow, DmContactInput } from "../chat/sidebar-model.js";
import type { Workspace } from "../chat/workspaces.js";

const DAY = 86_400_000;
const now = Date.now();
const today = (h = 9) =>
  new Date(new Date().setHours(h, 12, 0, 0)).toISOString();
const yesterday = (h = 16) =>
  new Date(new Date(now - DAY).setHours(h, 30, 0, 0)).toISOString();

/** localStorage keys the sidebar reads for pins / cache (kept in sync here). */
const PINS_KEY = "hq.chat.pins";

/** Pinned channel conversation ids (row id = `ch:<channelId>`). */
export const FIXTURE_PINS: string[] = [
  "ch:hq-desktop",
  "ch:hq-sync",
  "ch:creative-pipeline",
  "ch:book-tracker",
];

/**
 * Seed the pins the sidebar reads from localStorage so the PINNED group renders.
 * Call from the page's top-level (browser) script BEFORE the sidebar mounts.
 */
export function seedFixturePins(): void {
  if (typeof window === "undefined") return;
  try {
    if (!window.localStorage.getItem(PINS_KEY)) {
      window.localStorage.setItem(PINS_KEY, JSON.stringify(FIXTURE_PINS));
    }
  } catch {
    /* private mode — best effort */
  }
}

const CHANNEL_ROWS: ChannelDirectoryRow[] = [
  // PINNED (pinned via localStorage) — most recent activity.
  row("hq-desktop", "hq-desktop", "project", "Indigo", today(9), 0, 6),
  row("hq-sync", "hq-sync", "project", "Indigo", today(9), 2, 5),
  row(
    "creative-pipeline",
    "creative-pipeline",
    "project",
    "Indigo",
    today(8),
    0,
    4,
  ),
  row("book-tracker", "book-tracker", "project", "Personal", today(8), 0, 2),
  // TODAY.
  row(
    "agent-orchestrator",
    "agent-orchestrator",
    "project",
    "Indigo",
    today(10),
    3,
    // Reconciled with the injected status roster (5 members + 2 agents) so the
    // header member pill matches the rows the popover renders.
    7,
  ),
  row("gtm-standup", "gtm-standup", "company", "Indigo", today(9), 0, 12),
  row("ramen-bae", "ramen-bae", "project", "Indigo", today(8), 1, 4),
  row("ads-radar", "ads-radar", "project", "Indigo", today(7), 0, 3),
  row("reminders", "reminders", "personal", null, today(7), 0, 1),
  // YESTERDAY.
  row(
    "design-review",
    "design-review",
    "project",
    "Indigo",
    yesterday(16),
    0,
    5,
  ),
  row("finance", "finance", "company", "Indigo", yesterday(14), 0, 9),
];

function row(
  channelId: string,
  name: string,
  scope: string,
  companyUid: string | null,
  lastActivityAt: string,
  unreadCount: number,
  memberCount: number,
): ChannelDirectoryRow {
  return {
    channelId,
    type: scope === "personal" ? "chat" : "project",
    scope,
    companyUid,
    name,
    subtitle: companyUid ? `${companyUid} · ${scope}` : scope,
    lastActivityAt,
    unreadCount,
    memberCount,
  };
}

/**
 * DM contacts → the sidebar's DM rows AND the filter popover's PEOPLE roster
 * (`distinctDmPeople` derives the person list from DM rows). Matches the
 * ?view=v2 prototype roster: Corey (you), Bryan, Sofia, Marcus, Priya, Kayla.
 * Each carries an activity timestamp so it renders as a real conversation row
 * (a bare directory entry would be filtered out — see `contactHasConversation`).
 */
const CONTACTS: DmContactInput[] = [
  {
    personUid: "person-corey",
    email: "corey@getindigo.ai",
    displayName: "Corey (you)",
    lastMessageAt: today(10),
    lastActivityAt: today(10),
  },
  {
    personUid: "person-bryan",
    email: "bryan@getindigo.ai",
    displayName: "Bryan",
    lastMessageAt: today(10),
    lastActivityAt: today(10),
    activityDot: true,
  },
  {
    personUid: "person-sofia",
    email: "sofia@getindigo.ai",
    displayName: "Sofia",
    lastMessageAt: today(9),
    lastActivityAt: today(9),
  },
  {
    personUid: "person-marcus",
    email: "marcus@getindigo.ai",
    displayName: "Marcus",
    lastMessageAt: yesterday(15),
    lastActivityAt: yesterday(15),
  },
  {
    personUid: "person-priya",
    email: "priya@getindigo.ai",
    displayName: "Priya",
    lastMessageAt: yesterday(13),
    lastActivityAt: yesterday(13),
  },
  {
    personUid: "person-kayla",
    email: "kayla@getindigo.ai",
    displayName: "Kayla",
    lastMessageAt: yesterday(11),
    lastActivityAt: yesterday(11),
  },
];

/**
 * Channel timelines (oldest → newest, as the display ChannelConversation
 * consumes them). These carry the REAL wire fields the messaging stack renders:
 * `systemEvent` run-cards for the Fleet Agent, `fromPersonUid` "agt_" so the
 * agent IdentityMark (✦) renders, and person/agent bubbles. INJECTED into the
 * shell — never fetched. Ported from the hq-sync dev-harness chat-fixtures.
 */
const TIMELINES: Record<string, ConversationMessageWire[]> = {
  "agent-orchestrator": [
    {
      eventId: "ao-1",
      fromDisplayName: "Stefan",
      body: "Kick off the nightly triage sweep when you get a sec.",
      createdAt: new Date(now - 52 * 60_000).toISOString(),
      direction: "out",
    },
    {
      eventId: "ao-run-started",
      fromPersonUid: "agt_fleet",
      fromEmail: "fleet@agents.getindigo.ai",
      fromDisplayName: "Fleet Agent",
      body: "",
      messageKind: "system",
      createdAt: new Date(now - 50 * 60_000).toISOString(),
      direction: "in",
      systemEvent: {
        v: 1,
        type: "run_started",
        title: "started the nightly triage sweep",
      },
    },
    {
      eventId: "ao-run-complete",
      fromPersonUid: "agt_fleet",
      fromEmail: "fleet@agents.getindigo.ai",
      fromDisplayName: "Fleet Agent",
      body: "Run complete",
      messageKind: "system",
      createdAt: new Date(now - 42 * 60_000).toISOString(),
      direction: "in",
      systemEvent: {
        v: 1,
        type: "run_complete",
        title: "Nightly triage sweep — complete",
        summary: "3 issues auto-closed, 1 needs review.",
        previewUrl: "https://example.invalid/preview/nightly-triage",
        diffUrl: "https://example.invalid/diff/nightly-triage",
      },
    },
    {
      eventId: "ao-2",
      fromDisplayName: "Stefan",
      body: "Nice. Bump the review one to me and re-run the sweep after the deploy.",
      createdAt: new Date(now - 30 * 60_000).toISOString(),
      direction: "out",
    },
    {
      eventId: "ao-3",
      fromPersonUid: "agt_fleet",
      fromDisplayName: "Fleet Agent",
      body: "Assigned. Re-run queued behind the current deploy.",
      createdAt: new Date(now - 28 * 60_000).toISOString(),
      direction: "in",
    },
  ],
  "hq-sync": [
    {
      eventId: "hs-1",
      fromDisplayName: "Bryan",
      body: "conflict versioning branch is green — merging after CI.",
      createdAt: new Date(now - 55 * 60_000).toISOString(),
      direction: "in",
    },
  ],
};

/** Reaction aggregates keyed by messageId (the Fleet Agent card got 👍/🎉). */
const REACTIONS: Record<string, ReactionMap> = {
  "agent-orchestrator": {
    "ao-run-complete": [
      { emoji: "👍", count: 2, reactedByMe: true },
      { emoji: "🎉", count: 1, reactedByMe: false },
    ],
  },
};

function channelIdOf(row: ConversationRow): string | null {
  return row.channelId ?? (row.kind === "channel" ? row.title : null);
}

/** Injected timeline resolver for the shell (synchronous, zero-network). */
export function fixtureMessagesFor(
  row: ConversationRow,
): ConversationMessageWire[] {
  const id = channelIdOf(row);
  if (!id) return [];
  return (
    TIMELINES[id] ?? [
      {
        eventId: `${id}-welcome`,
        fromDisplayName: "Indigo",
        body: `Welcome to #${id}.`,
        createdAt: new Date(now - 120 * 60_000).toISOString(),
        direction: "in",
      },
    ]
  );
}

/** Injected reaction resolver for the shell. */
export function fixtureReactionsFor(row: ConversationRow): ReactionMap {
  const id = channelIdOf(row);
  return (id && REACTIONS[id]) || {};
}

/**
 * Board fixture (columns + task-panel details) for the project Board tab.
 * To do / Doing / Waiting / Done columns with task cards, and a per-task
 * side-panel lookup. INJECTED into the shell (synchronous, zero-network);
 * never fetched.
 */
const BOARD_BY_CHANNEL: Record<string, BoardTabData> = {
  "agent-orchestrator": {
    columns: [
      {
        id: "queued",
        title: "To do",
        cards: [],
      },
      {
        id: "in_progress",
        title: "Doing",
        cards: [
          {
            storyId: "US-004",
            label: "Nightly triage sweep",
            statusLine: "AGENT RUNNING · 62%",
          },
          {
            storyId: "US-007",
            label: "Wire board fixtures",
            statusLine: "PR OPEN · CI GREEN",
          },
        ],
      },
      {
        id: "review",
        title: "Waiting",
        cards: [
          {
            storyId: "US-005",
            label: "Reaction reconcile",
            statusLine: "WAITING",
          },
        ],
      },
      {
        id: "done",
        title: "Done",
        cards: [
          {
            storyId: "US-001",
            label: "Channel rail groups",
            statusLine: "DONE",
          },
          {
            storyId: "US-002",
            label: "Titlebar chrome",
            statusLine: "DONE",
          },
        ],
      },
    ],
    stories: {
      "US-004": {
        id: "US-004",
        title: "Nightly triage sweep",
        statusBadge: "Doing",
        description:
          "Fleet Agent runs the nightly triage sweep, auto-closing stale issues and flagging anything that needs a human review.",
        fields: {
          status: "Doing",
          assignee: "Fleet Agent",
          project: "HQ Desktop",
          branch: "feat/v2-chat-shell",
        },
        acceptanceCriteria: [
          { text: "Sweep runs on the nightly cron", done: true },
          { text: "Stale issues auto-closed with a comment", done: true },
          { text: "Review-needed issues bumped to the owner", done: false },
        ],
        acCountLabel: "2 / 3",
        activity: [
          { id: "a1", at: "10:04", text: "Fleet Agent started the sweep" },
          { id: "a2", at: "10:42", text: "3 issues auto-closed, 1 flagged" },
        ],
      },
      "US-007": {
        id: "US-007",
        title: "Wire board fixtures",
        statusBadge: "Doing",
        description:
          "Drive the channel Board tab from authored fixtures so it paints offline with zero network.",
        fields: {
          status: "Doing",
          assignee: "Corey",
          project: "HQ Desktop",
          branch: "feat/v2-chat-shell",
        },
        acceptanceCriteria: [
          { text: "Columns render from fixture data", done: true },
          { text: "Story panel opens from a card", done: true },
        ],
        acCountLabel: "2 / 2",
        activity: [{ id: "a1", at: "09:12", text: "CI is green" }],
      },
      "US-005": {
        id: "US-005",
        title: "Reaction reconcile",
        statusBadge: "Waiting",
        description:
          "Reconcile optimistic reaction toggles against the server aggregate on the next wake.",
        fields: {
          status: "Waiting",
          assignee: "Bryan",
          project: "HQ Desktop",
          branch: "feat/reaction-reconcile",
        },
        acceptanceCriteria: [
          { text: "Optimistic toggle renders immediately", done: true },
          { text: "Server aggregate wins on reconcile", done: true },
          { text: "No flicker on double-toggle", done: false },
        ],
        acCountLabel: "2 / 3",
        activity: [{ id: "a1", at: "08:50", text: "PR opened for review" }],
      },
      "US-001": {
        id: "US-001",
        title: "Channel rail groups",
        statusBadge: "Done",
        description: "PINNED / TODAY / YESTERDAY groups in the channel rail.",
        fields: {
          status: "Done",
          assignee: "Corey",
          project: "HQ Desktop",
          branch: "feat/v2-chat-shell",
        },
        acceptanceCriteria: [
          { text: "Groups render and collapse", done: true },
        ],
        acCountLabel: "1 / 1",
        activity: [{ id: "a1", at: "Aug 14", text: "Merged to main" }],
      },
      "US-002": {
        id: "US-002",
        title: "Titlebar chrome",
        statusBadge: "Done",
        description: "HQ wordmark, DAY·DATE, meetings / notifications / Core.",
        fields: {
          status: "Done",
          assignee: "Corey",
          project: "HQ Desktop",
          branch: "feat/v2-chat-shell",
        },
        acceptanceCriteria: [
          { text: "Titlebar paints in both themes", done: true },
        ],
        acCountLabel: "1 / 1",
        activity: [{ id: "a1", at: "Aug 13", text: "Merged to main" }],
      },
    },
  },
};

/** Files fixture rows for the project Files tab (ported shape). */
const FILES_BY_CHANNEL: Record<string, ChannelFileItemModel[]> = {
  "agent-orchestrator": [
    {
      key: "f-01",
      vaultPath: "companies/indigo/projects/hq/prd.json",
      name: "prd.json",
      caption: "ADA · AUG 15",
      iconKind: "file",
      previewText:
        '{\n  "project": "HQ Desktop",\n  "branch": "feat/v2-chat-shell",\n  "stories": ["US-001", "US-002", "US-004"]\n}',
    },
    {
      key: "f-02",
      vaultPath: "companies/indigo/projects/hq/README.md",
      name: "README.md",
      caption: "MARCUS · AUG 14",
      iconKind: "markdown",
      previewText:
        "# HQ Desktop\n\nThe V2 sidebar-first windowed shell. Chat, Board, and Files\ntabs render from authored fixtures with zero network.",
    },
    {
      key: "f-03",
      vaultPath: "companies/indigo/projects/hq/triage-sweep.md",
      name: "triage-sweep.md",
      caption: "FLEET AGENT · AUG 15",
      iconKind: "markdown",
      previewText:
        "# Nightly triage sweep\n\n- 3 issues auto-closed\n- 1 flagged for review\n- Re-run queued behind the current deploy",
    },
    {
      key: "f-04",
      vaultPath: "companies/indigo/projects/hq/hero.png",
      name: "hero.png",
      caption: "DESIGN BOT · AUG 13",
      iconKind: "image",
      previewText: "[image preview]",
    },
    {
      key: "f-05",
      vaultPath: "companies/indigo/projects/hq/spec.pdf",
      name: "spec.pdf",
      caption: "COREY · AUG 12",
      iconKind: "pdf",
      previewText: "[PDF preview]",
    },
    {
      key: "f-06",
      vaultPath: "companies/indigo/projects/hq/notes.txt",
      name: "notes.txt",
      caption: "ADA · AUG 11",
      iconKind: "text",
      previewText:
        "Follow-ups:\n- confirm member pill count\n- verify day divider on multi-day threads",
    },
    {
      key: "f-07",
      vaultPath: "companies/indigo/projects/hq/secrets.env",
      name: "secrets.env",
      caption: "COREY · AUG 10",
      iconKind: "file",
      accessDenied: true,
    },
  ],
};

/** Injected Board resolver for the shell (synchronous, zero-network). */
export function fixtureBoardFor(row: ConversationRow): BoardTabData | null {
  const id = channelIdOf(row);
  return (id && BOARD_BY_CHANNEL[id]) || null;
}

/** Injected Files resolver for the shell (synchronous, zero-network). */
export function fixtureFilesFor(row: ConversationRow): ChannelFileItemModel[] {
  const id = channelIdOf(row);
  return (id && FILES_BY_CHANNEL[id]) || [];
}

function messagesFor(channelId: string): ChannelDetailResponse["messages"] {
  return [...(TIMELINES[channelId] ?? [])].reverse();
}

export function createFixtureChatSidebarApi(): ChatSidebarApi {
  return {
    fetchChannelDirectory: async (): Promise<ChannelDirectoryFeed> => ({
      contractVersion: 2,
      snapshot: true,
      cursor: "fixturecursor00000000000000000000000000",
      cursorExpiresAt: new Date(now + 30 * DAY).toISOString(),
      rows: CHANNEL_ROWS,
    }),
    listContacts: async (): Promise<ContactsResponse> => ({
      contacts: CONTACTS,
    }),
    listDmRequests: async (): Promise<RequestsResponse> => ({ requests: [] }),
    listChannels: async () => ({ channels: [] }),
    markDmThreadRead: async () => {},
    markChannelRead: async () => {},
    searchMessages: async () => ({ results: [] }),
  };
}

export function createFixtureConversationApi(): ConversationApi {
  return {
    fetchChannel: async ({ channelId }): Promise<ChannelDetailResponse> => ({
      messages: messagesFor(channelId),
      nextCursor: null,
    }),
    sendChannelMessage: async () => {},
    fetchDmThread: async (): Promise<DmThreadResponse> => ({
      messages: [],
      nextCursor: null,
    }),
    sendDm: async () => {},
    fetchReplyThread: async () => ({
      scope: "channel" as const,
      root: null,
      replies: [],
      replyCount: 0,
    }),
    sendReply: async () => {},
  };
}

/** Local time at `dayOffset` days from now, `h:m` — stable clock labels. */
function clock(dayOffset: number, h: number, m: number): string {
  const d = new Date(now + dayOffset * DAY);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

interface FixtureNotification {
  id: string;
  type: string;
  status: "unread" | "read";
  createdAt: string;
  actorName: string;
  title: string;
  context: string;
}

/**
 * Authored notification feed matching the ?view=v2 prototype: TODAY / YESTERDAY
 * day groups, with 2 unread. The bold primary line is `{actor} {verb}` (the verb
 * comes from the notification type in notifications-model), and `context` is the
 * subtitle. INJECTED (zero network); ack / mark-all-read mutate this in place so
 * a re-fetch on filter toggle stays consistent.
 */
const FIXTURE_NOTIFICATIONS: FixtureNotification[] = [
  // TODAY.
  {
    id: "notif-sofia-share",
    type: "file_share",
    status: "unread",
    createdAt: clock(0, 10, 2),
    actorName: "Sofia",
    title: "Shared a file",
    context: "library-ia-v2.md · Indigo · Files",
  },
  {
    id: "notif-build-review",
    type: "agent_review_request",
    status: "unread",
    createdAt: clock(0, 9, 48),
    actorName: "Build Agent",
    title: "Needs your review on US-010",
    context: "enterprise-pricing · PR open, CI green",
  },
  {
    id: "notif-desktop-finished",
    type: "agent_finished_story",
    status: "read",
    createdAt: clock(0, 9, 31),
    actorName: "Desktop Agent",
    title: "Finished US-004",
    context: "day-group collapse · 12 tests added, preview deployed",
  },
  {
    id: "notif-bryan-dm",
    type: "dm",
    status: "read",
    createdAt: clock(0, 9, 13),
    actorName: "Bryan",
    title: "Sent you a message",
    context: "Demo with the Nestlé team moved to Thursday",
  },
  {
    id: "notif-bryan-mention",
    type: "mention",
    status: "read",
    createdAt: clock(0, 9, 12),
    actorName: "Bryan",
    title: "Mentioned you",
    context: "#hq-desktop",
  },
  // YESTERDAY.
  {
    id: "notif-fleet-flag",
    type: "security_alert",
    status: "read",
    createdAt: clock(-1, 16, 12),
    actorName: "Fleet Agent",
    title: "Flagged 1 box for storage autoscale",
    context: "agent-orchestrator · nightly triage",
  },
  {
    id: "notif-marcus-mention",
    type: "mention",
    status: "read",
    createdAt: clock(-1, 14, 20),
    actorName: "Marcus",
    title: "Mentioned you in #standup-brief",
    context: "Linking the library IA doc…",
  },
];

export function createFixtureNotificationsApi(): NotificationsApi {
  // Mutable copy so ack / mark-all-read persist across re-fetches (filter toggle).
  const feed: FixtureNotification[] = FIXTURE_NOTIFICATIONS.map((n) => ({
    ...n,
  }));
  const unread = () => feed.filter((n) => n.status === "unread").length;
  return {
    fetchNotifications: async (opts) => {
      const rows = opts?.unreadOnly
        ? feed.filter((n) => n.status === "unread")
        : feed;
      return {
        notifications: rows.map((n) => ({ ...n })),
        unreadCount: unread(),
        nextCursor: null,
      };
    },
    ackNotification: async (id: string) => {
      const row = feed.find((n) => n.id === id);
      if (row) row.status = "read";
    },
    readAllNotifications: async () => {
      for (const n of feed) n.status = "read";
    },
    runNotificationAction: async () => ({}),
  };
}

/** Workspace memberships → sidebar scope options. */
export const FIXTURE_COMPANIES: Workspace[] = [
  {
    slug: "indigo",
    displayName: "Indigo",
    kind: "company",
    state: "synced",
    role: "owner",
    cloudUid: "Indigo",
  } as Workspace,
  {
    slug: "personal",
    displayName: "Personal",
    kind: "personal",
    state: "personal",
    role: null,
  } as Workspace,
];

/**
 * Search-overlay rows (⌘K / sidebar search icon) — every fixture channel + DM
 * person as a ConversationRow so the command palette typeaheads over
 * channels/people and ranks by recency. Zero-network: static, injected.
 */
export const FIXTURE_SEARCH_ROWS: ConversationRow[] = [
  ...CHANNEL_ROWS.map((c): ConversationRow => ({
    id: `ch:${c.channelId}`,
    kind: "channel",
    title: c.name,
    companyUid: c.companyUid ?? null,
    unreadDot: false,
    lastActivityAt: Date.parse(c.lastActivityAt ?? "") || 0,
    pinned: FIXTURE_PINS.includes(`ch:${c.channelId}`),
    memberCount: c.memberCount,
    channelId: c.channelId,
    channelScope: c.scope,
  })),
  ...CONTACTS.map((p): ConversationRow => ({
    id: `dm:${p.personUid}`,
    kind: "dm",
    title: p.displayName ?? p.email ?? p.personUid,
    companyUid: null,
    unreadDot: false,
    lastActivityAt: Date.parse(p.lastActivityAt ?? p.lastMessageAt ?? "") || 0,
    pinned: false,
    personUid: p.personUid,
    email: p.email ?? null,
  })),
];

/**
 * Members/status popover model for the channel-header member pill (US-005).
 * Built from the pure `buildChannelStatusModel` with injected fixture members,
 * PRD metadata, and story rollup, then a live agent row layered on — matching
 * the ?view=v2 prototype (running agent · US-002 · 62%, 7/12 stories, project
 * branch/repo/preview, member + agent rosters). Zero-network.
 */
const CHANNEL_STATUS_MEMBERS: StatusMemberInput[] = [
  { personUid: "person-corey", displayName: "Corey", role: "owner" },
  { personUid: "person-bryan", displayName: "Bryan", role: "member" },
  { personUid: "person-sofia", displayName: "Sofia", role: "member" },
  { personUid: "person-marcus", displayName: "Marcus", role: "member" },
  { personUid: "person-priya", displayName: "Priya", role: "member" },
  {
    personUid: "agt_desktop",
    displayName: "Desktop Agent",
    role: "agent",
    isAgent: true,
  },
  {
    personUid: "agt_build",
    displayName: "Build Agent",
    role: "agent",
    isAgent: true,
  },
];

const CHANNEL_STATUS_MODEL: ChannelStatusModel = {
  ...buildChannelStatusModel({
    project: {
      id: "agent-orchestrator",
      title: "agent-orchestrator",
      company: "Indigo",
      storiesTotal: 12,
      storiesComplete: 7,
    },
    prd: {
      name: "HQ Desktop",
      branchName: "feat/unified-shell",
      repoPath: "hq-desktop",
      previewUrl: "https://hq-desktop-preview.indigo.dev",
    },
    members: CHANNEL_STATUS_MEMBERS,
    companyLabel: "Indigo",
  }),
  // Layer the running-agent row on top of the roster model.
  liveAgents: [
    {
      id: "agent-desktop-run",
      label: "Agent running · US-002 · 62%",
      storyId: "US-002",
      progressPercent: 62,
      status: "running",
      tool: "Desktop Agent",
      displayName: "Desktop Agent",
    },
  ],
};

/** Injected channel-status resolver for the shell (synchronous, zero-network). */
export function fixtureChannelStatusFor(
  row: ConversationRow,
): ChannelStatusModel | null {
  return row.kind === "channel" ? CHANNEL_STATUS_MODEL : null;
}

/**
 * Injected fixture profile for the full-window Settings destination — matches
 * the ?view=v2 prototype Profile pane. Zero-network (no identity fetch).
 */
export const FIXTURE_SETTINGS_PROFILE = {
  initial: "C",
  fullName: "Corey Epstein",
  displayName: "Corey",
  email: "corey@getindigo.ai",
  verified: true,
};

/** The channel the shell opens on by default (matches the design screenshot). */
export const FIXTURE_INITIAL_ROW: ConversationRow = {
  id: "ch:agent-orchestrator",
  kind: "channel",
  title: "agent-orchestrator",
  companyUid: "Indigo",
  unreadDot: false,
  lastActivityAt: Date.parse(today(10)),
  pinned: false,
  // Matches the status roster length (5 members + 2 agents) so the header pill
  // count equals the rendered popover rows.
  memberCount: 7,
  channelId: "agent-orchestrator",
  channelScope: "project",
};

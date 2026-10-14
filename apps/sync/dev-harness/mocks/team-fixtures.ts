/**
 * A busy Indigo workspace for the default design-harness shell
 * (`?view=shell` with no persona).
 *
 * One roster feeds every surface that lists people: contacts, channel
 * members, company members, the Team page, the bots roster, mentions and
 * notifications. Channel and DM histories are written as short scripts and
 * stamped relative to "now", so the Today / Yesterday / earlier day groups
 * stay right whatever day the harness is opened.
 *
 * Design-only data. Nothing here reaches the app bundle.
 */

export const INDIGO_UID = 'cmp_indigo';
export const INDIGO_NAME = 'Indigo';
/** The signed-in harness user. */
export const SELF_UID = 'prs_ada';

export type TeamRole = 'owner' | 'admin' | 'member';

export interface TeamPerson {
  key: string;
  personUid: string;
  displayName: string;
  email: string;
  role: TeamRole;
  title: string;
  joinedAt: string;
}

export interface TeamBot {
  key: string;
  agentUid: string;
  /** Handle, as `hq bot create` names it. */
  name: string;
  displayName: string;
  ownerKey: string;
  description: string;
  runtime: 'claude' | 'codex';
  createdAt: string;
}

export const TEAM_PEOPLE: TeamPerson[] = [
  { key: 'ada', personUid: 'prs_ada', displayName: 'Ada Lovelace', email: 'ada@getindigo.ai', role: 'owner', title: 'Product engineering', joinedAt: '2026-01-12T16:00:00.000Z' },
  { key: 'corey', personUid: 'prs_corey', displayName: 'Corey Epstein', email: 'corey@getindigo.ai', role: 'owner', title: 'CEO', joinedAt: '2026-01-05T16:00:00.000Z' },
  { key: 'grace', personUid: 'prs_grace', displayName: 'Grace Hopper', email: 'grace@getindigo.ai', role: 'admin', title: 'Platform lead', joinedAt: '2026-01-19T16:00:00.000Z' },
  { key: 'stefan', personUid: 'prs_stefan', displayName: 'Stefan Johnson', email: 'stefan@getindigo.ai', role: 'admin', title: 'Head of engineering', joinedAt: '2026-02-02T16:00:00.000Z' },
  { key: 'jacob', personUid: 'prs_jacob', displayName: 'Jacob Moore', email: 'jacob@getindigo.ai', role: 'member', title: 'Growth', joinedAt: '2026-02-16T16:00:00.000Z' },
  { key: 'hassaan', personUid: 'prs_hassaan', displayName: 'Hassaan Ali', email: 'hassaan@getindigo.ai', role: 'member', title: 'Backend engineer', joinedAt: '2026-03-02T16:00:00.000Z' },
  { key: 'lizzie', personUid: 'prs_lizzie', displayName: 'Lizzie Liu', email: 'lizzie@getindigo.ai', role: 'member', title: 'Product designer', joinedAt: '2026-03-09T16:00:00.000Z' },
  { key: 'maya', personUid: 'prs_maya', displayName: 'Maya Chen', email: 'maya@getindigo.ai', role: 'member', title: 'Product manager', joinedAt: '2026-03-23T16:00:00.000Z' },
  { key: 'priya', personUid: 'prs_priya', displayName: 'Priya Natarajan', email: 'priya@getindigo.ai', role: 'member', title: 'QA and data', joinedAt: '2026-04-13T16:00:00.000Z' },
  { key: 'leo', personUid: 'prs_leo', displayName: 'Leo Park', email: 'leo@getindigo.ai', role: 'member', title: 'Frontend engineer', joinedAt: '2026-05-04T16:00:00.000Z' },
  { key: 'katherine', personUid: 'prs_katherine', displayName: 'Katherine Johnson', email: 'katherine@getindigo.ai', role: 'member', title: 'Customer success', joinedAt: '2026-06-01T16:00:00.000Z' },
];

export const TEAM_BOTS: TeamBot[] = [
  { key: 'deacon', agentUid: 'agt_deacon', name: 'deacon', displayName: 'Deacon', ownerKey: 'stefan', description: 'Cuts releases, watches deploys and posts the changelog.', runtime: 'claude', createdAt: '2026-04-20T16:00:00.000Z' },
  { key: 'atlas', agentUid: 'agt_atlas', name: 'atlas', displayName: 'Atlas', ownerKey: 'corey', description: 'Research and company knowledge. Answers "where is…" questions.', runtime: 'claude', createdAt: '2026-05-11T16:00:00.000Z' },
  { key: 'scout', agentUid: 'agt_scout', name: 'scout', displayName: 'Scout', ownerKey: 'priya', description: 'Triages bug reports and runs the nightly QA pass.', runtime: 'codex', createdAt: '2026-06-08T16:00:00.000Z' },
  { key: 'ranger', agentUid: 'agt_ranger', name: 'ranger', displayName: 'Ranger', ownerKey: 'grace', description: 'Keeps sync healthy and files the weekly reliability report.', runtime: 'claude', createdAt: '2026-07-06T16:00:00.000Z' },
];

const PEOPLE_BY_KEY = new Map(TEAM_PEOPLE.map((p) => [p.key, p]));
const BOTS_BY_KEY = new Map(TEAM_BOTS.map((b) => [b.key, b]));

interface Actor {
  uid: string;
  name: string;
  email: string | null;
  isBot: boolean;
}

function actor(key: string): Actor {
  const person = PEOPLE_BY_KEY.get(key);
  if (person) return { uid: person.personUid, name: person.displayName, email: person.email, isBot: false };
  const bot = BOTS_BY_KEY.get(key);
  if (bot) return { uid: bot.agentUid, name: bot.displayName, email: null, isBot: true };
  throw new Error(`team-fixtures: unknown actor ${key}`);
}

export function botOwner(bot: TeamBot): TeamPerson {
  return PEOPLE_BY_KEY.get(bot.ownerKey)!;
}

// ---------------------------------------------------------------------------
// Time: "25m" / "3h" ago, or "2d 14:05" = 14:05 local, two days back.
//
// Every stamp is taken against one clock fixed when the page loads. A clock
// read per request would move "25m ago" forward on every poll, and the DM
// inbox would then report the same message as new again and again.
// ---------------------------------------------------------------------------

export const HARNESS_NOW = Date.now();

export function stamp(spec: string, now = HARNESS_NOW): string {
  const rel = /^(\d+)([mh])$/.exec(spec);
  if (rel) {
    const n = Number(rel[1]);
    return new Date(now - n * (rel[2] === 'h' ? 3_600_000 : 60_000)).toISOString();
  }
  const day = /^(\d+)d (\d{1,2}):(\d{2})$/.exec(spec);
  if (day) {
    const date = new Date(now);
    date.setDate(date.getDate() - Number(day[1]));
    date.setHours(Number(day[2]), Number(day[3]), 0, 0);
    return date.toISOString();
  }
  throw new Error(`team-fixtures: bad time ${spec}`);
}

// ---------------------------------------------------------------------------
// Message scripts
// ---------------------------------------------------------------------------

type Reaction = [emoji: string, count: number, mine?: boolean];

interface Extra {
  /** Root this row replies to (same script). */
  re?: string;
  reactions?: Reaction[];
  mentions?: string[];
  files?: Array<{ path: string; size: number; type?: string }>;
  system?: Record<string, unknown>;
}

/** [id, when, actorKey, body, extra?] — written oldest first. */
type Line = [id: string, when: string, from: string, body: string, extra?: Extra];

export interface WireMessage {
  eventId: string;
  fromPersonUid: string;
  fromDisplayName: string;
  fromEmail: string | null;
  body: string;
  createdAt: string;
  direction: 'in' | 'out';
  messageKind?: string;
  systemEvent?: Record<string, unknown>;
  rootEventId?: string;
  replyCount?: number;
  reactions?: Array<{ emoji: string; count: number; reactedByMe: boolean }>;
  mentions?: Array<{ participantUid: string; participantType: string; displayName: string }>;
  attachments?: Array<Record<string, unknown>>;
}

function fileName(path: string): string {
  return path.split('/').pop() ?? path;
}

function contentTypeFor(name: string): string {
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (name.endsWith('.md')) return 'text/markdown';
  if (name.endsWith('.csv')) return 'text/csv';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.json')) return 'application/json';
  return 'application/octet-stream';
}

function buildMessages(prefix: string, lines: Line[], now: number): WireMessage[] {
  const replyCounts = new Map<string, number>();
  for (const [, , , , extra] of lines) {
    if (extra?.re) replyCounts.set(extra.re, (replyCounts.get(extra.re) ?? 0) + 1);
  }
  const out = lines.map(([id, when, from, body, extra]): WireMessage => {
    const who = actor(from);
    const eventId = `${prefix}-${id}`;
    const message: WireMessage = {
      eventId,
      fromPersonUid: who.uid,
      fromDisplayName: who.name,
      fromEmail: who.email,
      body,
      createdAt: stamp(when, now),
      direction: who.uid === SELF_UID ? 'out' : 'in',
    };
    if (extra?.re) message.rootEventId = `${prefix}-${extra.re}`;
    const replies = replyCounts.get(id);
    if (replies) message.replyCount = replies;
    if (extra?.reactions) {
      message.reactions = extra.reactions.map(([emoji, count, mine]) => ({ emoji, count, reactedByMe: mine === true }));
    }
    if (extra?.mentions) {
      message.mentions = extra.mentions.map((key) => {
        const target = actor(key);
        return { participantUid: target.uid, participantType: target.isBot ? 'agent' : 'human', displayName: target.name };
      });
    }
    if (extra?.files) {
      message.attachments = extra.files.map((file) => {
        const name = fileName(file.path);
        const contentType = file.type ?? contentTypeFor(name);
        return {
          id: `${eventId}-${name}`,
          vaultPath: file.path,
          companyUid: INDIGO_UID,
          name,
          contentType,
          sizeBytes: file.size,
          kind: contentType.startsWith('image/') ? 'image' : 'file',
        };
      });
    }
    if (extra?.system) {
      message.messageKind = 'system';
      message.systemEvent = { v: 1, ...extra.system };
    }
    return message;
  });
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

interface ChannelScript {
  channelId: string;
  name: string;
  scope: 'company' | 'project' | 'group';
  projectId?: string;
  subtitle?: string;
  unread: number;
  mention?: boolean;
  /** Member keys; omitted = the whole company. */
  members?: string[];
  lines: Line[];
}

const ALL_PEOPLE = TEAM_PEOPLE.map((p) => p.key);

const CHANNEL_SCRIPTS: ChannelScript[] = [
  {
    channelId: 'chn_indigo_general',
    name: 'general',
    scope: 'company',
    subtitle: 'Company-wide news and questions',
    unread: 3,
    members: [...ALL_PEOPLE, 'atlas', 'deacon'],
    lines: [
      ['g1', '6d 09:12', 'corey', 'Morning all. Board update went out last night, thanks for the numbers on short notice.', { reactions: [['🙌', 5]] }],
      ['g2', '6d 09:40', 'katherine', 'Northwind renewed for another year. They want the meeting notes feature on their whole ops team.', { reactions: [['🎉', 7, true], ['💸', 2]] }],
      ['g3', '6d 10:02', 'jacob', 'Huge. Can I quote them on the site?'],
      ['g4', '6d 10:05', 'katherine', 'Asking their COO today.'],
      ['g5', '5d 11:30', 'maya', 'Reminder: Q4 planning doc is open for comments until Monday.', { files: [{ path: 'companies/indigo/planning/q4-2026-plan.md', size: 18_240 }] }],
      ['g6', '5d 15:48', 'atlas', 'Weekly digest: 41 PRs merged, 6 releases, 3 new customer pilots. Full digest is in the vault.', { files: [{ path: 'companies/indigo/reports/weekly-digest-2026-10-02.md', size: 9_812 }] }],
      ['g7', '2d 09:05', 'corey', 'Welcome @Leo Park to the frontend crew officially. He has been shipping since day two.', { mentions: ['leo'], reactions: [['👋', 9], ['🔥', 3]] }],
      ['g8', '2d 09:20', 'leo', 'Thanks everyone. Still finding my way around the vault, so be patient with me.'],
      ['g9', '2d 13:15', 'grace', 'Heads up: sync will be read-only for about 10 minutes at 6pm PT for the bucket migration.'],
      ['g10', '2d 13:22', 'hassaan', 'I will be on call for it.', { re: 'g9' }],
      ['g11', '2d 18:31', 'grace', 'Migration done. No conflicts, nothing lost.', { re: 'g9', reactions: [['✅', 6]] }],
      ['g12', '1d 08:55', 'stefan', 'All-hands moved to Thursday 11am. Same link.'],
      ['g13', '1d 10:10', 'priya', 'Who owns the Brightline pilot account? Their admin cannot invite people.'],
      ['g14', '1d 10:14', 'katherine', 'Me. Looking now.', { re: 'g13' }],
      ['g15', '1d 10:41', 'katherine', 'Fixed. Their seat limit was still set to the trial plan.', { re: 'g13', reactions: [['🙏', 2]] }],
      ['g16', '1d 16:02', 'jacob', 'Webinar signups crossed 400. That is double last month.', { reactions: [['📈', 6], ['🎉', 4]] }],
      ['g17', '5h', 'corey', 'Customer call notes from Meridian are in the vault. Short version: they love Home, they want Slack import.', { files: [{ path: 'companies/indigo/meetings/2026-10-07-meridian.md', size: 6_410 }] }],
      ['g18', '4h', 'maya', 'Slack import is on the Q4 list. I will bump it.', { re: 'g17' }],
      ['g19', '3h', 'lizzie', 'Lunch and learn tomorrow: how we design badges. Bring questions.', { reactions: [['🍜', 4], ['🏅', 3]] }],
      ['g20', '52m', 'ada', 'Anyone else seeing slow vault search this morning?'],
      ['g21', '41m', 'grace', 'Yes, index rebuild is running. Should be back to normal by noon.', { re: 'g20' }],
      ['g22', '25m', 'atlas', 'Reminder: expense reports for September are due Friday.'],
    ],
  },
  {
    channelId: 'chn_indigo_design',
    name: 'design',
    scope: 'company',
    subtitle: 'Design reviews, critiques and the system',
    unread: 5,
    mention: true,
    members: ['ada', 'corey', 'lizzie', 'maya', 'leo', 'grace', 'priya', 'atlas'],
    lines: [
      ['d1', '6d 10:30', 'lizzie', 'Kicking off accomplishment badges. Goal: show what people and bots have done, without turning HQ into a game.', { reactions: [['🏅', 4]] }],
      ['d2', '6d 10:44', 'maya', 'Love it. What is the first surface?'],
      ['d3', '6d 10:47', 'lizzie', 'Profile panes. Then maybe the Team page.', { re: 'd2' }],
      ['d4', '5d 14:05', 'lizzie', 'First pass at the badge sheet. Nine badges, three tiers each.', { files: [{ path: 'companies/indigo/design/badges/badge-sheet-v1.pdf', size: 2_418_220 }] }],
      ['d5', '5d 14:21', 'leo', 'Tier 3 marks read really well at 24px. Tier 1 gets muddy.', { re: 'd4' }],
      ['d6', '5d 14:30', 'corey', 'Can we lose the gradients? Everything else in the app is flat.', { re: 'd4' }],
      ['d7', '5d 14:52', 'lizzie', 'Yes. Going flat with a single accent per tier.', { re: 'd4', reactions: [['👍', 3]] }],
      ['d8', '5d 16:10', 'maya', 'Design review moved to Monday 2pm so Corey can join.'],
      ['d9', '2d 14:00', 'maya', 'Notes from today\'s review are in the vault. Decisions: flat marks, max six badges on a pane, earned date on hover.', { files: [{ path: 'companies/indigo/design/reviews/2026-10-05-badges.md', size: 4_120 }], reactions: [['📝', 2]] }],
      ['d10', '2d 14:12', 'leo', 'Six is the right number. More than that and the pane scrolls.'],
      ['d11', '2d 15:40', 'priya', 'Small thing: the tooltip on the Connector badge says "connecter".'],
      ['d12', '2d 15:43', 'lizzie', 'Good catch, fixing.', { re: 'd11' }],
      ['d13', '2d 17:05', 'grace', 'Can bots earn the same badges as people? Ranger would love Bug hunter.'],
      ['d14', '2d 17:20', 'lizzie', 'Bots get their own set: Liftoff, Power user, Closer, Ship it. People badges stay human.', { re: 'd13' }],
      ['d15', '2d 17:24', 'grace', 'Makes sense.', { re: 'd13' }],
      ['d16', '1d 09:30', 'lizzie', 'v3 is up. Flat, Geist Mono numerals, tier shown as a ring.', { files: [{ path: 'companies/indigo/design/badges/badge-sheet-v3.pdf', size: 1_906_544 }], reactions: [['😍', 5], ['🔥', 3, true]] }],
      ['d17', '1d 09:48', 'corey', 'This is it. Ship it to the profile pane.'],
      ['d18', '1d 10:15', 'ada', 'I will wire the profile pane this afternoon. Is there a spec for the empty state?'],
      ['d19', '1d 10:22', 'lizzie', 'Empty state is just the section header with "No badges yet". No illustration.', { re: 'd18' }],
      ['d20', '1d 13:02', 'maya', 'Separate topic: the new Home layout is getting good feedback from pilots.'],
      ['d21', '1d 13:10', 'katherine', 'Northwind said Home is the first screen they actually read.', { re: 'd20' }],
      ['d22', '1d 16:44', 'leo', 'Dark mode contrast on the channel header fails AA. Opening a ticket.'],
      ['d23', '1d 16:50', 'lizzie', 'Thanks. Use --text-secondary there, not --text-tertiary.', { re: 'd22' }],
      ['d24', '3h', 'atlas', 'Found three older badge explorations from April in the vault, in case they help.', { files: [{ path: 'companies/indigo/design/archive/badges-april.pdf', size: 3_210_004 }] }],
      ['d25', '2h', 'ada', 'Profile pane badges are in the harness. Every person and bot has sample badges now.', { reactions: [['🙌', 4]] }],
      ['d26', '96m', 'lizzie', 'Looks great. Can we get the earned date under each mark instead of in a tooltip?'],
      ['d27', '80m', 'ada', 'Sure, it fits at the current size.', { re: 'd26' }],
      ['d28', '35m', 'maya', 'Design crit at 3pm: badges on the Team page. @Lizzie Liu are you presenting?', { mentions: ['lizzie'] }],
      ['d29', '22m', 'lizzie', 'Yes. I will share the Figma link before.'],
      ['d30', '9m', 'leo', '@Ada Lovelace can you check the badge hover on Safari? It flickers for me.', { mentions: ['ada'] }],
    ],
  },
  {
    channelId: 'chn_indigo_eng',
    name: 'eng',
    scope: 'company',
    subtitle: 'Engineering chatter, PRs and incidents',
    unread: 8,
    members: ['ada', 'corey', 'grace', 'stefan', 'hassaan', 'leo', 'priya', 'lizzie', 'deacon', 'scout', 'ranger'],
    lines: [
      ['e1', '6d 09:30', 'stefan', 'Sprint goals: event-driven sync to 50% of companies, S3 version conflicts behind a flag, desktop crash rate under 0.2%.'],
      ['e2', '6d 11:15', 'hassaan', 'PR for the IoT push receiver is up. It is big, sorry.', { reactions: [['😅', 3]] }],
      ['e3', '6d 11:40', 'grace', 'I will take it. Split the retry policy out if you can.', { re: 'e2' }],
      ['e4', '6d 15:02', 'scout', 'Nightly QA: 412 passed, 3 failed. Two are the known flaky meeting tests, one is new: DM unread badge stays after mark-read.'],
      ['e5', '6d 15:30', 'priya', 'The DM unread one is real. I can reproduce it on 0.10.408.', { re: 'e4' }],
      ['e6', '5d 10:12', 'leo', 'Fixed the DM unread badge. It was clearing the dot but not the count.', { re: 'e4', reactions: [['🙏', 2]] }],
      ['e7', '5d 12:00', 'ranger', 'Weekly reliability: sync success 99.94%, p95 push latency 840ms, zero data loss incidents.', { reactions: [['💪', 5]] }],
      ['e8', '5d 16:20', 'stefan', 'Code freeze for 0.10.410 is Monday at noon.'],
      ['e9', '2d 09:45', 'hassaan', 'Event-driven sync is on for 30% of companies. Error rate flat.', { reactions: [['🚀', 6]] }],
      ['e10', '2d 10:30', 'grace', 'Nice. Let it bake for a day before 50%.'],
      ['e11', '2d 11:02', 'priya', 'Bug report from Brightline: files with emoji in the name do not sync. Repro attached.', { files: [{ path: 'companies/indigo/bugs/brightline-emoji-filenames.md', size: 2_904 }] }],
      ['e12', '2d 11:10', 'scout', 'Triaged: NFC vs NFD normalization on macOS. Likely in the path hashing. Assigned to Hassaan.', { re: 'e11' }],
      ['e13', '2d 13:40', 'hassaan', 'Confirmed. Fix is a one-liner, adding a regression test now.', { re: 'e11' }],
      ['e14', '2d 16:55', 'deacon', 'PR #1291 opened: Normalize vault paths to NFC before hashing (hassaan).', { system: { type: 'pr_opened', title: 'PR #1291 opened', summary: 'Normalize vault paths to NFC before hashing' } }],
      ['e15', '2d 16:56', 'deacon', 'Opened PR #1291 for the emoji filename fix. Waiting on review.'],
      ['e16', '1d 09:10', 'ada', 'Reviewing #1291 now.'],
      ['e17', '1d 09:34', 'ada', 'Approved. Nice test.', { re: 'e16' }],
      ['e18', '1d 11:00', 'stefan', 'Standup notes: Hassaan on conflicts, Leo on profile panes, Grace on push rollout, Ada on badges.'],
      ['e19', '1d 14:22', 'leo', 'Anyone know why vitest takes 40s to start in packages/ui?'],
      ['e20', '1d 14:30', 'grace', 'It is the svelte preprocess. Run with --pool=threads, it is twice as fast.', { re: 'e19' }],
      ['e21', '1d 14:31', 'leo', 'Ha, that worked. 18s now.', { re: 'e19', reactions: [['⚡', 3]] }],
      ['e22', '1d 17:45', 'scout', 'Run complete: nightly QA on 0.10.411-rc.1. 418 passed, 0 failed.', { system: { type: 'run_complete', title: 'Nightly QA · 0.10.411-rc.1', summary: '418 passed, 0 failed' } }],
      ['e23', '1d 17:46', 'scout', 'Nightly QA on 0.10.411-rc.1: 418 passed, 0 failed. First clean run this month.', { reactions: [['🎉', 7, true]] }],
      ['e24', '6h', 'hassaan', 'Event-driven sync at 50% now.'],
      ['e25', '5h', 'grace', 'Seeing a small bump in reconnects from one region. Watching it.', { re: 'e24' }],
      ['e26', '4h', 'ranger', 'Reconnect bump traced to one ISP in Frankfurt. Back to baseline.', { re: 'e24' }],
      ['e27', '3h', 'priya', 'Crash report spike on 0.10.411 from Intel Macs. 14 reports in the last hour.'],
      ['e28', '170m', 'stefan', 'On it. Pausing the rollout.', { re: 'e27' }],
      ['e29', '150m', 'ada', 'Found it: the badge renderer uses a font feature Intel GPUs reject. Patch in ten minutes.', { re: 'e27' }],
      ['e30', '110m', 'deacon', 'PR #1297 opened: Fall back to plain numerals on unsupported GPUs (ada).', { system: { type: 'pr_opened', title: 'PR #1297 opened', summary: 'Fall back to plain numerals on unsupported GPUs' } }],
      ['e31', '70m', 'stefan', 'Patch verified on my old Intel MacBook. Resuming rollout.', { re: 'e27', reactions: [['🙏', 4]] }],
      ['e32', '41m', 'hassaan', 'Can someone look at the conflict-versioning migration before I run it on staging? @Grace Hopper', { mentions: ['grace'] }],
    ],
  },
  {
    channelId: 'chn_indigo_releases',
    name: 'releases',
    scope: 'company',
    subtitle: 'Release notes, deploys and rollbacks',
    unread: 2,
    members: ['ada', 'corey', 'grace', 'stefan', 'hassaan', 'leo', 'priya', 'maya', 'deacon', 'scout'],
    lines: [
      ['r1', '6d 17:00', 'deacon', 'Desktop 0.10.408 is live for everyone. Highlights: faster channel switching, Meetings tab, fixed share links.', { reactions: [['🚢', 4]] }],
      ['r2', '6d 17:01', 'deacon', 'Deployed desktop 0.10.408 to stable.', { system: { type: 'deploy', title: 'Deployed 0.10.408 to stable', summary: 'hq-desktop-app · 100% rollout' } }],
      ['r3', '5d 12:30', 'deacon', 'hq-core 15.0.17 released. Adds the work-mesh helper and the new search policy.', { files: [{ path: 'companies/indigo/releases/hq-core-15.0.17.md', size: 5_402 }] }],
      ['r4', '5d 12:45', 'grace', 'Packs need a bump for 15.0.17. I will do engineering and design.', { re: 'r3' }],
      ['r5', '2d 15:00', 'deacon', 'Desktop 0.10.410 is on staging. Changelog attached.', { files: [{ path: 'companies/indigo/releases/desktop-0.10.410.md', size: 3_877 }] }],
      ['r6', '2d 15:20', 'priya', 'Smoke test on staging passed. One cosmetic issue in Settings, not blocking.'],
      ['r7', '2d 18:10', 'stefan', 'Ship 0.10.410.', { reactions: [['👍', 3]] }],
      ['r8', '2d 18:30', 'deacon', 'Deployed desktop 0.10.410 to stable.', { system: { type: 'deploy', title: 'Deployed 0.10.410 to stable', summary: 'hq-desktop-app · 100% rollout' } }],
      ['r9', '2d 18:31', 'deacon', '0.10.410 is live. 1,204 users updated in the first hour.', { reactions: [['🎉', 5]] }],
      ['r10', '1d 16:00', 'deacon', 'hq-cloud 2.31.0 deployed to production. Event-driven sync flag now server-controlled.', { system: { type: 'deploy', title: 'Deployed hq-cloud 2.31.0', summary: 'production · us-east-1, eu-central-1' } }],
      ['r11', '1d 16:01', 'deacon', 'hq-cloud 2.31.0 is in production in both regions.'],
      ['r12', '1d 17:50', 'scout', 'Release check for 0.10.411-rc.1: all green.', { system: { type: 'run_complete', title: 'Release check · 0.10.411-rc.1', summary: 'All 418 checks passed' } }],
      ['r13', '5h', 'deacon', 'Desktop 0.10.411 rolling out to 25%. Includes accomplishment badges behind a flag.'],
      ['r14', '3h', 'stefan', 'Pausing 0.10.411 at 25%. Intel crash spike, see #eng.'],
      ['r15', '160m', 'maya', 'Should we tell the pilots?', { re: 'r14' }],
      ['r16', '155m', 'stefan', 'Not yet. If the patch lands this afternoon nobody will notice.', { re: 'r14' }],
      ['r17', '65m', 'deacon', 'Desktop 0.10.411 rollout resumed with the GPU fallback. 50% now.'],
      ['r18', '64m', 'deacon', 'Deployed desktop 0.10.411 to 50%.', { system: { type: 'deploy', title: 'Deployed 0.10.411 to 50%', summary: 'hq-desktop-app · staged rollout' } }],
      ['r19', '2h', 'corey', 'Thanks for the fast turnaround today, everyone.', { reactions: [['❤️', 6]] }],
      ['r20', '58m', 'priya', 'Crash rate back under 0.1% on 0.10.411.', { reactions: [['✅', 4]] }],
    ],
  },
  {
    channelId: 'chn_indigo_launch',
    name: 'launch',
    scope: 'company',
    subtitle: 'HQ 1.0 launch: Oct 21',
    unread: 0,
    members: ['ada', 'corey', 'jacob', 'maya', 'lizzie', 'katherine', 'stefan', 'atlas'],
    lines: [
      ['l1', '6d 13:00', 'corey', 'Launch date is locked: October 21. Two weeks from Wednesday.', { reactions: [['🚀', 8]] }],
      ['l2', '6d 13:20', 'jacob', 'Launch plan v1 is in the vault. Press list, webinar, Product Hunt, newsletter.', { files: [{ path: 'companies/indigo/launch/hq-1.0-launch-plan.md', size: 11_204 }] }],
      ['l3', '5d 10:05', 'lizzie', 'Hero video storyboard is ready for a look.', { files: [{ path: 'companies/indigo/launch/hero-storyboard.pdf', size: 5_802_113 }] }],
      ['l4', '5d 10:40', 'corey', 'Frame 4 is the money shot. Lead with that.', { re: 'l3' }],
      ['l5', '5d 15:15', 'katherine', 'Three pilot customers agreed to be quoted: Northwind, Meridian, Brightline.', { reactions: [['🙌', 5]] }],
      ['l6', '2d 10:00', 'maya', 'Launch checklist: 23 of 41 done. Biggest open item is pricing page copy.'],
      ['l7', '2d 10:30', 'jacob', 'Pricing copy draft is up. Need eyes from Corey and Maya.', { files: [{ path: 'companies/indigo/launch/pricing-copy-v2.md', size: 3_118 }] }],
      ['l8', '2d 11:45', 'corey', 'Cut the feature table in half. Nobody reads past row eight.', { re: 'l7' }],
      ['l9', '2d 14:20', 'atlas', 'Competitor scan for launch week is ready. Two other launches that week, neither in our category.'],
      ['l10', '1d 09:15', 'jacob', 'Product Hunt hunter confirmed.', { reactions: [['🐱', 3]] }],
      ['l11', '1d 11:30', 'maya', 'Launch checklist: 29 of 41.'],
      ['l12', '1d 13:45', 'lizzie', 'Social cards are done in all three sizes.', { files: [{ path: 'companies/indigo/launch/social-cards.pdf', size: 2_204_816 }] }],
      ['l13', '1d 15:30', 'stefan', 'Engineering will freeze the 1.0 build on the 16th.'],
      ['l14', '1d 17:20', 'jacob', 'Newsletter draft goes to Corey tomorrow morning.'],
      ['l15', '1d 18:02', 'corey', 'Great week of progress. Keep going.', { reactions: [['💪', 6]] }],
    ],
  },
  {
    channelId: 'chn_indigo_random',
    name: 'random',
    scope: 'company',
    subtitle: 'Everything else',
    unread: 0,
    members: ALL_PEOPLE,
    lines: [
      ['x1', '6d 12:30', 'leo', 'The coffee machine on 3 is fixed. Rejoice.', { reactions: [['☕', 8]] }],
      ['x2', '6d 12:42', 'hassaan', 'Finally.', { re: 'x1' }],
      ['x3', '5d 17:30', 'jacob', 'Who is in for climbing Saturday?'],
      ['x4', '5d 17:41', 'priya', 'Me. And I am bringing Leo.', { re: 'x3' }],
      ['x5', '5d 17:43', 'leo', 'Apparently I am going climbing.', { re: 'x3', reactions: [['😂', 5]] }],
      ['x6', '4d 15:10', 'priya', 'Climbing photos from today. Leo did the overhang.', { reactions: [['🧗', 4]] }],
      ['x7', '3d 10:22', 'katherine', 'Book club pick for October: The Soul of a New Machine.'],
      ['x8', '3d 10:40', 'grace', 'A classic. I am in.', { re: 'x7' }],
      ['x9', '2d 08:30', 'maya', 'Someone left a very good sourdough in the kitchen. Thank you, whoever you are.'],
      ['x10', '2d 08:46', 'hassaan', 'That was me. Recipe on request.', { re: 'x9', reactions: [['🍞', 6]] }],
      ['x11', '2d 12:15', 'corey', 'Team dinner on the 22nd to celebrate launch. Venue TBD.', { reactions: [['🎉', 9]] }],
      ['x12', '2d 16:40', 'lizzie', 'Desk plant count on the design pod is now 14.'],
      ['x13', '2d 16:52', 'ada', 'Our pod has one and it is plastic.', { re: 'x12' }],
    ],
  },
  {
    channelId: 'chn_proj_accomplishment_badges',
    name: 'accomplishment-badges',
    scope: 'project',
    projectId: 'accomplishment-badges',
    subtitle: 'Badges on profile panes and the Team page',
    unread: 2,
    members: ['ada', 'lizzie', 'maya', 'leo', 'corey', 'scout'],
    lines: [
      ['b1', '5d 09:00', 'maya', 'Project channel for accomplishment badges. PRD is linked in the About tab.'],
      ['b2', '5d 09:05', 'maya', 'Stories: badge art, profile pane section, Team page column, earning rules, notifications.', { files: [{ path: 'companies/indigo/projects/accomplishment-badges/prd.json', size: 7_340 }] }],
      ['b3', '5d 11:20', 'lizzie', 'I will take badge art and the pane section.'],
      ['b4', '5d 11:24', 'ada', 'I will take the profile pane wiring and the badge source API.'],
      ['b5', '2d 10:10', 'leo', 'Badge marks are SVG components now. 9 people badges, 4 bot badges.', { reactions: [['🔥', 3]] }],
      ['b6', '2d 15:30', 'maya', 'Earning rules question: does "Bug hunter" count bugs reported or bugs fixed?'],
      ['b7', '2d 15:41', 'priya', 'Reported and confirmed. Fixed is already covered by Ship it.', { re: 'b6' }],
      ['b8', '2d 15:44', 'maya', 'Agreed, going with that.', { re: 'b6' }],
      ['b9', '1d 10:40', 'ada', 'Profile pane section is done behind the flag. Needs real data before we judge it.'],
      ['b10', '1d 10:52', 'lizzie', 'The harness is too empty to judge it. Can we fill it with a real-looking team?', { re: 'b9' }],
      ['b11', '1d 11:05', 'ada', 'On it. Full Indigo roster, channels with history, DMs, the lot.', { re: 'b9', reactions: [['🙏', 2, false]] }],
      ['b12', '1d 15:20', 'scout', 'Story US-003 (profile pane section) is complete. 12 tests added, all passing.'],
      ['b13', '1d 15:21', 'scout', 'Run complete: US-003 profile pane badges.', { system: { type: 'run_complete', title: 'US-003 · Profile pane badges', summary: '12 tests added, all passing' } }],
      ['b14', '6h', 'leo', 'Tier rings look off by one pixel at 2x. Fix incoming.'],
      ['b15', '4h', 'maya', 'Team page column is next. @Lizzie Liu mocks by Thursday?', { mentions: ['lizzie'] }],
      ['b16', '3h', 'lizzie', 'Thursday works.', { re: 'b15' }],
      ['b17', '74m', 'ada', 'Harness now has the whole team. Click any name to see their badges.', { reactions: [['🏅', 3]] }],
      ['b18', '61m', 'lizzie', 'This is so much better. Reviewing the panes now.'],
    ],
  },
  {
    channelId: 'chn_grp_launch_crew',
    name: '',
    scope: 'group',
    unread: 1,
    members: ['ada', 'corey', 'jacob', 'maya'],
    lines: [
      ['q1', '3d 19:10', 'corey', 'Quick one for the three of you: can we demo badges at launch?'],
      ['q2', '3d 19:22', 'maya', 'If the flag holds, yes. I would keep it to the profile pane.'],
      ['q3', '3d 19:30', 'jacob', 'It would make a great 10 second clip for the video.'],
      ['q4', '2d 09:02', 'ada', 'The pane will be ready. The Team page column probably will not.'],
      ['q5', '2h', 'corey', 'Then pane only. Let us decide Friday.'],
    ],
  },
  {
    channelId: 'chn_indigo_customer_pilots',
    name: 'customer-pilots',
    scope: 'company',
    subtitle: 'Pilot accounts and feedback',
    unread: 0,
    members: ['ada', 'corey', 'katherine', 'jacob', 'maya', 'priya'],
    lines: [
      ['c1', '10d 10:00', 'katherine', 'Brightline pilot starts Monday. 14 seats.'],
      ['c2', '10d 10:20', 'maya', 'Onboarding doc for them is ready.', { files: [{ path: 'companies/indigo/customers/brightline-onboarding.md', size: 4_210 }] }],
      ['c3', '9d 15:30', 'katherine', 'First week feedback from Meridian: they want a weekly digest email.'],
      ['c4', '9d 15:42', 'jacob', 'Atlas already writes one. We could send it.', { re: 'c3' }],
      ['c5', '8d 11:15', 'priya', 'Pilot usage report for September.', { files: [{ path: 'companies/indigo/reports/pilot-usage-2026-09.csv', size: 22_918 }] }],
    ],
  },
  {
    channelId: 'chn_indigo_offsite',
    name: 'offsite-2026',
    scope: 'company',
    subtitle: 'Fall offsite planning',
    unread: 0,
    members: ALL_PEOPLE,
    lines: [
      ['o1', '14d 11:00', 'corey', 'Offsite is booked: Oct 26 to 28, Half Moon Bay.', { reactions: [['🌊', 9]] }],
      ['o2', '14d 11:30', 'maya', 'Agenda draft in the vault. Add sessions you want.', { files: [{ path: 'companies/indigo/offsite/agenda-draft.md', size: 2_760 }] }],
      ['o3', '13d 09:40', 'stefan', 'Adding a session on how we review bot work.'],
      ['o4', '12d 16:15', 'lizzie', 'I can run a design jam on the second morning.'],
    ],
  },
];

// ---------------------------------------------------------------------------
// DMs (keyed by the other person's uid)
// ---------------------------------------------------------------------------

interface DmScript {
  peer: string;
  unread: number;
  lines: Line[];
}

const DM_SCRIPTS: DmScript[] = [
  {
    peer: 'lizzie',
    unread: 2,
    lines: [
      ['1', '1d 10:30', 'lizzie', 'Hey, could you make the harness feel like a real team? I cannot judge the badges with two people in it.'],
      ['2', '1d 10:34', 'ada', 'Yes, good call. How many people do you want?'],
      ['3', '1d 10:36', 'lizzie', 'Ten or so, a few bots, and channels with real history.'],
      ['4', '1d 10:40', 'ada', 'Done by tomorrow.'],
      ['5', '30m', 'lizzie', 'Just opened it. So much better.'],
      ['6', '28m', 'lizzie', 'One thing: can the Team page show the bots too?', { files: [{ path: 'companies/indigo/design/badges/team-page-notes.md', size: 1_402 }] }],
    ],
  },
  {
    peer: 'grace',
    unread: 1,
    lines: [
      ['1', '2d 11:20', 'grace', 'Do you have time to pair on the push receiver retries tomorrow?'],
      ['2', '2d 11:31', 'ada', 'Tomorrow at 10 works.'],
      ['3', '1d 10:00', 'grace', 'Joining now.'],
      ['4', '1d 11:15', 'ada', 'Thanks for that. The backoff table is much clearer now.'],
      ['5', '47m', 'grace', 'Pushed the conflict-versioning notes. Take a look when you get a sec?'],
    ],
  },
  {
    peer: 'stefan',
    unread: 0,
    lines: [
      ['1', '1d 17:00', 'stefan', 'Can you own the Intel crash fix if one comes up during rollout? You know the renderer best.'],
      ['2', '1d 17:05', 'ada', 'Yes.'],
      ['3', '150m', 'stefan', 'Well, it came up.'],
      ['4', '148m', 'ada', 'Already on it. Font feature fallback, patch in ten minutes.'],
      ['5', '66m', 'stefan', 'Rollout resumed. Thank you.'],
    ],
  },
  {
    peer: 'maya',
    unread: 0,
    lines: [
      ['1', '2d 16:00', 'maya', 'Can I put you down for the launch demo? Five minutes on badges.'],
      ['2', '2d 16:20', 'ada', 'Sure, as long as the flag is on by then.'],
      ['3', '2d 16:21', 'maya', 'It will be.'],
      ['4', '4h', 'maya', 'Demo slot moved to 2:15.'],
      ['5', '4h', 'ada', 'Got it.'],
    ],
  },
  {
    peer: 'deacon',
    unread: 1,
    lines: [
      ['1', '1d 15:00', 'ada', 'Can you post the 0.10.411 changelog when the rollout starts?'],
      ['2', '1d 15:01', 'deacon', 'Will do. I will post it in #releases and DM you the draft first.'],
      ['3', '5h', 'deacon', 'Draft changelog for 0.10.411: accomplishment badges (flagged), Intel GPU fallback, faster vault search, 14 bug fixes.'],
      ['4', '5h', 'ada', 'Looks good, ship it.'],
      ['5', '65m', 'deacon', 'Rollout resumed at 50%. I will tell you when it reaches 100%.'],
    ],
  },
  {
    peer: 'atlas',
    unread: 0,
    lines: [
      ['1', '3h', 'ada', 'Where did we land on badge earning rules for bots?'],
      ['2', '3h', 'atlas', 'From #design on Monday: bots get Liftoff, Power user, Closer and Ship it. People badges stay human. Decision by Lizzie, agreed by Grace.'],
      ['3', '3h', 'ada', 'Perfect, thanks.'],
    ],
  },
  {
    peer: 'katherine',
    unread: 0,
    lines: [
      ['1', '9d 14:00', 'katherine', 'Northwind asked if they can export their meeting notes. Is that possible today?'],
      ['2', '9d 14:30', 'ada', 'Yes, from the vault. I will write them a short guide.'],
      ['3', '9d 16:05', 'katherine', 'Orbit math notes are ready for review, by the way.'],
    ],
  },
  {
    peer: 'jacob',
    unread: 0,
    lines: [
      ['1', '11d 10:00', 'jacob', 'Could you record a 30 second clip of the new Home for the newsletter?'],
      ['2', '11d 10:20', 'ada', 'Sure, sending this afternoon.'],
      ['3', '11d 15:45', 'ada', 'Here it is.', { files: [{ path: 'companies/indigo/launch/home-clip.mov', size: 18_402_118, type: 'video/quicktime' }] }],
      ['4', '11d 15:50', 'jacob', 'Perfect, thank you!'],
    ],
  },
  {
    peer: 'hassaan',
    unread: 0,
    lines: [
      ['1', '8d 13:00', 'hassaan', 'Is the old poll loop safe to delete once push is at 100%?'],
      ['2', '8d 13:12', 'ada', 'Keep it as a fallback for one more release, then yes.'],
    ],
  },
];

// ---------------------------------------------------------------------------
// Public builders (called per request, so stamps track the clock)
// ---------------------------------------------------------------------------

function memberKeys(script: ChannelScript): string[] {
  return script.members ?? ALL_PEOPLE;
}

function actorKeyByUid(uid: string): string | null {
  return TEAM_PEOPLE.find((p) => p.personUid === uid)?.key ?? TEAM_BOTS.find((b) => b.agentUid === uid)?.key ?? null;
}

export function channelMessages(channelId: string, now = HARNESS_NOW): WireMessage[] | null {
  const script = CHANNEL_SCRIPTS.find((row) => row.channelId === channelId);
  if (!script) return null;
  return buildMessages(script.channelId, script.lines, now);
}

/** Newest-first, as `fetch_channel` and `fetch_dm_thread` answer. */
export function newestFirst<T extends { createdAt: string }>(rows: T[]): T[] {
  return rows.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function lastHumanAt(messages: WireMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const row = messages[i]!;
    if (!row.fromPersonUid.startsWith('agt_') && !row.systemEvent) return row.createdAt;
  }
  return null;
}

/** `list_channels` rows. */
export function channelDirectory(now = HARNESS_NOW): Array<Record<string, unknown>> {
  return CHANNEL_SCRIPTS.map((script) => {
    const messages = buildMessages(script.channelId, script.lines, now);
    const last = messages[messages.length - 1];
    const members = memberKeys(script).map((key) => actor(key));
    const humanAt = lastHumanAt(messages);
    return {
      channelId: script.channelId,
      id: script.channelId,
      name: script.name,
      scope: script.scope,
      type: script.scope === 'project' ? 'project' : 'chat',
      ...(script.scope === 'group' ? {} : { companyUid: INDIGO_UID, companyName: INDIGO_NAME }),
      ...(script.projectId ? { projectId: script.projectId } : {}),
      ...(script.subtitle ? { subtitle: script.subtitle } : {}),
      visibility: script.scope === 'group' ? 'private' : 'company',
      membership: 'joined',
      isCompanyHome: false,
      notifyLevel: 'all',
      unread: script.unread,
      unreadCount: script.unread,
      ...(script.mention ? { mentionFlag: true } : {}),
      memberCount: members.length,
      // A group DM is labelled by the other people in it.
      members: members
        .filter((m) => script.scope !== 'group' || m.uid !== SELF_UID)
        .map((m) => ({ personUid: m.uid, displayName: m.name })),
      lastActivityAt: last?.createdAt ?? null,
      ...(humanAt ? { lastHumanMessageAt: humanAt } : { hasHumanMessage: false }),
      createdAt: messages[0]?.createdAt ?? null,
      createdBy: messages[0]?.fromPersonUid,
    };
  });
}

/** `list_channel_members` rows for one channel. */
export function channelMembers(channelId: string): Array<Record<string, unknown>> | null {
  const script = CHANNEL_SCRIPTS.find((row) => row.channelId === channelId);
  if (!script) return null;
  const creatorUid = actor(script.lines[0]![2]).uid;
  return memberKeys(script).map((key) => {
    const who = actor(key);
    const person = PEOPLE_BY_KEY.get(key);
    const bot = BOTS_BY_KEY.get(key);
    return {
      personUid: who.uid,
      email: who.email ?? '',
      displayName: who.name,
      role: who.uid === creatorUid ? 'owner' : who.isBot ? 'agent' : 'member',
      ...(person ? { description: person.title } : {}),
      ...(bot ? { description: bot.description } : {}),
    };
  });
}

/** `fetch_thread` for a channel or DM root. */
export function replyThread(rootEventId: string, now = HARNESS_NOW): { root: WireMessage | null; replies: WireMessage[]; replyCount: number } {
  const all = [
    ...CHANNEL_SCRIPTS.flatMap((script) => buildMessages(script.channelId, script.lines, now)),
    ...DM_SCRIPTS.flatMap((script) => dmMessages(actor(script.peer).uid, now) ?? []),
  ];
  const root = all.find((row) => row.eventId === rootEventId) ?? null;
  const replies = all.filter((row) => row.rootEventId === rootEventId);
  return { root, replies, replyCount: replies.length };
}

/** Reaction aggregates for any scripted message. */
export function reactionsFor(messageId: string, now = HARNESS_NOW): Array<{ emoji: string; count: number; reactedByMe: boolean }> | null {
  for (const script of CHANNEL_SCRIPTS) {
    if (!messageId.startsWith(`${script.channelId}-`)) continue;
    const hit = buildMessages(script.channelId, script.lines, now).find((row) => row.eventId === messageId);
    return hit?.reactions ?? [];
  }
  return null;
}

export function dmMessages(peerUid: string, now = HARNESS_NOW): WireMessage[] | null {
  const key = actorKeyByUid(peerUid);
  const script = key ? DM_SCRIPTS.find((row) => row.peer === key) : undefined;
  if (!script) return null;
  return buildMessages(`dm-${script.peer}`, script.lines, now);
}

/** `/v1/notify/dm-threads` rows. */
export function dmThreadIndex(now = HARNESS_NOW): Array<Record<string, unknown>> {
  return DM_SCRIPTS.map((script) => {
    const peer = actor(script.peer);
    const messages = buildMessages(`dm-${script.peer}`, script.lines, now);
    const last = messages[messages.length - 1]!;
    const humanAt = lastHumanAt(messages);
    return {
      peerUid: peer.uid,
      peerDisplayName: peer.name,
      lastActivityAt: last.createdAt,
      ...(humanAt ? { lastHumanMessageAt: humanAt } : { hasHumanMessage: false }),
      unreadCount: script.unread,
    };
  });
}

/**
 * `/v1/notify/inbox`: the newest received DM per peer inside the inbox
 * window (two days), plus the per-pair unread rollup. Older pairs reach the
 * rail through the DM thread listing instead.
 */
export function dmInbox(now = HARNESS_NOW): { events: Array<Record<string, unknown>>; pairUnreads: Array<{ withPersonUid: string; unreadCount: number }> } {
  const windowStart = new Date(now - 2 * 86_400_000).toISOString();
  const events: Array<Record<string, unknown>> = [];
  for (const script of DM_SCRIPTS) {
    const received = buildMessages(`dm-${script.peer}`, script.lines, now).filter((row) => row.direction === 'in');
    const newest = received[received.length - 1];
    if (!newest || newest.createdAt < windowStart) continue;
    events.push({
      eventId: newest.eventId,
      fromPersonUid: newest.fromPersonUid,
      fromEmail: newest.fromEmail,
      fromDisplayName: newest.fromDisplayName,
      body: newest.body,
      createdAt: newest.createdAt,
      acknowledgedAt: script.unread > 0 ? null : newest.createdAt,
    });
  }
  return {
    events: newestFirst(events as Array<Record<string, unknown> & { createdAt: string }>),
    pairUnreads: DM_SCRIPTS.map((script) => ({ withPersonUid: actor(script.peer).uid, unreadCount: script.unread })),
  };
}

/** Event id of the newest received DM from one peer (the inbox row id). */
function newestDmEventId(peerKey: string, now: number): string {
  const script = DM_SCRIPTS.find((row) => row.peer === peerKey)!;
  const received = buildMessages(`dm-${script.peer}`, script.lines, now).filter((row) => row.direction === 'in');
  return received[received.length - 1]!.eventId;
}

/** `list_contacts`: everyone but the signed-in user, with DM activity where it exists. */
export function teamContacts(now = HARNESS_NOW): Array<Record<string, unknown>> {
  const threads = new Map(dmThreadIndex(now).map((row) => [row.peerUid as string, row]));
  const rows: Array<Record<string, unknown>> = [];
  for (const person of TEAM_PEOPLE) {
    if (person.personUid === SELF_UID) continue;
    const thread = threads.get(person.personUid);
    const messages = thread ? dmMessages(person.personUid, now) ?? [] : [];
    const last = messages[messages.length - 1];
    rows.push({
      personUid: person.personUid,
      email: person.email,
      displayName: person.displayName,
      companyUid: INDIGO_UID,
      companyName: INDIGO_NAME,
      source: 'company',
      role: person.role,
      ...(last
        ? {
            lastMessageAt: last.createdAt,
            lastMessageBody: last.body,
            lastMessageDirection: last.direction,
            unreadCount: thread?.unreadCount ?? 0,
          }
        : {}),
    });
  }
  for (const bot of TEAM_BOTS) {
    const thread = threads.get(bot.agentUid);
    const messages = thread ? dmMessages(bot.agentUid, now) ?? [] : [];
    const last = messages[messages.length - 1];
    rows.push({
      personUid: bot.agentUid,
      email: null,
      displayName: bot.displayName,
      companyUid: INDIGO_UID,
      companyName: INDIGO_NAME,
      source: 'company',
      kind: 'agent',
      ...(last
        ? {
            lastMessageAt: last.createdAt,
            lastMessageBody: last.body,
            lastMessageDirection: last.direction,
            unreadCount: thread?.unreadCount ?? 0,
          }
        : {}),
    });
  }
  return rows;
}

/** `list_company_members` (GET /v1/notify/contacts?companyUid=…). */
export function companyMembers(): Array<Record<string, unknown>> {
  return [
    ...TEAM_PEOPLE.map((person) => ({
      personUid: person.personUid,
      email: person.email,
      displayName: person.displayName,
      companyUid: INDIGO_UID,
      companyName: INDIGO_NAME,
      role: person.role,
      source: 'company',
    })),
    ...TEAM_BOTS.map((bot) => ({
      personUid: bot.agentUid,
      email: null,
      displayName: bot.displayName,
      companyUid: INDIGO_UID,
      companyName: INDIGO_NAME,
      role: 'agent',
      kind: 'agent',
      source: 'company',
    })),
  ];
}

// ---------------------------------------------------------------------------
// Team telemetry (get_company_team_telemetry)
// ---------------------------------------------------------------------------

interface TelemetrySeed {
  key: string;
  events: number;
  sessions: number;
  model: string;
  tokens: [input: number, output: number, cacheRead: number];
  skills: Array<[skill: string, count: number]>;
  projects: string[];
  outcomes: [stories: number, prs: number, deploys: number];
}

const TELEMETRY: TelemetrySeed[] = [
  { key: 'ada', events: 212, sessions: 36, model: 'claude-opus-4', tokens: [910_000, 240_000, 1_620_000], skills: [['run-project', 18], ['tdd', 15], ['review', 11]], projects: ['Accomplishment badges', 'HQ Desktop app'], outcomes: [17, 12, 2] },
  { key: 'corey', events: 184, sessions: 31, model: 'claude-opus-4', tokens: [820_000, 210_000, 1_400_000], skills: [['run-project', 22], ['storyboard', 14]], projects: ['HQ 1.0 launch', 'Event-driven HQ-Cloud sync'], outcomes: [14, 9, 3] },
  { key: 'grace', events: 176, sessions: 29, model: 'claude-opus-4', tokens: [700_000, 190_000, 1_210_000], skills: [['diagnose', 19], ['review', 16]], projects: ['Event-driven HQ-Cloud sync'], outcomes: [11, 14, 4] },
  { key: 'stefan', events: 158, sessions: 27, model: 'claude-sonnet-4', tokens: [520_000, 150_000, 880_000], skills: [['review', 24], ['quality-gate', 12]], projects: ['Desktop 0.10.411 release'], outcomes: [6, 18, 7] },
  { key: 'hassaan', events: 149, sessions: 25, model: 'claude-opus-4', tokens: [640_000, 170_000, 990_000], skills: [['tdd', 21], ['diagnose', 9]], projects: ['S3-versioned conflict handling', 'Event-driven HQ-Cloud sync'], outcomes: [12, 10, 1] },
  { key: 'leo', events: 121, sessions: 22, model: 'claude-sonnet-4', tokens: [380_000, 120_000, 610_000], skills: [['implement', 17], ['review', 6]], projects: ['Accomplishment badges'], outcomes: [9, 8, 0] },
  { key: 'lizzie', events: 104, sessions: 19, model: 'claude-sonnet-4', tokens: [300_000, 96_000, 410_000], skills: [['storyboard', 16], ['critique', 12]], projects: ['Accomplishment badges', 'HQ 1.0 launch'], outcomes: [7, 2, 0] },
  { key: 'maya', events: 88, sessions: 17, model: 'claude-sonnet-4', tokens: [190_000, 60_000, 240_000], skills: [['plan', 14], ['review', 12]], projects: ['Accomplishment badges', 'HQ 1.0 launch'], outcomes: [5, 3, 1] },
  { key: 'priya', events: 97, sessions: 18, model: 'claude-sonnet-4', tokens: [240_000, 70_000, 330_000], skills: [['quality-gate', 18], ['diagnose', 7]], projects: ['Desktop 0.10.411 release'], outcomes: [4, 2, 0] },
  { key: 'jacob', events: 63, sessions: 12, model: 'claude-sonnet-4', tokens: [150_000, 52_000, 180_000], skills: [['newsletter', 9], ['signals', 7]], projects: ['HQ 1.0 launch'], outcomes: [3, 0, 0] },
  { key: 'katherine', events: 41, sessions: 9, model: 'claude-haiku-4', tokens: [60_000, 21_000, 70_000], skills: [['meeting-notes', 11]], projects: ['Customer pilots'], outcomes: [2, 0, 0] },
  { key: 'deacon', events: 233, sessions: 44, model: 'claude-sonnet-4', tokens: [460_000, 130_000, 720_000], skills: [['ship', 31], ['document-release', 22]], projects: ['Desktop 0.10.411 release'], outcomes: [3, 6, 19] },
  { key: 'scout', events: 196, sessions: 38, model: 'gpt-5', tokens: [520_000, 140_000, 640_000], skills: [['quality-gate', 38], ['diagnose', 14]], projects: ['Accomplishment badges', 'Desktop 0.10.411 release'], outcomes: [8, 1, 0] },
  { key: 'atlas', events: 143, sessions: 28, model: 'claude-sonnet-4', tokens: [410_000, 120_000, 600_000], skills: [['search', 36], ['signals', 19]], projects: ['HQ 1.0 launch'], outcomes: [2, 0, 0] },
  { key: 'ranger', events: 118, sessions: 24, model: 'claude-haiku-4', tokens: [90_000, 30_000, 140_000], skills: [['hq-sync', 27], ['diagnose', 11]], projects: ['Event-driven HQ-Cloud sync'], outcomes: [1, 2, 0] },
];

function trendFor(key: string, events: number): number[] {
  let h = 2166136261;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  const base = Math.max(1, Math.round(events / 22));
  return Array.from({ length: 30 }, (_, day) => {
    const weekend = day % 7 === 5 || day % 7 === 6;
    h = Math.imul(h ^ day, 16777619);
    const jitter = ((h >>> 0) % 5) - 2;
    return weekend && !key.match(/deacon|scout|atlas|ranger/) ? 0 : Math.max(0, base + jitter);
  });
}

export function teamTelemetry(): { perMember: Array<Record<string, unknown>> } {
  return {
    perMember: TELEMETRY.map((seed) => {
      const who = actor(seed.key);
      const person = PEOPLE_BY_KEY.get(seed.key);
      const bot = BOTS_BY_KEY.get(seed.key);
      const [stories, prs, deploys] = seed.outcomes;
      return {
        personUid: who.uid,
        displayName: who.name,
        kind: who.isBot ? 'agent' : 'human',
        role: person ? person.role[0]!.toUpperCase() + person.role.slice(1) : `Bot · owned by ${botOwner(bot!).displayName}`,
        totals: {
          events: seed.events,
          distinctSessions: seed.sessions,
          tokensByModel: [{ model: seed.model, input: seed.tokens[0], output: seed.tokens[1], cacheCreation: Math.round(seed.tokens[0] / 10), cacheRead: seed.tokens[2] }],
          skills: { bySkill: seed.skills.map(([skill, count]) => ({ skill, count })) },
        },
        activeProjects: seed.projects,
        joinedAt: person?.joinedAt ?? bot!.createdAt,
        outcomes: { byType: { storyCompleted: stories, prMerged: prs, deploySucceeded: deploys }, total: stories + prs + deploys },
        trend: trendFor(seed.key, seed.events),
      };
    }),
  };
}

/** `/v1/agents/mobile-roster`: cloud bots, none local and none live. */
export function botRoster(): Array<Record<string, unknown>> {
  return TEAM_BOTS.map((bot) => {
    const owner = botOwner(bot);
    return {
      agentUid: bot.agentUid,
      name: bot.name,
      displayName: bot.displayName,
      description: bot.description,
      companyUid: INDIGO_UID,
      ownerUid: owner.personUid,
      ownerDisplayName: owner.displayName,
      ownerEmail: owner.email,
      runtime: bot.runtime,
      setupPhase: 'ready',
      createdAt: bot.createdAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Inbox (fetch_notifications)
// ---------------------------------------------------------------------------

export function teamNotifications(now = HARNESS_NOW): Array<Record<string, unknown>> {
  const at = (spec: string) => stamp(spec, now);
  const from = (key: string) => {
    const who = actor(key);
    return { actorPersonUid: who.uid, actorName: who.name };
  };
  const row = (fields: Record<string, unknown>, read: boolean) => ({
    companyUid: INDIGO_UID,
    actionable: false,
    status: read ? 'read' : 'unread',
    readAt: read ? fields.createdAt : null,
    ...fields,
  });
  return [
    row({ id: 'ntf_mention_leo', type: 'mention', ...from('leo'), title: 'Leo Park mentioned you in #design', body: '@Ada Lovelace can you check the badge hover on Safari? It flickers for me.', context: '#design', targetRef: '/channels/chn_indigo_design', createdAt: at('9m') }, false),
    row({ id: 'ntf_dm_lizzie', type: 'dm', ...from('lizzie'), title: 'Lizzie Liu', body: 'One thing: can the Team page show the bots too?', targetRef: '/messages/prs_lizzie', sourceEventId: newestDmEventId('lizzie', now), createdAt: at('28m') }, false),
    row({ id: 'ntf_mention_hassaan', type: 'mention', ...from('hassaan'), title: 'Hassaan Ali mentioned you in #eng', body: 'Can someone look at the conflict-versioning migration before I run it on staging?', context: '#eng', targetRef: '/channels/chn_indigo_eng', createdAt: at('41m') }, false),
    row({ id: 'ntf_dm_grace', type: 'dm', ...from('grace'), title: 'Grace Hopper', body: 'Pushed the conflict-versioning notes. Take a look when you get a sec?', targetRef: '/messages/prs_grace', sourceEventId: newestDmEventId('grace', now), createdAt: at('47m') }, false),
    row({ id: 'ntf_dm_deacon', type: 'dm', ...from('deacon'), title: 'Deacon', body: 'Rollout resumed at 50%. I will tell you when it reaches 100%.', targetRef: '/messages/agt_deacon', sourceEventId: newestDmEventId('deacon', now), createdAt: at('65m') }, false),
    row({ id: 'ntf_review_scout', type: 'agent_review_request', ...from('scout'), title: 'Scout requested your review', body: 'PR #1297 · Fall back to plain numerals on unsupported GPUs', context: '#eng', targetRef: '/channels/chn_indigo_eng', createdAt: at('100m') }, false),
    row({ id: 'ntf_mention_maya', type: 'mention', ...from('maya'), title: 'Maya Chen mentioned you in #accomplishment-badges', body: 'Team page column is next.', context: '#accomplishment-badges', targetRef: '/channels/chn_proj_accomplishment_badges', createdAt: at('4h') }, true),
    row({ id: 'ntf_story_scout', type: 'agent_finished_story', ...from('scout'), title: 'Scout finished a story', body: 'US-003 · Profile pane badges. 12 tests added, all passing.', context: '#accomplishment-badges', targetRef: '/channels/chn_proj_accomplishment_badges', createdAt: at('1d 15:20') }, true),
  ];
}

/** `/v1/files/shared-with-me` events. */
export function sharedWithMe(now = HARNESS_NOW): Array<Record<string, unknown>> {
  const share = (id: string, key: string, paths: string[], note: string, when: string, read: boolean) => {
    const person = PEOPLE_BY_KEY.get(key)!;
    const createdAt = stamp(when, now);
    return { eventId: id, issuerEmail: person.email, issuerDisplayName: person.displayName, issuerPersonUid: person.personUid, paths, note, permission: 'read', createdAt, acknowledgedAt: read ? createdAt : null };
  };
  return [
    share('share_lizzie_badges', 'lizzie', ['companies/indigo/design/badges/badge-sheet-v3.pdf'], 'Final badge sheet for the profile pane.', '1d 09:30', false),
    share('share_maya_review', 'maya', ['companies/indigo/design/reviews/2026-10-05-badges.md'], 'Review notes and decisions.', '2d 14:00', true),
  ];
}

/** `/v1/notify/file-history` rows. */
export function fileHistory(now = HARNESS_NOW): Array<Record<string, unknown>> {
  const file = (id: string, key: string, path: string, bytes: number, when: string) => ({
    eventId: id, path, bytes, addedBy: PEOPLE_BY_KEY.get(key)!.email, companyUid: INDIGO_UID, companySlug: 'indigo', createdAt: stamp(when, now),
  });
  return [
    file('file_meridian', 'corey', 'companies/indigo/meetings/2026-10-07-meridian.md', 6_410, '5h'),
  ];
}

/** `/membership/company/{uid}`: roles and join dates for the Team page. */
export function companyMemberships(): Array<Record<string, unknown>> {
  return TEAM_PEOPLE.map((person) => ({
    membershipKey: `mbr_${person.key}`,
    personUid: person.personUid,
    companyUid: INDIGO_UID,
    role: person.role,
    status: 'active',
    personName: person.displayName,
    personEmail: person.email,
    invitedAt: person.joinedAt,
    acceptedAt: person.joinedAt,
  }));
}

/** `/v1/agents/{uid}/status` for the bot profile pane. */
export function botStatus(agentUid: string): Record<string, unknown> | null {
  const bot = TEAM_BOTS.find((row) => row.agentUid === agentUid);
  if (!bot) return null;
  return {
    agent: { agentUid: bot.agentUid, displayName: bot.displayName, name: bot.name, description: bot.description, runtime: bot.runtime },
    memberships: [{ companyUid: INDIGO_UID, companyName: INDIGO_NAME, role: 'member', status: 'active' }],
  };
}

const BOT_JOBS: Record<string, Array<[prompt: string, schedule: string, outcome: string, lastRun: string]>> = {
  deacon: [['Post the changelog when a desktop rollout starts', 'ENABLED', 'success', '5h'], ['Watch crash rate during staged rollouts', 'ENABLED', 'success', '64m']],
  atlas: [['Write the Friday weekly digest', 'ENABLED', 'success', '5d 15:48'], ['Answer knowledge questions in #general', 'ENABLED', 'success', '25m']],
  scout: [['Nightly QA pass on the latest rc', 'ENABLED', 'success', '1d 17:45'], ['Triage new bug reports', 'ENABLED', 'success', '2d 11:10']],
  ranger: [['Weekly reliability report', 'ENABLED', 'success', '5d 12:00'], ['Watch push reconnect rates', 'ENABLED', 'success', '4h']],
};

/** `/v1/agents/{uid}/jobs`. */
export function botJobs(agentUid: string, now = HARNESS_NOW): Array<Record<string, unknown>> {
  const bot = TEAM_BOTS.find((row) => row.agentUid === agentUid);
  if (!bot) return [];
  return (BOT_JOBS[bot.key] ?? []).map(([prompt, scheduleState, lastRunOutcome, lastRun], index) => ({
    jobId: `job_${bot.key}_${index + 1}`,
    prompt,
    scheduleState,
    status: 'idle',
    lastRunAt: stamp(lastRun, now),
    lastRunOutcome,
  }));
}

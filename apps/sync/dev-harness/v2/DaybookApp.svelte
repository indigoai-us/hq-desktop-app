<script lang="ts">
  /**
   * V2 concept — "Daybook" shell, ported from Corey's static prototype
   * (hq-desktop-concepts.indigo-hq.com) into the design harness so it can be
   * iterated in the same wallpaper + floating-window preview format as v1.
   *
   * Faithful to the drafted IA (company rail · day-grouped sidebar · channel
   * feed with Board/Files tabs · Core menu) with detail refinements: Geist
   * type, tokenized dark AND light themes (dark is the concept's home), v1's
   * radius language, and macOS-style traffic lights.
   *
   * Harness-only — nothing in the shipping app imports this.
   */
  import {
    ArrowLeft,
    ArrowRight,
    ArrowUpRight,
    ArrowsDownUp,
    Bell,
    Books,
    BookOpen,
    CaretDown,
    CaretRight,
    ChatCircle,
    Check,
    Clock,
    CheckCircle,
    Circle,
    FileText,
    FunnelSimple,
    GearSix,
    GitPullRequest,
    Hash,
    Kanban,
    KeyReturn,
    Image,
    Lightning,
    MagnifyingGlass,
    Note,
    Package,
    Paperclip,
    PaperPlaneRight,
    PushPin,
    User,
    X,
    RocketLaunch,
    ShieldCheck,
    Smiley,
    SignOut,
    Stack,
    UserCircle,
    VideoCamera,
    Warning,
  } from 'phosphor-svelte';
  import { cubicOut } from 'svelte/easing';

  /** Pane slide: widens from the right edge while its content translates in,
   *  so the board reflows instead of being covered. */
  /** Marketplace pack detail (same right-hand pane pattern as stories). */
  let openPack = $state<[string, string, string, string] | null>(null);
  const PACK_DETAIL: Record<string, { publisher: string; updated: string; includes: [string, string][]; notes: string }> = {
    engineering: { publisher: 'Indigo', updated: 'Jul 28', notes: 'Adds the investigate → review → land loop, plus the release checklist worker.', includes: [['skill', '/investigate'], ['skill', '/review'], ['skill', '/land'], ['worker', 'build-agent']] },
    'design-styles': { publisher: 'Indigo', updated: 'Today', notes: 'Brand packs and design tokens bound to deploys. v3.0 adds the daybook token set.', includes: [['skill', '/storyboard'], ['worker', 'paper-designer'], ['knowledge', 'design tokens']] },
    parker: { publisher: 'Sender Agency', updated: 'Jul 14', notes: 'Creative iteration engine for short-form ads.', includes: [['worker', 'parker'], ['skill', '/hooks-test']] },
    'slack-bot': { publisher: 'Indigo', updated: 'Jun 30', notes: 'Run HQ agents from inside a Slack workspace.', includes: [['worker', 'slack-relay'], ['skill', '/broadcast']] },
    accounting: { publisher: 'Community', updated: 'Jul 2', notes: 'Books, categorization, and monthly close helpers.', includes: [['worker', 'bookkeeper'], ['skill', '/close-month']] },
    'secure-sidecar': { publisher: 'Community', updated: 'Jun 18', notes: 'Scoped secret access for untrusted workloads.', includes: [['worker', 'sidecar'], ['policy', 'secret scoping']] },
  };

  const STORY_PANEL_W = 340;
  /** Slides the pane in from the right by animating its margin, so the board
   *  reflows around it. Deliberately avoids flex-basis/width: Svelte leaves the
   *  finished animation applied, which would pin the pane's width forever. */
  function slidePane() {
    return {
      duration: 200,
      easing: cubicOut,
      css: (t: number) => `margin-right: ${(t - 1) * STORY_PANEL_W}px; opacity: ${t};`,
    };
  }

  interface Props {
    theme?: string;
  }
  let { theme = 'dark' }: Props = $props();

  /* Item-glyph vocabulary — data rows carry a semantic key, phosphor draws it. */
  const GLYPHS: Record<string, typeof FileText> = {
    file: FileText,
    image: Image,
    knowledge: BookOpen,
    doc: Note,
    meeting: VideoCamera,
    policy: ShieldCheck,
    skill: Lightning,
    worker: UserCircle,
  };

  /* ═══════════ Fixture data (from the prototype) ═══════════ */
  type FeedItem = {
    sep?: string;
    who?: string;
    av?: string;
    ai?: boolean;
    when?: string;
    text?: string;
    card?: { t: string; s: string; actions?: string[] };
    file?: { n: string; m: string };
    /** Inline thread event: who did what, when. */
    event?: { who: string; what: string; when: string; kind: 'run' | 'pr' | 'file' | 'release' };
  };
  const EVENT_ICONS = { run: User, pr: GitPullRequest, file: FileText, release: RocketLaunch };
  type Channel = {
    type: 'project' | 'channel' | 'dm';
    title: string;
    sub: string;
    unread?: number;
    live?: boolean;
    av?: string;
    /** Group threads carry their member count instead of an initial. */
    members?: number;
    /** Humans active in a project channel — drives the People filter. */
    people?: string[];
    status?: { dot: string; label: string };
    feed: FeedItem[];
    board?: { inprog: string[][]; review: string[][]; done: string[][] };
    files?: string[][];
  };
  type Company = {
    label: string;
    short: string;
    pinned: string[];
    days: { label: string; date: string; items: string[] }[];
    channels: Record<string, Channel>;
  };

  const DATA: Record<string, Company> = $state({
    indigo: {
      label: 'Indigo',
      short: 'IN',
      pinned: ['hq-desktop', 'hq-sync'],
      days: [
        { label: 'TODAY', date: 'AUG 4', items: ['agent-orchestrator', 'bryan', 'gtm-standup'] },
        { label: 'YESTERDAY', date: 'AUG 3', items: ['standup-brief', 'sofia-marcus', 'customer-conversations'] },
        { label: 'SATURDAY', date: 'AUG 1', items: ['enterprise-pricing'] },
      ],
      channels: {
        'hq-desktop': {
          type: 'project', title: '# hq-desktop', sub: 'Indigo · project channel', unread: 4, people: ['Corey', 'Bryan', 'Sofia', 'Marcus'],
          status: { dot: 'ok', label: 'Agent running' },
          feed: [
            { sep: 'TODAY' },
            { who: 'Bryan', av: 'B', when: '9:12 AM', text: 'Sidebar concepts look right — can we see the day groups collapse after a week?' },
            { event: { who: 'Desktop Agent', what: 'started run US-004 · day-group collapse', when: '9:14 AM', kind: 'run' } },
            { who: 'Desktop Agent', ai: true, when: 'RUN COMPLETE · 9:31 AM', card: { t: 'Story US-004 shipped — day-group collapse behavior', s: 'Groups older than 7 days fold into a single "Last week" row. 12 tests added, preview deployed.', actions: ['Open preview', 'View diff'] } },
            { event: { who: 'Desktop Agent', what: 'deployed hq-desktop-preview', when: '9:32 AM', kind: 'release' } },
            { who: 'Corey', av: 'C', when: '9:34 AM', text: "Perfect. Let's fold marketplace into the Core menu next." },
            { event: { who: 'Bryan', what: 'opened PR #214 — unified shell frame', when: '9:41 AM', kind: 'pr' } },
            { who: 'Sofia', av: 'S', when: '10:02 AM', text: 'Dropped the updated library IA in Files — company knowledge now lives one tab away instead of three menus deep.', file: { n: 'library-ia-v2.md', m: 'FILES · 4 KB' } },
            { event: { who: 'Sofia', what: 'added library-ia-v2.md to Files', when: '10:02 AM', kind: 'file' } },
          ],
          board: {
            inprog: [['US-002 · sidebar day-grouping', 'AGENT RUNNING · 62%', 'ok'], ['US-005 · Core dropdown', 'Corey · design review', ''], ['US-007 · library overlay', 'Sofia · spec', '']],
            review: [['US-004 · day-group collapse', 'PR OPEN · CI GREEN', 'warn'], ['US-001 · unified shell frame', 'Marcus reviewing', '']],
            done: [['US-003 · remove messages app', 'SHIPPED', 'ok'], ['US-006 · title bar', 'SHIPPED', 'ok']],
          },
          files: [['file', 'library-ia-v2.md', 'SOFIA · TODAY'], ['file', 'daybook-interaction-notes.md', 'COREY · TODAY'], ['image', 'concept-a-daybook.png', 'AGENT · YESTERDAY'], ['file', 'prd-draft.json', 'AGENT · AUG 1']],
        },
        'hq-sync': {
          type: 'project', title: '# hq-sync', sub: 'Indigo · project channel', people: ['Corey', 'Bryan'],
          status: { dot: 'ok', label: 'Idle' },
          feed: [
            { sep: 'YESTERDAY' },
            { event: { who: 'Build Agent', what: 'tagged v0.10.43', when: '4:55 PM', kind: 'release' } },
            { who: 'Build Agent', ai: true, when: '5:02 PM', card: { t: 'v0.10.43 released', s: 'Menubar popover drift detection shipped to prod.', actions: ['Release notes'] } },
          ],
          board: { inprog: [], review: [], done: [['US-011 · drift detect', 'SHIPPED', 'ok'], ['US-012 · rescue flow', 'SHIPPED', 'ok']] },
          files: [['file', 'release-checklist.md', 'AGENT · AUG 3']],
        },
        'agent-orchestrator': {
          type: 'project', title: '# agent-orchestrator', sub: 'Indigo · project channel', live: true, people: ['Corey'],
          status: { dot: 'ok', label: 'Agent running' },
          feed: [
            { sep: 'TODAY' },
            { event: { who: 'Fleet Agent', what: 'started the nightly triage sweep', when: '10:00 AM', kind: 'run' } },
            { who: 'Fleet Agent', ai: true, when: 'RUNNING · 10:14 AM', card: { t: 'Nightly triage sweep', s: '12 boxes checked, 1 flagged for storage autoscale.', actions: ['View report'] } },
          ],
          board: { inprog: [['US-020 · box telemetry', 'AGENT · 30%', 'ok']], review: [], done: [] },
          files: [['file', 'triage-report-aug4.md', 'AGENT · TODAY']],
        },
        'gtm-standup': {
          type: 'channel', title: '# gtm-standup', sub: 'Indigo · channel',
          feed: [
            { sep: 'TODAY' },
            { who: 'Standup Agent', ai: true, when: '8:30 AM', card: { t: 'Standup recap — Aug 4', s: '4 deliverables in motion, 1 blocker on the pricing page copy.', actions: ['Open brief'] } },
            { who: 'Bryan', av: 'B', when: '8:41 AM', text: 'Pricing blocker is on me — copy review by noon.' },
          ],
        },
        bryan: {
          type: 'dm', title: 'Bryan', sub: 'direct message', unread: 2, av: 'B',
          feed: [
            { sep: 'TODAY' },
            { who: 'Bryan', av: 'B', when: '9:12 AM', text: 'Sidebar concepts look right — can we see the day groups collapse after a week?' },
            { who: 'Bryan', av: 'B', when: '9:13 AM', text: 'Also — demo with the Nestlé team moved to Thursday.' },
          ],
        },
        'sofia-marcus': {
          type: 'dm', title: 'Sofia, Marcus, Priya', sub: 'group message', av: 'S', members: 3,
          feed: [
            { sep: 'YESTERDAY' },
            { who: 'Sofia', av: 'S', when: '2:14 PM', text: 'Library IA thread resolved — doc saved to Knowledge.' },
            { who: 'Marcus', av: 'M', when: '2:20 PM', text: 'Nice. Linking it from the project channel.' },
            { who: 'Priya', av: 'P', when: '2:26 PM', text: 'Adding it to the onboarding checklist too.' },
          ],
        },
        'standup-brief': {
          type: 'project', title: '# standup-brief', sub: 'Indigo · project channel', people: ['Bryan', 'Priya'],
          status: { dot: 'ok', label: 'Idle' },
          feed: [{ sep: 'YESTERDAY' }, { who: 'Deploy Agent', ai: true, when: '5:02 PM', card: { t: 'Brief deployed', s: 'Posted to #hq-dev with the transcript-dated link.', actions: ['Open brief'] } }],
          board: { inprog: [], review: [], done: [['US-001 · recall pull', 'SHIPPED', 'ok']] },
          files: [['file', 'brief-2026-08-03.html', 'AGENT · AUG 3']],
        },
        'customer-conversations': {
          type: 'channel', title: '# customer-conversations', sub: 'Indigo · channel',
          feed: [{ sep: 'YESTERDAY' }, { who: 'Signal Agent', ai: true, when: '3:40 PM', card: { t: '3 new insight clusters', s: 'Setup friction, pricing questions, and a feature ask around Slack digests.', actions: ['Open insights'] } }],
        },
        'enterprise-pricing': {
          type: 'project', title: '# enterprise-pricing', sub: 'Indigo · project channel', people: ['Corey', 'Marcus'],
          status: { dot: 'w', label: 'Review waiting' },
          feed: [
            { sep: 'SATURDAY' },
            { who: 'Corey', av: 'C', when: '11:02 AM', text: 'Enterprise tier features aligned across console and marketing.' },
            { event: { who: 'Build Agent', what: 'opened PR #198 — enterprise tier', when: '11:28 AM', kind: 'pr' } },
            { who: 'Build Agent', ai: true, when: '11:30 AM', card: { t: 'US-010 ready for review', s: 'PR open, CI green. Waiting on you.', actions: ['Open PR'] } },
          ],
          board: { inprog: [], review: [['US-010 · enterprise tier', 'PR OPEN', 'warn']], done: [['US-009 · pricing table', 'SHIPPED', 'ok']] },
          files: [['file', 'pricing-matrix.xlsx', 'COREY · AUG 1']],
        },
      },
    },
    sender: {
      label: 'Sender Agency',
      short: 'SA',
      pinned: ['creative-pipeline'],
      days: [
        { label: 'TODAY', date: 'AUG 4', items: ['ramen-bae', 'ads-radar'] },
        { label: 'MONDAY', date: 'AUG 3', items: ['email-os'] },
      ],
      channels: {
        'creative-pipeline': {
          type: 'project', title: '# creative-pipeline', sub: 'Sender Agency · project channel', people: ['Kayla', 'Sofia'],
          status: { dot: 'ok', label: 'Agent running' },
          feed: [{ sep: 'TODAY' }, { who: 'Creative Agent', ai: true, when: 'RUNNING · 9:00 AM', card: { t: 'Weekly batch — 12 statics', s: '6 approved, 4 in iteration, 2 queued for review.', actions: ['Open batch'] } }],
          board: { inprog: [['CR-31 · statics batch', 'AGENT · 50%', 'ok']], review: [['CR-29 · UGC scripts', 'CLIENT REVIEW', 'warn']], done: [['CR-28 · hooks test', 'SHIPPED', 'ok']] },
          files: [['image', 'batch-31-preview.png', 'AGENT · TODAY']],
        },
        'ramen-bae': {
          type: 'channel', title: '# ramen-bae', sub: 'Sender Agency · client channel', unread: 1,
          feed: [{ sep: 'TODAY' }, { who: 'Kayla', av: 'K', when: '8:15 AM', text: 'July recap looks great — can we push the bundle angle harder in August?' }],
        },
        'ads-radar': {
          type: 'channel', title: '# ads-radar', sub: 'Sender Agency · channel',
          feed: [{ sep: 'TODAY' }, { who: 'Radar Agent', ai: true, when: '7:00 AM', card: { t: 'Competitor sweep', s: '3 new angles spotted in the ad library overnight.', actions: ['Open radar'] } }],
        },
        'email-os': {
          type: 'project', title: '# email-os', sub: 'Sender Agency · project channel', people: ['Kayla'],
          status: { dot: 'ok', label: 'Idle' },
          feed: [{ sep: 'MONDAY' }, { who: 'Email Agent', ai: true, when: '4:12 PM', card: { t: 'Flow refresh shipped', s: 'Welcome series v3 live for 2 brands.', actions: ['Open flows'] } }],
          board: { inprog: [], review: [], done: [['EM-14 · welcome v3', 'SHIPPED', 'ok']] },
          files: [['file', 'flow-map.md', 'AGENT · AUG 3']],
        },
      },
    },
    personal: {
      label: 'Personal',
      short: 'ME',
      pinned: ['book-tracker'],
      days: [
        { label: 'TODAY', date: 'AUG 4', items: ['reminders'] },
        { label: 'FRIDAY', date: 'JUL 31', items: ['estate-docs'] },
      ],
      channels: {
        'book-tracker': {
          type: 'project', title: '# book-tracker', sub: 'Personal · project channel', people: ['Corey'],
          status: { dot: 'ok', label: 'Idle' },
          feed: [{ sep: 'LAST WEEK' }, { who: 'Build Agent', ai: true, when: 'JUL 29', card: { t: 'Reading stats page shipped', s: '52 books logged this year.', actions: ['Open app'] } }],
          board: { inprog: [], review: [], done: [['BT-08 · stats page', 'SHIPPED', 'ok']] },
          files: [['file', 'reading-list.md', 'COREY · JUL 29']],
        },
        reminders: {
          type: 'channel', title: '# reminders', sub: 'Personal · channel', unread: 1,
          feed: [{ sep: 'TODAY' }, { who: 'Reminder Agent', ai: true, when: '8:00 AM', card: { t: '3 things today', s: 'Sauna service call, sign estate doc, dinner reservation at 7.', actions: ['Open list'] } }],
        },
        'estate-docs': {
          type: 'project', title: '# estate-docs', sub: 'Personal · project channel',
          status: { dot: 'w', label: 'Waiting on you' },
          feed: [{ sep: 'FRIDAY' }, { who: 'Docs Agent', ai: true, when: 'JUL 31', card: { t: 'Signature needed', s: 'One document waiting in the vault.', actions: ['Open vault'] } }],
          board: { inprog: [], review: [['ED-02 · trust update', 'WAITING', 'warn']], done: [] },
          files: [['file', 'trust-amendment.pdf', 'AGENT · JUL 31']],
        },
      },
    },
  });

  const LIBRARY = {
    cats: [
      ['files', 'Files', 412], ['knowledge', 'Knowledge', 128], ['docs', 'Docs & notes', 54],
      ['meetings', 'Meetings', 31], ['policies', 'Policies', 17], ['skills', 'Skills', 46], ['workers', 'Workers', 18],
    ] as [string, string, number][],
    items: {
      files: [['file', 'library-ia-v2.md', 'FILES · TODAY'], ['image', 'concept-a-daybook.png', 'MOCKUPS · TODAY'], ['file', 'pricing-matrix.xlsx', 'AUG 1'], ['file', 'brief-2026-08-03.html', 'AUG 3']],
      knowledge: [['knowledge', 'design-styles pack v3', 'UPDATED 2H AGO · SOFIA'], ['knowledge', 'pricing objection handling', 'YESTERDAY · BRYAN'], ['knowledge', 'agent-box provisioning guide', 'AUG 1 · AGENT']],
      docs: [['doc', 'library-ia-v2.md', 'SOFIA · TODAY'], ['doc', 'daybook-interaction-notes.md', 'COREY · TODAY']],
      meetings: [['meeting', 'GTM standup — Aug 4', 'RECAP + TRANSCRIPT'], ['meeting', 'Nestlé demo prep — Aug 1', 'NOTES']],
      policies: [['policy', 'deploy account mapping', 'HARD'], ['policy', 'tauri2 api detection', 'HARD'], ['policy', 'docs sync on material change', 'HARD']],
      skills: [['skill', '/storyboard', 'DESIGN GATE'], ['skill', '/deploy', 'SHIP ARTIFACTS'], ['skill', '/standup-brief', 'DAILY BRIEF'], ['skill', '/crm-management', 'GTM']],
      workers: [['worker', 'paper-designer', 'DESIGN'], ['worker', 'build-agent', 'ENGINEERING'], ['worker', 'signal-agent', 'INSIGHTS']],
    } as Record<string, string[][]>,
  };

  const MARKET: [string, string, string, string][] = [
    ['engineering', 'Investigate, review, land, ship — the full engineering loop.', 'inst', 'v2.1 INSTALLED'],
    ['design-styles', 'Brand packs and design tokens bound to deploys.', 'upd', 'v3.0 UPDATE'],
    ['parker', 'Creative iteration engine for short-form ads.', 'inst', 'v1.4 INSTALLED'],
    ['slack-bot', 'Run HQ agents inside your Slack workspace.', 'inst', 'v1.0 INSTALLED'],
    ['accounting', 'Books, categorization, and monthly close helpers.', 'get', 'Get'],
    ['secure-sidecar', 'Scoped secret access for untrusted workloads.', 'get', 'Get'],
  ];

  /* ═══════════ State ═══════════ */
  /** Company scope for the daybook list: 'all' aggregates every company. */
  let coFilter = $state<'all' | string>('all');
  /** Company owning the open channel (rows carry their company). */
  let activeCo = $state('indigo');
  let view = $state<'channel' | 'library' | 'marketplace' | 'sync' | 'settings' | 'history' | 'profile' | 'notifications'>('channel');
  let channelId = $state('hq-desktop');
  let tab = $state<'chat' | 'board' | 'files'>('chat');
  let libCat = $state('files');
  let openPanel = $state<string | null>(null);
  let packsOpen = $state(false);
  let sortMode = $state<'chrono' | 'type'>('chrono');
  /** One-click type scope instead of per-kind checkboxes. */
  let typeScope = $state<'all' | 'project' | 'people'>('all');
  /** Pastel two-colour tiles, one per company (Slack-style switcher). */
  const CO_TILES: Record<string, string> = {
    indigo: 'linear-gradient(135deg, #6d5efc 0%, #c86bf0 100%)',
    sender: 'linear-gradient(135deg, #ff9f43 0%, #ff5f6d 100%)',
    personal: 'linear-gradient(135deg, #12c2a0 0%, #7ad86b 100%)',
    LiveRecover: 'linear-gradient(135deg, #2f80ed 0%, #56ccf2 100%)',
    Keptwork: 'linear-gradient(135deg, #f2529b 0%, #f7b42c 100%)',
    'Holler Mgmt': 'linear-gradient(135deg, #0f8fa8 0%, #6a5af9 100%)',
  };
  const coShort = (label: string) => label.replace(/[^A-Za-z ]/g, '').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  const PEOPLE = ['Corey', 'Bryan', 'Sofia', 'Marcus', 'Priya', 'Kayla'];
  let peopleFilter = $state<Record<string, boolean>>({});
  const peopleSelected = $derived(PEOPLE.filter((p) => peopleFilter[p]));
  function resetFilters() {
    typeScope = 'all';
    peopleFilter = {};
    sortMode = 'chrono';
  }
  /** A group message is a DM with more than one peer; every # channel —
   *  project-backed or not — filters as one kind. */
  function rowKind(c: Channel): string {
    if (c.type === 'dm') return c.sub.includes('group') ? 'group' : 'dm';
    return 'project';
  }
  let search = $state('');
  /** Search lives in a centered jump palette (⌘K), not the sidebar. */
  let searchOpen = $state(false);
  let searchSel = $state(0);
  function openSearch() {
    searchOpen = true;
    search = '';
    searchSel = 0;
    openPanel = null;
    requestAnimationFrame(() => document.getElementById('v2-search')?.focus());
  }
  function closeSearch() {
    searchOpen = false;
    search = '';
  }
  const searchResults = $derived.by(() => {
    const q = search.trim().toLowerCase();
    const out: { co: string; id: string; c: Channel }[] = [];
    for (const [k, comp] of Object.entries(DATA)) {
      for (const [id, c] of Object.entries(comp.channels)) {
        if (!q || c.title.toLowerCase().includes(q)) out.push({ co: k, id, c });
      }
    }
    return out.slice(0, 12);
  });
  function pickResult(r: { co: string; id: string }) {
    selectChannel(r.co, r.id);
    closeSearch();
  }
  function searchKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') closeSearch();
    else if (e.key === 'ArrowDown') { e.preventDefault(); searchSel = Math.min(searchSel + 1, searchResults.length - 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); searchSel = Math.max(searchSel - 1, 0); }
    else if (e.key === 'Enter' && searchResults[searchSel]) pickResult(searchResults[searchSel]);
  }
  const EXTRA_COMPANIES: [string, string][] = [
    ['LR', 'LiveRecover'],
    ['KW', 'Keptwork'],
    ['HM', 'Holler Mgmt'],
  ];
  let composerText = $state('');

  /* ── Story detail ── */
  type Story = { title: string; sub: string; cls: string; col: string };
  let openStory = $state<Story | null>(null);
  /** Per-story detail; unknown stories fall back to a generic shape. */
  const STORY_DETAIL: Record<string, { who: string; desc: string; acs: [string, boolean][]; events: [string, string, string][] }> = {
    'US-002': {
      who: 'Desktop Agent',
      desc: 'Group the daybook sidebar by day so the most recent conversations sit on top, with older days folding away as they age.',
      acs: [
        ['Rows group under TODAY / YESTERDAY / weekday headers', true],
        ['Groups merge across companies when scope is All', true],
        ['Days older than a week collapse into Last week', false],
        ['Pinned rows stay above every day group', false],
      ],
      events: [
        ['Desktop Agent', 'started this run', '9:14 AM'],
        ['Desktop Agent', 'pushed 4 commits to feat/unified-shell', '9:22 AM'],
        ['Bryan', 'left a comment', '9:26 AM'],
      ],
    },
    'US-005': {
      who: 'Corey',
      desc: 'Fold Sync, Library, and Packs into a single Core dropdown so the title bar keeps one system-level entry point.',
      acs: [
        ['Core menu opens from the title bar', true],
        ['Packs expand inline inside the menu', true],
        ['Menu rows share one condensed row standard', false],
      ],
      events: [
        ['Corey', 'moved this to design review', '8:40 AM'],
        ['Corey', 'attached concept-a-daybook.png', '8:41 AM'],
      ],
    },
  };
  const GENERIC_DETAIL = {
    who: 'Unassigned',
    desc: 'No description yet — add one from the story panel or the CLI.',
    acs: [['Acceptance criteria not written yet', false]] as [string, boolean][],
    events: [['Build Agent', 'created this story', 'Aug 1']] as [string, string, string][],
  };
  const storyId = $derived(openStory ? openStory.title.split(' · ')[0] : '');
  const storyName = $derived(openStory ? openStory.title.split(' · ').slice(1).join(' · ') : '');
  const storyDetail = $derived(STORY_DETAIL[storyId] ?? GENERIC_DETAIL);
  /** Board columns are set in caps for the board; detail reads in prose. */
  const sentence = (v: string) => v.charAt(0) + v.slice(1).toLowerCase();

  /* ── Notifications ── */
  type Notif = {
    id: string;
    kind: 'mention' | 'run' | 'share' | 'dm' | 'review';
    who: string;
    av?: string;
    ai?: boolean;
    text: string;
    ctx: string;
    when: string;
    day: string;
    unread: boolean;
  };
  let notifs = $state<Notif[]>([
    { id: 'n1', kind: 'mention', who: 'Bryan', av: 'B', text: 'mentioned you in #hq-desktop', ctx: '@corey can we see the day groups collapse after a week?', when: '9:12 AM', day: 'TODAY', unread: true },
    { id: 'n2', kind: 'run', who: 'Desktop Agent', ai: true, text: 'finished US-004 · day-group collapse', ctx: '12 tests added, preview deployed', when: '9:31 AM', day: 'TODAY', unread: true },
    { id: 'n3', kind: 'review', who: 'Build Agent', ai: true, text: 'needs your review on US-010', ctx: 'enterprise-pricing · PR open, CI green', when: '9:48 AM', day: 'TODAY', unread: true },
    { id: 'n4', kind: 'share', who: 'Sofia', av: 'S', text: 'shared library-ia-v2.md', ctx: 'Indigo · Files', when: '10:02 AM', day: 'TODAY', unread: false },
    { id: 'n5', kind: 'dm', who: 'Bryan', av: 'B', text: 'sent you a message', ctx: 'Demo with the Nestlé team moved to Thursday.', when: '9:13 AM', day: 'TODAY', unread: false },
    { id: 'n6', kind: 'run', who: 'Fleet Agent', ai: true, text: 'flagged 1 box for storage autoscale', ctx: 'agent-orchestrator · nightly triage', when: '4:12 PM', day: 'YESTERDAY', unread: false },
    { id: 'n7', kind: 'mention', who: 'Marcus', av: 'M', text: 'mentioned you in #standup-brief', ctx: 'Linking the library IA doc from the project channel.', when: '2:20 PM', day: 'YESTERDAY', unread: false },
  ]);
  const NOTIF_ICONS = { mention: ChatCircle, run: User, share: FileText, dm: ChatCircle, review: GitPullRequest };
  let notifFilter = $state<'all' | 'unread'>('all');
  const unreadNotifs = $derived(notifs.filter((n) => n.unread).length);
  const shownNotifs = $derived(notifFilter === 'unread' ? notifs.filter((n) => n.unread) : notifs);
  const notifDays = $derived([...new Set(shownNotifs.map((n) => n.day))]);
  function readAll() {
    notifs = notifs.map((n) => ({ ...n, unread: false }));
    toast('All caught up');
  }

  /* ── Settings (split view) — desktop-app concerns only; everything else
     lives in HQ Console. Mirrors the production settings inventory. ── */
  const SETTINGS_TABS: [string, string][] = [
    ['general', 'General'],
    ['sync', 'Sync'],
    ['notifications', 'Notifications'],
    ['appearance', 'Appearance'],
    ['meetings', 'Meetings'],
    ['updates', 'Updates'],
  ];
  let settingsTab = $state('general');
  let prefs = $state<Record<string, boolean>>({
    login: true,
    dock: true,
    menubar: true,
    widget: true,
    syncOnLaunch: false,
    autoSync: true,
    instantSync: true,
    personalVault: true,
    agentDone: true,
    syncNotifs: true,
    shareNotifs: true,
    dmNotifs: true,
    quietHours: false,
    sounds: false,
    meetingDetect: true,
    autoUpdates: true,
  });
  let defaultCo = $state('indigo');
  let recordCo = $state('indigo');
  /** Your role in each company (Profile → Companies). */
  const CO_ROLES: Record<string, string> = {
    indigo: 'Owner',
    sender: 'Member',
    personal: 'Owner',
    LiveRecover: 'Member',
    Keptwork: 'Member',
    'Holler Mgmt': 'Owner',
  };
  /** Per-company sync switches (Profile → Companies). */
  let coSync = $state<Record<string, boolean>>({
    indigo: true,
    sender: true,
    personal: true,
    LiveRecover: true,
    Keptwork: false,
    'Holler Mgmt': false,
  });
  let themeChoice = $state<'system' | 'light' | 'dark'>('system');
  let uiSize = $state<'compact' | 'default' | 'large'>('default');
  let windowOpacity = $state(80);
  let meetPlatforms = $state<Record<string, boolean>>({ Zoom: true, 'Google Meet': true, Teams: false });
  let resolvedConflict = $state(false);
  let feedEl = $state<HTMLElement | null>(null);

  let toastMsg = $state('');
  let toastShown = $state(false);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  /** 'By type' sort regroups the daybook by kind instead of by day. */
  const sideByType = $derived.by(() => {
    const groups: { label: string; items: SideRow[] }[] = [
      { label: 'PROJECT CHANNELS', items: [] },
      { label: 'DMS', items: [] },
      { label: 'GROUPS', items: [] },
    ];
    for (const k of scopeKeys) {
      for (const [id, c] of Object.entries(DATA[k].channels)) {
        const kind = rowKind(c);
        (kind === 'project' ? groups[0] : kind === 'dm' ? groups[1] : groups[2]).items.push({ co: k, id });
      }
    }
    return groups.filter((g) => g.items.length > 0);
  });

  function toast(msg: string) {
    toastMsg = msg;
    toastShown = true;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastShown = false), 2200);
  }

  const company = $derived(DATA[activeCo]);
  const chan = $derived(company.channels[channelId] as Channel | undefined);
  const filterActive = $derived(typeScope !== 'all' || PEOPLE.some((p) => peopleFilter[p]) || sortMode !== 'chrono');
  /** Companies in the current daybook scope. */
  const scopeKeys = $derived(coFilter === 'all' ? Object.keys(DATA) : [coFilter]);

  type SideRow = { co: string; id: string };
  const sidePinned = $derived(
    scopeKeys.flatMap((k) => DATA[k].pinned.map((id) => ({ co: k, id }) as SideRow)),
  );
  /** Merge day groups across companies by date, newest first. */
  const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
  function dateRank(date: string): number {
    const [m, d] = date.split(' ');
    return (MONTHS[m] ?? 0) * 100 + (Number.parseInt(d, 10) || 0);
  }
  const sideDays = $derived.by(() => {
    const byDate = new Map<string, { label: string; date: string; items: SideRow[] }>();
    for (const k of scopeKeys) {
      for (const d of DATA[k].days) {
        const cur = byDate.get(d.date) ?? { label: d.label, date: d.date, items: [] };
        // Relative labels win over weekday names for the same date.
        if ((d.label === 'TODAY' || d.label === 'YESTERDAY') && cur.label !== 'TODAY') cur.label = d.label;
        cur.items.push(...d.items.map((id) => ({ co: k, id }) as SideRow));
        byDate.set(d.date, cur);
      }
    }
    return [...byDate.values()].sort((a, b) => dateRank(b.date) - dateRank(a.date));
  });

  function selectChannel(coKey: string, id: string) {
    view = 'channel';
    activeCo = coKey;
    channelId = id;
    tab = 'chat';
    const c = DATA[coKey].channels[id];
    if (c) delete c.unread;
    openPanel = null;
  }
  function nav(v: typeof view) {
    view = v;
    openPanel = null;
  }
  function togglePanel(id: string) {
    openPanel = openPanel === id ? null : id;
  }
  function rowVisible(coKey: string, id: string): boolean {
    const c = DATA[coKey].channels[id];
    if (!c) return false;
    const kind = rowKind(c);
    if (typeScope === 'project' && kind !== 'project') return false;
    if (typeScope === 'people' && kind === 'project') return false;
    if (peopleSelected.length > 0) {
      if (!c.people || !c.people.some((p) => peopleSelected.includes(p))) return false;
    }
    return true;
  }
  function sendMessage() {
    const text = composerText.trim();
    if (!text || !chan) return;
    const when = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (text.startsWith('/')) {
      chan.feed.push({ who: 'Build Agent', ai: true, when: 'QUEUED · ' + when, card: { t: text, s: 'Agent run queued — progress will stream here.' } });
    } else {
      chan.feed.push({ who: 'Corey', av: 'C', when, text });
    }
    composerText = '';
    requestAnimationFrame(() => {
      if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;
    });
  }
  function onWindowKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') openPanel = null;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openSearch();
    }
  }
  function onWindowClick(e: MouseEvent) {
    const t = e.target as HTMLElement;
    if (!t.closest('.panel') && !t.closest('[data-panel-trigger]')) openPanel = null;
  }
  const todayLabel = new Date()
    .toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
    .toUpperCase()
    .replace(',', ' ·');
</script>

<svelte:window onkeydown={onWindowKeydown} onclick={onWindowClick} />

<div class="v2" data-theme={theme}>
  <div class="titlebar">
    <div class="lights" aria-hidden="true"><span class="l-r"></span><span class="l-y"></span><span class="l-g"></span></div>
    <span class="brand">HQ</span>
    <span class="date mono">{todayLabel}</span>
    <button
      class="bar-ic"
      class:has-unread={unreadNotifs > 0}
      aria-label={unreadNotifs > 0 ? `Notifications, ${unreadNotifs} unread` : 'Notifications'}
      data-tip="Notifications"
      onclick={() => nav('notifications')}
    >
      <Bell size={15} />
    </button>
    <button class="core-btn" data-panel-trigger onclick={(e) => { e.stopPropagation(); togglePanel('core'); }}>
      <span class="dot"></span>Core <span class="caret"><CaretDown size={10} weight="bold" /></span>
    </button>
  </div>

  <div class="body">
    <!-- Daybook sidebar -->
    <div class="sidebar">
      <!-- Scope row: company picker on the left, search + filter icons on
           the right. Search opens the jump palette. -->
      <div class="scope-row">
        <button class="scope-btn" data-panel-trigger onclick={(e) => { e.stopPropagation(); togglePanel('scope'); }}>
          {#if coFilter === 'all'}
            <span class="co-tile all"><Stack size={11} weight="bold" /></span>
          {:else}
            <span class="co-tile" style={`background: ${CO_TILES[coFilter]}`}>{coShort(DATA[coFilter].label)}</span>
          {/if}
          <span class="scope-name">{coFilter === 'all' ? 'All' : DATA[coFilter].label}</span>
          <span class="caret"><CaretDown size={10} weight="bold" /></span>
        </button>
        <div class="scope-actions">
          <button class="bar-ic" aria-label="Search (⌘K)" onclick={openSearch}><MagnifyingGlass size={15} /></button>
          <button
            class="bar-ic"
            class:filter-on={openPanel === 'filter' || filterActive}
            aria-label="Filter conversations"
            data-panel-trigger
            onclick={(e) => { e.stopPropagation(); togglePanel('filter'); }}
          >
            <FunnelSimple size={15} />
          </button>
        </div>
      </div>

      <div class="side-scroll">
        {#snippet sideRow(r: SideRow)}
          {@const c = DATA[r.co].channels[r.id]}
          {#if c && rowVisible(r.co, r.id)}
            <button
              class="row"
              class:sel={view === 'channel' && activeCo === r.co && channelId === r.id}
              class:unread={!!c.unread}
              onclick={() => selectChannel(r.co, r.id)}
            >
              {#if c.type === 'dm'}
                <span class="av" class:group={rowKind(c) === 'group'}>{c.members ?? c.av ?? c.title[0]}</span>
              {:else}<span class="ico"><Hash size={13} /></span>{/if}
              <span class="name">{c.title.replace('# ', '')}</span>
              {#if c.unread}<span class="badge mono">{c.unread}</span>{:else if c.live}<span class="pulse"></span>{/if}
            </button>
          {/if}
        {/snippet}
        <div class="grp"><span class="t mono"><PushPin size={10} /> PINNED</span></div>
        {#each sidePinned as r (`${r.co}:${r.id}`)}
          {@render sideRow(r)}
        {/each}
        {#if sortMode === 'type'}
          {#each sideByType as g (g.label)}
            <div class="grp"><span class="t mono">{g.label}</span></div>
            {#each g.items as r (`${r.co}:${r.id}`)}
              {@render sideRow(r)}
            {/each}
          {/each}
        {:else}
          {#each sideDays as d (d.date)}
            <div class="grp"><span class="t mono">{d.label}</span><span class="d mono">{d.date}</span></div>
            {#each d.items as r (`${r.co}:${r.id}`)}
              {@render sideRow(r)}
            {/each}
          {/each}
        {/if}
        <button class="grp fold" onclick={() => toast('Last week would expand — 6 quiet conversations')}>
          <span class="t mono dim">LAST WEEK <CaretRight size={8} weight="bold" /></span>
        </button>
        <button class="hist" onclick={() => nav('history')}><span class="ico"><MagnifyingGlass size={14} /></span><span>Show all history…</span></button>
      </div>
      <div class="footer-divider" aria-hidden="true"></div>
      <button class="footer" data-panel-trigger onclick={(e) => { e.stopPropagation(); togglePanel('user'); }}>
        <span class="fav">C</span>
        <span class="footer-name">Corey</span>
        <span class="synced mono"><span class="sync-dot"></span>SYNCED</span>
        <span class="caret"><CaretDown size={10} weight="bold" /></span>
      </button>
    </div>

    <!-- Main -->
    <div class="main">
      {#if view === 'channel'}
        {#if chan}
          <div class="chan-head">
            <span class="chan-title">{chan.title}</span>
            <span class="chan-sub">{chan.sub}</span>
            {#if chan.type === 'project'}
              <div class="head-right">
                <div class="tabs">
                  {#each [['chat', 'Chat', ChatCircle], ['board', 'Board', Kanban], ['files', 'Files', FileText]] as [t, label, Icon] (t)}
                    <button class="tab" class:on={tab === t} onclick={() => (tab = t as typeof tab)}>
                      <Icon size={13} /> {label}
                    </button>
                  {/each}
                </div>
                {#if chan.status}
                  <button class="status-btn" aria-label="Members, agents, and project status" data-panel-trigger onclick={(e) => { e.stopPropagation(); togglePanel('status'); }}>
                    <User size={13} /> 7 <span class="caret"><CaretDown size={10} weight="bold" /></span>
                  </button>
                {/if}
              </div>
            {/if}
          </div>
          <div class="content">
            {#if tab === 'board'}
              <div class="board-wrap">
              {#if chan.board}
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                <div class="board" onclick={(e) => { if (!(e.target as HTMLElement).closest('.story')) openStory = null; }}>
                  {#each [['IN PROGRESS', chan.board.inprog], ['REVIEW', chan.board.review], ['DONE', chan.board.done]] as [name, items] (name)}
                    <div class="col">
                      <span class="colh mono">{name} · {(items as string[][]).length}</span>
                      {#each items as [t, s, cls] (t)}
                        <button class="story" class:dim={name === 'DONE'} onclick={() => (openStory = { title: t, sub: s, cls, col: name as string })}>
                          <span class="st">{t}</span>
                          <span class="ss mono" class:ok={cls === 'ok'} class:warn={cls === 'warn'}>{s}</span>
                        </button>
                      {/each}
                    </div>
                  {/each}
                </div>
              {:else}
                <div class="empty">No board — this is a plain channel.</div>
              {/if}
              {#if openStory}
                <aside class="story-panel" transition:slidePane>
                  <div class="sd-head">
                    <span class="sd-id mono">{storyId}</span>
                    <button class="sd-close" aria-label="Close story" onclick={() => (openStory = null)}><X size={13} weight="bold" /></button>
                  </div>
                  <div class="sd-title">{storyName}</div>
                  <div class="sd-status">
                    <span class="pill" class:inst={openStory.cls === 'ok'} class:upd={openStory.cls === 'warn'}>{openStory.sub}</span>
                  </div>

                  <p class="sd-desc">{storyDetail.desc}</p>

                  <div class="sd-meta">
                    {#each [['Status', sentence(openStory.col)], ['Assignee', storyDetail.who], ['Project', chan.title.replace('# ', '')], ['Branch', 'feat/unified-shell']] as [k, v] (k)}
                      <div class="sd-kv"><span class="sd-k mono">{k}</span><span class="sd-v">{v}</span></div>
                    {/each}
                  </div>

                  <div class="grp"><span class="t mono">ACCEPTANCE CRITERIA</span><span class="d mono">{storyDetail.acs.filter(([, done]) => done).length}/{storyDetail.acs.length}</span></div>
                  {#each storyDetail.acs as [text, done] (text)}
                    <div class="ac-row" class:done>
                      <span class="ac-mark">{#if done}<CheckCircle size={15} weight="fill" />{:else}<Circle size={15} />{/if}</span>
                      <span class="ac-text">{text}</span>
                    </div>
                  {/each}

                  <div class="grp"><span class="t mono">ACTIVITY</span></div>
                  {#each storyDetail.events as [who, what, when] (what)}
                    <div class="feed-event sd-event">
                      <span class="fe-ic"><User size={11} /></span>
                      <span class="fe-text"><span class="fe-who">{who}</span> {what}</span>
                      <span class="fe-when mono">{when}</span>
                    </div>
                  {/each}

                  <div class="sd-actions">
                    <button class="chip" onclick={() => toast('Story would open in the project channel')}>Open in channel</button>
                    <button class="chip g" onclick={() => toast('Diff would open')}>View changes</button>
                  </div>
                </aside>
              {/if}
              </div>
            {:else if tab === 'files'}
              {#if chan.files}
                <div class="listview">
                  {#each chan.files as [i, n, m] (n)}
                    {@const Glyph = GLYPHS[i] ?? FileText}
                    <button class="lrow" onclick={() => toast(`${n} would open`)}><span class="lrow-ic"><Glyph size={15} /></span><span class="fn">{n}</span><span class="fm mono">{m}</span></button>
                  {/each}
                </div>
              {:else}
                <div class="empty">No files shared here yet.</div>
              {/if}
            {:else}
              <div class="feed" bind:this={feedEl}>
                {#each chan.feed as m, i (i)}
                  {#if m.sep}
                    <div class="daysep"><hr /><span class="mono">{m.sep}</span><hr /></div>
                  {:else if m.event}
                    {@const EventIcon = EVENT_ICONS[m.event.kind]}
                    <div class="feed-event">
                      <span class="fe-ic"><EventIcon size={11} /></span>
                      <span class="fe-text"><span class="fe-who">{m.event.who}</span> {m.event.what}</span>
                      <span class="fe-when mono">{m.event.when}</span>
                    </div>
                  {:else}
                    <div class="msg">
                      {#if m.ai}<div class="pav ai"><User size={16} /></div>{:else}<div class="pav">{m.av}</div>{/if}
                      <div class="msg-body">
                        <div class="msg-head">
                          <span class="who" class:ai={m.ai}>{m.who}</span>
                          <span class="when" class:mono={m.ai}>{m.when}</span>
                        </div>
                        {#if m.text}<div class="body-txt">{m.text}</div>{/if}
                        {#if m.card}
                          <div class="card">
                            <span class="ct">{m.card.t}</span>
                            <span class="cs">{m.card.s}</span>
                            {#if m.card.actions?.length}
                              <div class="actions">
                                {#each m.card.actions as a, ai2 (a)}
                                  <button class="chip" class:g={ai2 > 0} onclick={() => toast(`${a} would open`)}>{a}</button>
                                {/each}
                              </div>
                            {/if}
                          </div>
                        {/if}
                        {#if m.file}
                          <div class="card filecard">
                            <span class="lrow-ic"><FileText size={15} /></span><span class="ct small">{m.file.n}</span><span class="cs mono tiny">{m.file.m}</span>
                          </div>
                        {/if}
                      </div>
                    </div>
                  {/if}
                {/each}
              </div>
              <div class="composer">
                <input
                  placeholder={`Message ${chan.title} — or type / to run an agent…`}
                  bind:value={composerText}
                  onkeydown={(e) => { if (e.key === 'Enter') sendMessage(); }}
                />
                <div class="composer-bar">
                  <button class="cmp-ic" aria-label="Attach a file" onclick={() => toast('File picker would open')}><Paperclip size={15} /></button>
                  <button class="cmp-ic" aria-label="Add emoji" onclick={() => toast('Emoji picker would open')}><Smiley size={15} /></button>
                  <button class="cmp-send" aria-label="Send message" onclick={sendMessage}><PaperPlaneRight size={13} weight="fill" /></button>
                </div>
              </div>
            {/if}
          </div>
        {:else}
          <div class="empty">Nothing here.</div>
        {/if}
      {:else if view === 'library'}
        <div class="chan-head">
          <button class="back-btn" onclick={() => nav('channel')}><ArrowLeft size={12} weight="bold" /> Back</button>
          <span class="chan-title">Library</span>
          <span class="chan-sub">{company.label} · everything in your HQ</span>
        </div>
        <div class="library">
          <div class="lib-nav">
            {#each LIBRARY.cats as [k, n, c] (k)}
              <button class="lib-cat" class:on={libCat === k} onclick={() => (libCat = k)}>{n}<span class="c mono">{c}</span></button>
            {/each}
          </div>
          <div class="lib-main">
            <div class="lib-head">
              <div class="search">
                <span class="lead"><MagnifyingGlass size={13} /></span>
                <input placeholder={`Search ${company.label}'s library — files, skills, workers…`} />
              </div>
            </div>
            <div class="listview">
              {#each LIBRARY.items[libCat] ?? [] as [i, n, m] (n)}
                {@const Glyph = GLYPHS[i] ?? FileText}
                <button class="lrow" onclick={() => toast(`${n} would open`)}><span class="lrow-ic"><Glyph size={15} /></span><span class="fn">{n}</span><span class="fm mono">{m}</span></button>
              {/each}
            </div>
          </div>
        </div>
      {:else if view === 'marketplace'}
        <div class="chan-head">
          <button class="back-btn" onclick={() => nav('channel')}><ArrowLeft size={12} weight="bold" /> Back</button>
          <span class="chan-title">Marketplace</span>
          <span class="chan-sub">packs & extensions for your HQ</span>
        </div>
        <div class="board-wrap">
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
          <div class="market" onclick={(e) => { if (!(e.target as HTMLElement).closest('.pack')) openPack = null; }}>
            {#each MARKET as [n, d, cls, label] (n)}
              <button class="pack" class:sel={openPack?.[0] === n} onclick={() => (openPack = [n, d, cls, label])}>
                <span class="pn">{n}</span><span class="pd">{d}</span>
                <div class="pf"><span class="pill mono {cls}">{label}</span></div>
              </button>
            {/each}
          </div>
          {#if openPack}
            {@const pack = PACK_DETAIL[openPack[0]] ?? { publisher: 'Community', updated: '—', includes: [], notes: 'No description yet.' }}
            <aside class="story-panel" transition:slidePane>
              <div class="sd-head">
                <span class="sd-id mono">PACK</span>
                <button class="sd-close" aria-label="Close pack" onclick={() => (openPack = null)}><X size={13} weight="bold" /></button>
              </div>
              <div class="sd-title">{openPack[0]}</div>
              {#if openPack[2] !== 'get'}
                <div class="sd-status"><span class="pill mono {openPack[2]}">{openPack[3]}</span></div>
              {/if}

              <p class="sd-desc">{pack.notes}</p>

              <div class="sd-meta">
                <div class="sd-kv"><span class="sd-k mono">Publisher</span><span class="sd-v">{pack.publisher}</span></div>
                <div class="sd-kv"><span class="sd-k mono">Updated</span><span class="sd-v">{pack.updated}</span></div>
              </div>

              <div class="grp"><span class="t mono">WHAT'S INSIDE</span><span class="d mono">{pack.includes.length}</span></div>
              {#each pack.includes as [kind, name] (name)}
                <div class="pk-row">
                  <span class="pk-ic">
                    {#if kind === 'skill'}<Lightning size={14} />{:else if kind === 'worker'}<UserCircle size={14} />{:else if kind === 'policy'}<ShieldCheck size={14} />{:else}<BookOpen size={14} />{/if}
                  </span>
                  <span class="pk-name">{name}</span>
                  <span class="pk-kind mono">{kind}</span>
                </div>
              {/each}

              <div class="sd-actions">
                {#if openPack[2] === 'get'}
                  <button class="upd-btn" onclick={() => toast(`${openPack?.[0]} would install`)}>Get pack</button>
                {:else if openPack[2] === 'upd'}
                  <button class="upd-btn" onclick={() => toast(`${openPack?.[0]} would update`)}>Update</button>
                  <button class="chip g" onclick={() => toast('Release notes would open')}>Release notes</button>
                {:else}
                  <button class="chip g" onclick={() => toast(`${openPack?.[0]} would be removed`)}>Remove</button>
                {/if}
              </div>
            </aside>
          {/if}
        </div>
      {:else if view === 'sync'}
        <div class="chan-head">
          <button class="back-btn" onclick={() => nav('channel')}><ArrowLeft size={12} weight="bold" /> Back</button>
          <span class="chan-title">Sync & conflicts</span>
          <span class="chan-sub">cloud state for this machine</span>
        </div>
        <div class="syncview">
          <div class="sync-card">
            <div class="sync-line strong"><span class="dot"></span> Sync healthy <span class="m mono">LAST FULL SYNC 2M AGO</span></div>
            <div class="sync-line">Vault <span class="m mono">1,204 FILES · UP TO DATE</span></div>
            <div class="sync-line">Companies <span class="m mono">3 ACTIVE · ALL CLEAN</span></div>
            <div class="sync-line">Journal <span class="m mono">STREAMING</span></div>
          </div>
          <div class="sync-card">
            <div class="sync-line strong"><span class="dot w"></span> 1 conflict needs you</div>
            <div class="conflict" class:resolved={resolvedConflict}>
              <span class="conflict-ic"><Warning size={15} /></span>
              <span class="conflict-path">companies/indigo/knowledge/pricing-notes.md — edited here and on cloud</span>
              <button class="chip" onclick={() => { resolvedConflict = true; toast('Keep local — conflict resolved'); }}>Keep local</button>
              <button class="chip g" onclick={() => { resolvedConflict = true; toast('Keep cloud — conflict resolved'); }}>Keep cloud</button>
            </div>
          </div>
          <div class="sync-card">
            <div class="sync-line strong">Versions</div>
            <div class="sync-line">HQ core <span class="mono ver">v0.10.43</span> <span class="mono okc">NO DRIFT</span></div>
            <div class="sync-line">Desktop app <span class="mono ver">v0.10.41</span> <button class="chip push-right" onclick={() => toast('Update would install v0.10.43')}>Check & update</button></div>
          </div>
        </div>
      {:else if view === 'settings'}
        <div class="chan-head">
          <button class="back-btn" onclick={() => nav('channel')}><ArrowLeft size={12} weight="bold" /> Back</button>
          <span class="chan-title">Settings</span>
          <span class="chan-sub">yours — moved here from the Core menu</span>
        </div>
        {#snippet setToggle(key: string, name: string, desc: string)}
          <div class="set-row">
            <div><div class="sn">{name}</div><div class="sd">{desc}</div></div>
            <button
              class="toggle"
              class:on={prefs[key]}
              role="switch"
              aria-checked={prefs[key]}
              aria-label={name}
              onclick={() => (prefs[key] = !prefs[key])}
            ></button>
          </div>
        {/snippet}
        {#snippet companySelect(panelId: string, value: string, name: string, desc: string, pick: (k: string) => void)}
          <div class="set-row">
            <div><div class="sn">{name}</div><div class="sd">{desc}</div></div>
            <div class="co-select-wrap push-right">
              <button class="co-select" data-panel-trigger onclick={(e) => { e.stopPropagation(); togglePanel(panelId); }}>
                {DATA[value].label}
                <span class="caret"><CaretDown size={10} weight="bold" /></span>
              </button>
              <div class="panel co-picker-panel" class:open={openPanel === panelId}>
                {#each Object.entries(DATA) as [key, c] (key)}
                  <button class="p-item" onclick={() => { pick(key); openPanel = null; }}>
                    {c.label}
                    <span class="p-check">{#if value === key}<Check size={12} weight="bold" />{/if}</span>
                  </button>
                {/each}
              </div>
            </div>
          </div>
        {/snippet}
        <div class="library">
          <div class="lib-nav">
            {#each SETTINGS_TABS as [k, label] (k)}
              <button class="lib-cat" class:on={settingsTab === k} onclick={() => (settingsTab = k)}>{label}</button>
            {/each}
          </div>
          <div class="lib-main">
            <div class="settings">
              {#if settingsTab === 'general'}
                {@render setToggle('login', 'Launch at login', 'Start HQ when you sign in to your Mac')}
                {@render setToggle('dock', 'Show in Dock', 'Keep HQ in the Dock and ⌘-Tab switcher')}
                {@render setToggle('menubar', 'Menubar quick access', 'Keep the compact popover in the menu bar')}
                {@render setToggle('widget', 'Desktop widget', 'Float the mini notifications widget on your desktop')}
                {@render companySelect('coPicker', defaultCo, 'Default company', 'Which company loads on launch', (k) => { defaultCo = k; toast(`${DATA[k].label} loads on launch now`); })}
              {:else if settingsTab === 'sync'}
                <div class="set-row">
                  <div><div class="sn">HQ folder</div><div class="sd mono">~/Documents/HQ</div></div>
                  <button class="chip push-right" onclick={() => toast('Folder picker would open')}>Change…</button>
                </div>
                {@render setToggle('syncOnLaunch', 'Sync on launch', 'Run a sync when the app starts')}
                {@render setToggle('autoSync', 'Auto-sync', 'Sync every few minutes in the background')}
                {@render setToggle('instantSync', 'Instant sync', 'Push local edits within seconds')}
                {@render setToggle('personalVault', 'Sync personal vault', 'Include personal HQ files in the fanout')}
              {:else if settingsTab === 'notifications'}
                {@render setToggle('agentDone', 'Agent completion', 'Ping when a run finishes or needs review')}
                {@render setToggle('syncNotifs', 'Sync notifications', 'Notify when sync needs attention')}
                {@render setToggle('shareNotifs', 'Share notifications', 'Show file-share activity from teammates')}
                {@render setToggle('dmNotifs', 'DM notifications', 'Show direct messages as they arrive')}
                {@render setToggle('quietHours', 'Quiet hours', 'Mute non-urgent notifications 6 PM – 8 AM')}
                {@render setToggle('sounds', 'Sound effects', 'Subtle sends & completion sounds')}
                <div class="set-row">
                  <div><div class="sn">System permission</div><div class="sd">Not enabled yet — allow HQ to post alerts</div></div>
                  <button class="upd-btn push-right" onclick={() => toast('macOS would ask for notification permission')}>Enable</button>
                </div>
              {:else if settingsTab === 'appearance'}
                <div class="set-row">
                  <div><div class="sn">Theme</div><div class="sd">Follow the system or pick one</div></div>
                  <div class="tabs push-right">
                    {#each [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']] as [k, label] (k)}
                      <button class="tab" class:on={themeChoice === k} onclick={() => (themeChoice = k as typeof themeChoice)}>{label}</button>
                    {/each}
                  </div>
                </div>
                <div class="set-row">
                  <div><div class="sn">Window opacity</div><div class="sd">How much desktop shows through the glass</div></div>
                  <div class="range-wrap push-right">
                    <input
                      type="range"
                      min="50"
                      max="100"
                      bind:value={windowOpacity}
                      style={`--fill: ${((windowOpacity - 50) / 50) * 100}%`}
                      aria-label="Window opacity"
                    />
                    <span class="mono range-val">{windowOpacity}%</span>
                  </div>
                </div>
                <div class="set-row">
                  <div><div class="sn">Interface size</div><div class="sd">Density of text and controls</div></div>
                  <div class="tabs push-right">
                    {#each [['compact', 'Compact'], ['default', 'Default'], ['large', 'Large']] as [k, label] (k)}
                      <button class="tab" class:on={uiSize === k} onclick={() => (uiSize = k as typeof uiSize)}>{label}</button>
                    {/each}
                  </div>
                </div>
              {:else if settingsTab === 'meetings'}
                {@render setToggle('meetingDetect', 'Meeting detection', 'Detect active meeting apps and surface recording actions')}
                <div class="set-row">
                  <div><div class="sn">Platforms</div><div class="sd">Which meeting apps are watched</div></div>
                  <div class="plat-row push-right">
                    {#each Object.keys(meetPlatforms) as p (p)}
                      <button class="chip" class:g={!meetPlatforms[p]} aria-pressed={meetPlatforms[p]} onclick={() => (meetPlatforms[p] = !meetPlatforms[p])}>{p}</button>
                    {/each}
                  </div>
                </div>
                {@render companySelect('recPicker', recordCo, 'Recording company', 'Attribution for new recordings — changeable per recording', (k) => { recordCo = k; toast(`New recordings attribute to ${DATA[k].label}`); })}
              {:else if settingsTab === 'updates'}
                {@render setToggle('autoUpdates', 'Automatic updates', 'Install app, HQ Core, and CLI updates in the background')}
                <div class="set-row">
                  <div><div class="sn">Desktop app</div><div class="sd mono">v0.10.41</div></div>
                  <button class="upd-btn push-right" onclick={() => toast('Update would download & install v0.10.43')}>Update</button>
                </div>
                <div class="set-row">
                  <div><div class="sn">HQ Core</div><div class="sd mono">v0.10.43</div></div>
                  <span class="mono okc push-right">Up to date</span>
                </div>
                <div class="set-row">
                  <div><div class="sn">HQ CLI</div><div class="sd mono">v5.31.0</div></div>
                  <span class="mono okc push-right">Up to date</span>
                </div>
              {/if}
            </div>
          </div>
        </div>
      {:else if view === 'notifications'}
        <div class="chan-head">
          <button class="back-btn" onclick={() => nav('channel')}><ArrowLeft size={12} weight="bold" /> Back</button>
          <span class="chan-title">Notifications</span>
          <span class="chan-sub">{unreadNotifs > 0 ? `${unreadNotifs} unread` : 'All caught up'}</span>
          <div class="head-right">
            <div class="tabs">
              {#each [['all', 'All'], ['unread', 'Unread']] as [k, label] (k)}
                <button class="tab" class:on={notifFilter === k} onclick={() => (notifFilter = k as typeof notifFilter)}>{label}</button>
              {/each}
            </div>
            <button class="btn-tertiary" disabled={unreadNotifs === 0} onclick={readAll}>Mark all read</button>
          </div>
        </div>
        <div class="notif-list">
          {#each notifDays as day (day)}
            <div class="grp"><span class="t mono">{day}</span></div>
            {#each shownNotifs.filter((n) => n.day === day) as n (n.id)}
              {@const NIcon = NOTIF_ICONS[n.kind]}
              <button
                class="notif"
                class:unread={n.unread}
                onclick={() => { n.unread = false; nav('channel'); }}
              >
                <span class="n-ava" class:ai={n.ai}>{#if n.ai}<User size={14} />{:else}{n.av}{/if}</span>
                <span class="n-body">
                  <span class="n-line"><span class="n-who">{n.who}</span> {n.text}</span>
                  <span class="n-ctx">{n.ctx}</span>
                </span>
                <span class="n-kind"><NIcon size={13} /></span>
                <span class="n-when mono">{n.when}</span>
                <span class="n-dot" aria-hidden="true"></span>
              </button>
            {/each}
          {/each}
          {#if shownNotifs.length === 0}
            <div class="empty">Nothing unread — you're all caught up.</div>
          {/if}
        </div>
      {:else if view === 'profile'}
        <div class="chan-head">
          <button class="back-btn" onclick={() => nav('channel')}><ArrowLeft size={12} weight="bold" /> Back</button>
          <span class="chan-title">Profile</span>
          <span class="chan-sub">how you appear across HQ</span>
        </div>
        <div class="settings profile">
          <!-- Identity card: the one place your name, handle, and avatar live. -->
          <div class="prof-card">
            <span class="prof-ava">C</span>
            <div class="prof-id">
              <div class="prof-name">Corey Epstein</div>
              <div class="prof-mail">corey@getindigo.ai</div>
            </div>
            <button class="chip push-right" onclick={() => toast('Photo picker would open')}>Change photo</button>
          </div>

          <div class="prof-sec mono">ABOUT YOU</div>
          <div class="set-row">
            <div><div class="sn">Display name</div><div class="sd">Shown on your messages and runs</div></div>
            <input class="prof-input push-right" value="Corey Epstein" aria-label="Display name" />
          </div>
          <div class="prof-sec mono">COMPANIES</div>
          {#each [...Object.entries(DATA).map(([k, c]) => [k, c.label, c.short] as [string, string, string]), ...EXTRA_COMPANIES.map(([short, label]) => [label, label, short] as [string, string, string])] as [key, label, short] (key)}
            <div class="set-row">
              <div class="co-row-id">
                <span class="co-row-ava">{short}</span>
                <span class="sn">{label}</span>
                <span class="pill role">{CO_ROLES[key] ?? 'Member'}</span>
              </div>
              <div class="co-row-sync push-right">
                <span class="sync-label" class:on={coSync[key]}>{coSync[key] ? 'Synced' : 'Local'}</span>
                <button
                  class="toggle"
                  class:on={coSync[key]}
                  role="switch"
                  aria-checked={coSync[key]}
                  aria-label={`Sync ${label}`}
                  onclick={() => { coSync[key] = !coSync[key]; toast(coSync[key] ? `${label} will sync here` : `${label} stopped syncing here`); }}
                ></button>
              </div>
            </div>
          {/each}

          <div class="prof-sec mono">ACCOUNT</div>
          <div class="set-row">
            <div><div class="sn">Email</div><div class="sd mono">corey@getindigo.ai</div></div>
            <span class="mono okc push-right">Verified</span>
          </div>
          <div class="set-row">
            <div><div class="sn">Manage account</div><div class="sd">Billing, teammates, and company settings live in HQ Console</div></div>
            <button class="chip push-right" onclick={() => toast('HQ Console would open in your browser')}>Open console <ArrowUpRight size={11} /></button>
          </div>
          <div class="set-row">
            <div><div class="sn">Sign out</div><div class="sd">Ends this session on this machine</div></div>
            <button class="chip g push-right" onclick={() => toast('Sign out')}>Sign out</button>
          </div>
        </div>
      {:else if view === 'history'}
        {@const histLabel = coFilter === 'all' ? 'All companies' : DATA[coFilter].label}
        <div class="chan-head">
          <button class="back-btn" onclick={() => nav('channel')}><ArrowLeft size={12} weight="bold" /> Back</button>
          <span class="chan-title">All history</span>
          <span class="chan-sub">{histLabel} · every conversation, ever</span>
        </div>
        <div class="lib-head hist-head">
          <div class="search">
            <span class="lead"><MagnifyingGlass size={13} /></span>
            <input placeholder={`Search all of ${histLabel}'s history…`} />
          </div>
        </div>
        <div class="listview">
          {#each scopeKeys as k (k)}
            {#each Object.entries(DATA[k].channels) as [id, c] (`${k}:${id}`)}
              <button class="lrow" onclick={() => selectChannel(k, id)}>
                <span class="lrow-ic">{#if c.type === 'dm'}<ChatCircle size={15} />{:else}<Hash size={15} />{/if}</span><span class="fn">{c.title.replace('# ', '')}</span><span class="fm mono">{coFilter === 'all' ? `${DATA[k].short} · ` : ''}{rowKind(c).toUpperCase()}</span>
              </button>
            {/each}
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <!-- Core dropdown -->
  <div class="panel core-panel" class:open={openPanel === 'core'}>
    <div class="p-card">
      <div class="p-line head"><span class="dot"></span> Sync healthy <span class="p-meta mono">2M AGO</span></div>
      <div class="p-line">HQ core <span class="v mono">v0.10.43</span> <span class="okc mono">NO DRIFT</span></div>
      <div class="p-line">Desktop app <span class="v mono">v0.10.41</span> <button class="upd-btn" onclick={() => toast('Update would download & install v0.10.43')}>Update</button></div>
    </div>
    <button class="p-item" onclick={() => nav('sync')}><span class="pi"><ArrowsDownUp size={14} /></span>Sync &amp; conflicts</button>
    <button class="p-item" onclick={() => nav('library')}><span class="pi"><Books size={14} /></span>Library — explore your HQ</button>
    <div class="packs-box" class:open={packsOpen}>
      <button class="p-item packs-toggle" onclick={(e) => { e.stopPropagation(); packsOpen = !packsOpen; }}>
        <span class="pi"><Package size={14} /></span><span class="packs-title">Packs</span>
        <span class="p-meta mono">4 INSTALLED {#if packsOpen}<CaretDown size={8} weight="bold" />{:else}<CaretRight size={8} weight="bold" />{/if}</span>
      </button>
      {#if packsOpen}
        <button class="sub-item" onclick={() => nav('marketplace')}>engineering<span class="p-meta mono">v2.1</span></button>
        <button class="sub-item" onclick={() => nav('marketplace')}>design-styles<span class="p-meta mono new">v3.0 · NEW</span></button>
        <button class="sub-item" onclick={() => nav('marketplace')}>parker<span class="p-meta mono">v1.4</span></button>
        <button class="sub-item muted" onclick={() => nav('marketplace')}>Open marketplace <ArrowRight size={11} /></button>
      {/if}
    </div>
  </div>

  <!-- Project status dropdown -->
  <div class="panel status-panel" class:open={openPanel === 'status'}>
    <div class="p-card">
      <div class="p-line head"><span class="dot"></span> Agent running <span class="p-meta mono">US-002 · 62%</span></div>
      <div class="p-line"><span class="progress"><span class="progress-fill" style="width:62%"></span></span><span class="p-meta mono">7/12 STORIES</span></div>
    </div>
    <div class="p-sec mono">PROJECT</div>
    <div class="p-item static kv"><span class="k">Branch</span><span class="mono val">feat/unified-shell</span></div>
    <div class="p-item static kv"><span class="k">Repo</span><span class="mono val">hq-desktop</span></div>
    <button class="p-item kv" onclick={() => toast('Preview would open')}><span class="k">Preview</span><span class="accent strong preview-link">hq-desktop-preview <ArrowUpRight size={11} weight="bold" /></span></button>
    <div class="p-sec mono">MEMBERS</div>
    {#each [['C', 'Corey'], ['B', 'Bryan'], ['S', 'Sofia'], ['M', 'Marcus'], ['P', 'Priya']] as [initial, name] (name)}
      <div class="p-item static">
        <span class="m-ava">{initial}</span>{name}
      </div>
    {/each}
    <div class="p-sec mono">AGENTS</div>
    {#each ['Desktop Agent', 'Build Agent'] as name (name)}
      <div class="p-item static">
        <span class="m-ava ai"><User size={11} /></span>{name}
      </div>
    {/each}
  </div>

  <!-- Company scope dropdown -->
  <div class="panel scope-panel" class:open={openPanel === 'scope'}>
    <button class="p-item co-row" class:current={coFilter === 'all'} onclick={() => { coFilter = 'all'; openPanel = null; }}>
      <span class="co-tile all"><Stack size={11} weight="bold" /></span>
      <span class="co-row-label">All companies</span>
      <span class="co-key mono">⌘0</span>
    </button>
    {#each [...Object.entries(DATA).map(([k, c]) => [k, c.label] as [string, string]), ...EXTRA_COMPANIES.map(([, label]) => [label, label] as [string, string])] as [key, label], i (key)}
      <button
        class="p-item co-row"
        class:current={coFilter === key}
        onclick={() => { if (DATA[key]) { coFilter = key; } else { toast(`${label} would load (not in prototype data)`); } openPanel = null; }}
      >
        <span class="co-tile" style={`background: ${CO_TILES[key] ?? 'linear-gradient(135deg, #94a3b8, #64748b)'}`}>{coShort(label)}</span>
        <span class="co-row-label">{label}</span>
        <span class="co-key mono">⌘{i + 1}</span>
      </button>
    {/each}
  </div>

  <!-- Filter dropdown: sort, type scope, and people in one menu -->
  <div class="panel filter-panel" class:open={openPanel === 'filter'}>
    <div class="fp-head">
      <span class="p-sec mono">SORT BY</span>
      {#if filterActive}
        <button class="fp-reset" onclick={resetFilters}>Reset</button>
      {/if}
    </div>
    <div class="fp-seg">
      {#each [['chrono', 'Recent', Clock], ['type', 'Type', Stack]] as [k, label, Icon] (k)}
        <button class="fp-seg-btn" class:on={sortMode === k} onclick={(e) => { e.stopPropagation(); sortMode = k as typeof sortMode; }}>
          <Icon size={12} /> {label}
        </button>
      {/each}
    </div>

    <span class="p-sec mono">SHOW</span>
    {#each [['all', 'All', Stack], ['project', 'Project channels', Hash], ['people', 'DMs & groups', ChatCircle]] as [k, label, Icon] (k)}
      <button class="p-item" onclick={(e) => { e.stopPropagation(); typeScope = k as typeof typeScope; }}>
        <span class="pi"><Icon size={14} /></span>{label}
        <span class="p-check">{#if typeScope === k}<Check size={12} weight="bold" />{/if}</span>
      </button>
    {/each}

    <div class="fp-head">
      <span class="p-sec mono">PEOPLE</span>
      {#if peopleSelected.length > 0}
        <button class="fp-reset" onclick={(e) => { e.stopPropagation(); peopleFilter = {}; }}>Clear</button>
      {/if}
    </div>
    {#each PEOPLE as person (person)}
      <button class="p-item" onclick={(e) => { e.stopPropagation(); peopleFilter[person] = !peopleFilter[person]; }}>
        <span class="pi"><span class="m-ava sm">{person[0]}</span></span>{person}{#if person === 'Corey'}<span class="p-dim you">you</span>{/if}
        <span class="p-check">{#if peopleFilter[person]}<Check size={12} weight="bold" />{/if}</span>
      </button>
    {/each}
  </div>

  <!-- Jump palette (⌘K) -->
  {#if searchOpen}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="search-overlay" onclick={(e) => { if (e.target === e.currentTarget) closeSearch(); }}>
      <div class="search-modal" role="dialog" aria-label="Search">
        <div class="sm-head">
          <MagnifyingGlass size={16} />
          <input
            id="v2-search"
            placeholder="Search or jump to…"
            bind:value={search}
            oninput={() => (searchSel = 0)}
            onkeydown={searchKeydown}
          />
          <button class="sd-close" aria-label="Close search" onclick={closeSearch}><X size={13} weight="bold" /></button>
        </div>
        <div class="sm-list">
          {#each searchResults as r, i (`${r.co}:${r.id}`)}
            <button class="sm-row" class:sel={i === searchSel} onmouseenter={() => (searchSel = i)} onclick={() => pickResult(r)}>
              <span class="sm-ic">
                {#if r.c.type === 'dm'}{#if rowKind(r.c) === 'group'}<span class="av">{r.c.members}</span>{:else}<span class="av">{r.c.av ?? r.c.title[0]}</span>{/if}{:else}<Hash size={14} />{/if}
              </span>
              <span class="sm-title">{r.c.title.replace('# ', '')}</span>
              <span class="sm-meta mono">{DATA[r.co].label}</span>
              {#if i === searchSel}<span class="sm-return"><KeyReturn size={14} /></span>{/if}
            </button>
          {/each}
          {#if searchResults.length === 0}
            <div class="sm-empty">No matches for “{search}”</div>
          {/if}
        </div>
      </div>
    </div>
  {/if}

  <div class="toast" class:show={toastShown}>{toastMsg}</div>
</div>

<style>
  /* ═══════════ Tokens — dark is home, light derived ═══════════ */
  .v2 {
    /* surfaces sit over the harness window glass, so they stay translucent */
    --window: transparent;
    --side-bg: rgba(0, 0, 0, 0.12);
    --ground: rgba(255, 255, 255, 0.02);
    --raised: rgba(255, 255, 255, 0.05);
    --btn-bg: rgba(255, 255, 255, 0.07);
    --elevated: #1e1e24;
    --panel-bg: rgba(44, 44, 54, 0.94);
    --panel-border: rgba(255, 255, 255, 0.1);
    /* Opaque stand-in for the frosted panel surface — facepile rings. */
    --panel-edge: #2b2b33;
    --border-active: rgba(255, 255, 255, 0.3);
    --line: rgba(255, 255, 255, 0.07);
    --line2: rgba(255, 255, 255, 0.11);
    --t1: #f4f4f6;
    --t2: #9a9aa2;
    --t3: #64646c;
    --ice: #c9d6e4;
    --ice-ink: #c9d6e4;
    --ice-tile: #2c3d52;
    --badge-fg: #101014;
    --ok: #34c759;
    --ok-ink: #4ade80;
    --warn: #facc15;
    --warn-ink: #facc15;
    --hover: rgba(255, 255, 255, 0.05);
    --sel: rgba(255, 255, 255, 0.08);
    --panel-shadow: 0 16px 40px rgba(0, 0, 0, 0.5);
    --font-ui: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --font-mono: 'Geist Mono', ui-monospace, Menlo, monospace;

    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--window);
    color: var(--t1);
    font: 400 13px/1.45 var(--font-ui);
  }

  .v2[data-theme='light'] {
    --side-bg: rgba(255, 255, 255, 0.18);
    --ground: rgba(255, 255, 255, 0.35);
    --raised: rgba(0, 0, 0, 0.035);
    --btn-bg: rgba(0, 0, 0, 0.045);
    --elevated: #ffffff;
    --panel-bg: rgba(252, 252, 253, 0.96);
    --panel-border: rgba(0, 0, 0, 0.07);
    --panel-edge: #f0f1f4;
    --border-active: rgba(0, 0, 0, 0.3);
    --line: rgba(0, 0, 0, 0.08);
    --line2: rgba(0, 0, 0, 0.12);
    --t1: #1d1d1f;
    --t2: #6e6e73;
    --t3: #a1a1a6;
    --ice: #c9d6e4;
    --ice-ink: #3e5a75;
    --ice-tile: #d3e0ee;
    --badge-fg: #ffffff;
    --ok: #34c759;
    --ok-ink: #248a3d;
    --warn: #f0a800;
    --warn-ink: #b45309;
    --hover: rgba(0, 0, 0, 0.045);
    --sel: rgba(0, 0, 0, 0.07);
    --panel-shadow: 0 16px 40px rgba(0, 0, 0, 0.18);
  }

  .mono { font-family: var(--font-mono); }

  /* Phosphor icons ride the text baseline inside labels. */
  .v2 :global(svg) { flex-shrink: 0; }
  .caret { display: inline-flex; align-items: center; color: var(--t3); }
  .lead { display: inline-flex; align-items: center; color: var(--t3); }
  .lrow-ic { display: inline-flex; align-items: center; color: var(--t2); }
  .conflict-ic { display: inline-flex; align-items: center; color: var(--warn-ink); }
  .sync-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); display: inline-block; margin-right: 5px; }
  .grp .t, .p-meta, .accent { display: inline-flex; align-items: center; gap: 4px; }

  /* Settings company selector: secondary-style select with a company tile. */
  .co-select { display: inline-flex; align-items: center; gap: 7px; background: var(--btn-bg); border: 1px solid transparent; border-radius: 8px; padding: 4px 10px; font-size: 12px; font-weight: 500; color: var(--t1); transition: opacity 0.12s; }
  .co-select:hover { opacity: 0.7; }
  .co-select-ava { display: flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 5px; background: var(--line2); font: 600 8px var(--font-ui); color: var(--t2); }
  .co-select-wrap { position: relative; }
  .co-picker-panel { bottom: calc(100% + 6px); right: 0; width: 210px; min-width: 0; padding: 6px; gap: 0; }
  .co-picker-panel .p-item { padding: 5px 8px; gap: 8px; font-size: 12px; }
  .co-picker-panel .p-item .pi { width: 18px; }
  /* :where keeps the reset at class-level specificity so component button
     styles below (.chip, .send, .core-btn, …) win on source order. */
  .v2 :where(button) { background: none; border: none; color: inherit; font: inherit; cursor: pointer; text-align: left; padding: 0; }

  /* ═══════════ Title bar ═══════════ */
  .titlebar { display: flex; align-items: center; gap: 12px; height: 48px; padding: 0 16px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
  .lights { display: flex; gap: 8px; }
  .lights span { width: 12px; height: 12px; border-radius: 50%; display: block; }
  .l-r { background: #ff5f57; } .l-y { background: #febc2e; } .l-g { background: #28c840; }
  .brand { font-weight: 600; margin-left: 8px; }
  .date { font-size: 10px; letter-spacing: 0.08em; color: var(--t3); font-weight: 400; }
  /* Standard secondary button: borderless fill at rest, border on hover. */
  .core-btn { margin-left: auto; display: flex; align-items: center; gap: 6px; background: var(--btn-bg); border: 1px solid transparent; border-radius: 8px; padding: 5px 10px; font-weight: 500; font-size: 12px; color: var(--t2); }
  .core-btn:hover { border-color: var(--line2); color: var(--t1); }
  .caret { color: var(--t3); font-size: 10px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); display: inline-block; flex-shrink: 0; }
  .dot.w { background: var(--warn); }

  .body { flex: 1; display: flex; min-height: 0; }

  /* ═══════════ Scope row (company picker + search/filter icons) ═══════════ */
  /* No inset — the tile's left edge lines up with the row buttons' box. */
  /* Sidebar header zone: its own height, content inset to the same line as
     the row icons below (rows are 8px-padded inside their own box). */
  .scope-row { display: flex; align-items: center; justify-content: space-between; gap: 6px; height: 28px; padding: 0; margin-bottom: 10px; flex-shrink: 0; }
  /* Naked, unpadded — the tile's left edge lines up with the row icons below.
     Hover just dims the label rather than drawing a box. */
  .scope-btn { display: inline-flex; align-items: center; gap: 6px; padding: 0; border-radius: 0; background: transparent; border: none; font-size: 13px; font-weight: 600; color: var(--t1); transition: opacity 0.12s; }
  .scope-btn:hover { opacity: 0.65; }
  .scope-actions { display: flex; gap: 2px; }
  /* Company tile: pastel gradient with the company's initials. */
  .co-tile { display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; flex-shrink: 0; border-radius: 7px; font: 700 9px var(--font-ui); color: #fff; letter-spacing: 0.02em; }
  .co-tile.all { background: var(--btn-bg); color: var(--t2); }
  .scope-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-ic.filter-on { color: var(--ice-ink); }

  /* ═══════════ Jump palette (⌘K) ═══════════ */
  .search-overlay { position: absolute; inset: 0; z-index: 90; display: flex; align-items: flex-start; justify-content: center; padding-top: 72px; background: rgba(0, 0, 0, 0.28); }
  .search-modal { display: flex; flex-direction: column; width: min(560px, 86%); max-height: 62%; overflow: hidden; background: var(--panel-bg); border: 1px solid var(--panel-border); border-radius: 12px; box-shadow: var(--panel-shadow); }
  .sm-head { display: flex; align-items: center; gap: 10px; padding: 13px 16px; border-bottom: 1px solid var(--line); color: var(--t3); flex-shrink: 0; }
  .sm-head input { flex: 1; min-width: 0; background: none; border: none; outline: none; color: var(--t1); font: 400 14px var(--font-ui); }
  .sm-head input::placeholder { color: var(--t3); }
  .sm-list { display: flex; flex-direction: column; gap: 1px; padding: 8px; overflow-y: auto; min-height: 0; }
  .sm-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; font-size: 13px; color: var(--t1); }
  .sm-row.sel { background: var(--hover); }
  .sm-ic { display: flex; align-items: center; justify-content: center; width: 18px; flex-shrink: 0; color: var(--t3); }
  .sm-ic .av { width: 16px; height: 16px; border-radius: 50%; background: var(--line2); font: 600 9px var(--font-ui); color: var(--t2); display: flex; align-items: center; justify-content: center; }
  .sm-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
  .sm-meta { flex-shrink: 0; font-size: 10px; color: var(--t3); }
  .sm-return { display: flex; align-items: center; flex-shrink: 0; color: var(--t3); }
  .sm-empty { padding: 24px 12px; text-align: center; font-size: 13px; color: var(--t3); }

  /* ═══════════ Sidebar ═══════════ */
  .sidebar { width: 280px; flex-shrink: 0; background: var(--side-bg); border-right: 1px solid var(--line); display: flex; flex-direction: column; padding: 7px 10px 10px; min-height: 0; }
  .search-row { display: flex; align-items: stretch; gap: 6px; margin-bottom: 10px; }
  /* Standard secondary surface: borderless fill, border on hover, brighter
     border while focused/pressed. */
  .search { display: flex; flex: 1; min-width: 0; align-items: center; gap: 8px; background: var(--btn-bg); border: 1px solid transparent; border-radius: 8px; padding: 7px 10px; }
  .search:hover { border-color: var(--line2); }
  .search:focus-within { border-color: var(--border-active); }
  .search input { flex: 1; min-width: 0; background: none; border: none; outline: none; color: var(--t1); font: 400 12px var(--font-ui); }
  .search input::placeholder { color: var(--t3); }
  .kbd { font-size: 10px; color: var(--t3); }
  .filter-btn { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; width: 32px; border: 1px solid transparent; border-radius: 8px; background: var(--btn-bg); color: var(--t2); }
  .filter-btn:hover { color: var(--t1); border-color: var(--line2); }
  .filter-btn:active { border-color: var(--border-active); }
  .filter-btn.on { color: var(--ice-ink); border-color: var(--ice-ink); }
  /* Thin, light scrollbar tucked against the pane edge (content keeps its
     gutter via the offsetting padding). */
  .side-scroll { flex: 1; overflow-y: auto; min-height: 0; margin-right: -8px; padding-right: 8px; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
  .side-scroll::-webkit-scrollbar { width: 4px; }
  .side-scroll::-webkit-scrollbar-track { background: transparent; }
  .side-scroll::-webkit-scrollbar-thumb { background: var(--line); border-radius: 999px; }
  .side-scroll::-webkit-scrollbar-thumb:hover { background: var(--line2); }
  .grp { display: flex; align-items: center; justify-content: space-between; padding: 12px 8px 4px; width: 100%; }
  .grp .t { font-size: 10px; font-weight: 600; letter-spacing: 0.1em; color: var(--t2); gap: 6px; }
  .grp .t.dim { color: var(--t3); }
  .grp .d { font-size: 10px; color: var(--t3); }
  .grp.fold:hover .t { color: var(--t1); }
  .row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; width: 100%; }
  .row:hover { background: var(--hover); }
  .row.sel { background: var(--sel); }
  .row .ico, .hist .ico { display: inline-flex; align-items: center; justify-content: center; width: 16px; flex-shrink: 0; color: var(--t3); }
  /* DM + group marks echo the thread avatars: rounded squares, not circles. */
  .row .av { width: 16px; height: 16px; flex-shrink: 0; border-radius: 50%; background: var(--line2); font: 600 9px var(--font-ui); color: var(--t2); display: flex; align-items: center; justify-content: center; }
  .row .name { flex: 1; min-width: 0; font-size: 13px; color: var(--t2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: left; }
  .row.unread .name { font-weight: 500; color: var(--t1); }
  /* Single digits render as a perfect 16px circle; longer counts grow into a pill. */
  .badge { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; min-width: 16px; height: 16px; margin-left: auto; flex-shrink: 0; font-size: 10px; font-weight: 500; line-height: 1; color: var(--badge-fg); background: var(--ice-ink); border-radius: 999px; padding: 0 5px; }
  /* Live dot occupies the badge's 16px box so both align down the column. */
  .pulse { display: flex; align-items: center; justify-content: center; box-sizing: border-box; min-width: 16px; height: 16px; margin-left: auto; flex-shrink: 0; }
  .pulse::after { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--ice-ink); animation: pulse-blink 1.6s ease-in-out infinite; }
  @keyframes pulse-blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.25; }
  }
  @media (prefers-reduced-motion: reduce) {
    .pulse::after { animation: none; }
  }
  .hist { display: flex; align-items: center; gap: 8px; padding: 6px 8px; margin-top: 8px; color: var(--t2); font-weight: 500; font-size: 12px; border-radius: 8px; width: 100%; }
  .hist:hover { background: var(--hover); }
  .footer-divider { height: 1px; margin-top: 8px; background: var(--line); flex-shrink: 0; }
  /* Hover reads as a clean rounded pill under the divider, secondary-style. */
  .footer { display: flex; align-items: center; gap: 8px; padding: 8px; margin-top: 6px; width: 100%; border-radius: 8px; transition: background 0.12s; }
  .footer:hover { background: var(--hover); }
  .footer:hover .footer-name { color: var(--t1); }
  .footer:hover .caret { color: var(--t2); }
  .footer .fav { width: 22px; height: 22px; border-radius: 50%; background: var(--line2); font: 600 10px var(--font-ui); color: var(--t1); display: flex; align-items: center; justify-content: center; }
  .footer-name { font-weight: 500; font-size: 12px; color: var(--t2); }
  .synced { margin-left: auto; font-size: 10px; color: var(--ok-ink); }

  /* ═══════════ Main ═══════════ */
  .main { flex: 1; background: var(--ground); display: flex; flex-direction: column; min-width: 0; position: relative; }
  .chan-head { display: flex; align-items: center; gap: 10px; height: 52px; padding: 0 20px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
  .chan-title { font-weight: 600; font-size: 15px; white-space: nowrap; }
  .chan-sub { font-size: 12px; color: var(--t3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .head-right { display: flex; align-items: center; gap: 12px; margin-left: auto; }
  .tabs { display: flex; gap: 2px; background: var(--raised); border: none; border-radius: 8px; padding: 2px; }
  .tab { display: inline-flex; align-items: center; gap: 5px; font-weight: 500; font-size: 12px; color: var(--t2); padding: 4px 10px; border-radius: 6px; transition: color 0.12s; }
  .tab:hover { color: var(--t1); }
  .tab.on { color: var(--t1); background: var(--sel); }
  .status-btn { display: flex; align-items: center; gap: 6px; background: var(--btn-bg); border: 1px solid transparent; border-radius: 8px; padding: 5px 12px; font-weight: 500; font-size: 12px; color: var(--t2); white-space: nowrap; }
  .status-btn:hover { border-color: var(--line2); color: var(--t1); }
  .back-btn { display: flex; align-items: center; gap: 6px; font-weight: 500; font-size: 12px; color: var(--t2); border: 1px solid var(--line2); border-radius: 8px; padding: 5px 10px; }
  .back-btn:hover { background: var(--hover); color: var(--t1); }

  .content { flex: 1; display: flex; flex-direction: column; min-height: 0; }

  /* ═══════════ Feed ═══════════ */
  .feed { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 18px; padding: 24px 24px 12px; min-height: 0; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
  .feed::-webkit-scrollbar { width: 4px; }
  .feed::-webkit-scrollbar-track { background: transparent; }
  .feed::-webkit-scrollbar-thumb { background: var(--line); border-radius: 999px; }
  .feed::-webkit-scrollbar-thumb:hover { background: var(--line2); }
  .daysep { display: flex; align-items: center; gap: 12px; }
  .daysep hr { flex: 1; border: none; height: 1px; background: var(--line); margin: 0; }
  .daysep span { font-size: 10px; font-weight: 500; letter-spacing: 0.08em; color: var(--t3); }
  /* Inline thread event: one quiet 11px line — dimmed icon on the avatar
     column, everything in the faintest ink so it reads as connective tissue,
     not another message. */
  .feed-event { display: flex; align-items: center; gap: 12px; margin: -8px 0; }
  .fe-ic { display: flex; align-items: center; justify-content: center; width: 32px; flex-shrink: 0; color: var(--t3); opacity: 0.7; }
  .fe-text { flex: 1; font-size: 11px; color: var(--t3); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fe-who { font-weight: 500; }
  .fe-when { flex-shrink: 0; margin-left: auto; font-size: 10px; color: var(--t3); opacity: 0; transition: opacity 0.12s; }
  .feed-event:hover .fe-when { opacity: 1; }

  .msg { display: flex; gap: 12px; }
  .msg-body { min-width: 0; flex: 1; }
  .pav { width: 32px; height: 32px; flex-shrink: 0; border-radius: 50%; background: var(--line2); display: flex; align-items: center; justify-content: center; font: 600 12px var(--font-ui); }
  /* Agent avatar: blue tint distinguishes it from humans; no ring, so it
     doesn't read as a selected control. */
  .pav.ai { background: var(--ice-tile); border: none; font-size: 10px; font-weight: 600; color: var(--ice-ink); }
  .msg-head { display: flex; align-items: baseline; gap: 8px; }
  .who { font-weight: 600; font-size: 13px; }
  .who.ai { color: var(--ice-ink); }
  /* Timestamps ride the right edge in Geist Mono, revealed on row hover. */
  .when { font-family: var(--font-mono); font-size: 10px; color: var(--t3); margin-left: auto; flex-shrink: 0; opacity: 0; transition: opacity 0.12s; }
  .msg:hover .when { opacity: 1; }
  .body-txt { font-size: 13px; color: var(--t2); line-height: 19px; margin-top: 3px; }
  .v2[data-theme='dark'] .body-txt { color: #c6c6cc; }
  .card { display: flex; flex-direction: column; gap: 6px; background: var(--raised); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; margin-top: 6px; }
  .card .ct { font-weight: 500; font-size: 13px; }
  .card .ct.small { font-size: 12px; }
  .card .cs { font-size: 12px; color: var(--t2); }
  .card .cs.tiny { font-size: 10px; }
  .card.filecard { align-self: flex-start; flex-direction: row; align-items: center; gap: 8px; padding: 8px 12px; }
  .actions { display: flex; gap: 8px; margin-top: 4px; }
  /* ── Small button standard ──
     secondary small (.chip): standard secondary, smaller — fill, no border,
       border on hover, brighter border on press.
     tertiary small (.chip.g): border, no fill; slight fill on hover.
     primary small (.upd-btn): standard primary, smaller. */
  .chip { font-weight: 500; font-size: 11px; color: var(--t1); background: var(--btn-bg); border: 1px solid transparent; border-radius: 6px; padding: 3px 10px; }
  .chip:hover { border-color: var(--line2); }
  .chip:active { border-color: var(--border-active); }
  .chip.g { color: var(--t2); background: transparent; border-color: var(--line2); }
  .chip.g:hover { background: var(--hover); color: var(--t1); border-color: var(--line2); }
  /* Two-row composer: input on top, action bar (attach · emoji … send) below. */
  .composer { flex-shrink: 0; margin: 12px 24px 20px; display: flex; flex-direction: column; align-items: stretch; gap: 6px; background: var(--raised); border: 1px solid var(--line2); border-radius: 10px; padding: 12px 8px 8px 14px; transition: border-color 0.12s; }
  .composer:focus-within { border-color: var(--border-active); }
  /* Nudge the text to sit on the icon glyphs' optical left edge. */
  .composer input { width: 100%; min-width: 0; margin-left: -3px; background: none; border: none; outline: none; color: var(--t1); font: 400 13px var(--font-ui); }
  .composer input::placeholder { color: var(--t3); }
  /* Pull the bar left of the text inset: button boxes get an 8px edge gutter
     (matching the bottom), which lands the glyphs on the text's 14px line. */
  .composer-bar { display: flex; align-items: center; gap: 2px; margin-left: -6px; }
  .cmp-ic { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 6px; color: var(--t3); transition: color 0.12s, background 0.12s; }
  .cmp-ic:hover { color: var(--t1); background: var(--hover); }
  /* Send: primary small icon button. */
  .cmp-send { display: grid; place-items: center; width: 28px; height: 26px; margin-left: auto; border-radius: 6px; background: var(--ice-ink); color: var(--badge-fg); transition: opacity 0.15s, transform 0.1s; }
  .cmp-send:hover { opacity: 0.88; }
  .cmp-send:active { transform: scale(0.95); }

  /* ═══════════ Board ═══════════ */
  .board { flex: 1; display: flex; gap: 14px; padding: 20px; overflow: auto; }
  .col { flex: 1; min-width: 200px; display: flex; flex-direction: column; gap: 10px; align-items: stretch; }
  .colh { font-size: 10px; font-weight: 600; letter-spacing: 0.1em; color: var(--t2); }
  .story { display: flex; flex-direction: column; gap: 6px; background: var(--raised); border: 1px solid var(--line); border-radius: 10px; padding: 12px; width: 100%; transition: background 0.12s, border-color 0.12s; }
  .story:hover { background: var(--btn-bg); border-color: var(--line2); }
  .story .st { font-weight: 500; font-size: 13px; }
  .story .ss { font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--t2); }
  .story .ss.ok { color: var(--ok-ink); }
  .story .ss.warn { color: var(--warn-ink); }
  .story.dim { opacity: 0.65; }

  /* ═══════════ Lists / library / market ═══════════ */
  /* 16px pad + 4px always-reserved scrollbar gutter = the heads' 20px inset. */
  /* No scrollbar-width here — it would override the 4px webkit bar and widen
     the reserved gutter. 8px margin + 4px gutter + 8px padding keeps the rows
     on the heads' 20px edge while the bar floats 8px off the pane edge,
     matching the side pane's scrollbar. */
  .listview { flex: 1; margin-right: 8px; padding: 20px 8px 20px 20px; display: flex; flex-direction: column; gap: 8px; overflow: auto; scrollbar-gutter: stable; }
  .listview::-webkit-scrollbar { width: 4px; }
  .listview::-webkit-scrollbar-track { background: transparent; }
  .listview::-webkit-scrollbar-thumb { background: var(--line); border-radius: 999px; }
  .listview::-webkit-scrollbar-thumb:hover { background: var(--line2); }
  .lrow { display: flex; align-items: center; gap: 10px; background: var(--raised); border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; width: 100%; transition: background 0.12s, border-color 0.12s; }
  .lrow:hover { background: var(--btn-bg); border-color: var(--line2); }
  .lrow .fn { font-weight: 500; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lrow .fm { margin-left: auto; flex-shrink: 0; font-size: 10px; color: var(--t3); }

  .library { flex: 1; display: flex; min-height: 0; }
  .lib-nav { width: 210px; flex-shrink: 0; border-right: 1px solid var(--line); padding: 16px 10px; display: flex; flex-direction: column; gap: 2px; overflow: auto; }
  .lib-cat { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 8px; font-size: 13px; color: var(--t2); width: 100%; }
  .lib-cat:hover { background: var(--hover); }
  .lib-cat.on { background: var(--sel); color: var(--t1); font-weight: 500; }
  .lib-cat .c { margin-left: auto; font-size: 10px; color: var(--t3); }
  .lib-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  /* Right padding = listview's 16px + the 4px reserved scrollbar gutter, so
     the search bar and the rows share one right edge. */
  .lib-head { display: flex; align-items: center; gap: 10px; padding: 16px 20px 4px; }
  /* A search head above a list pulls the list closer (12px total gap). */
  .lib-main .listview, .lib-head + .listview { padding-top: 8px; }

  .market { flex: 1; min-width: 0; padding: 20px; overflow: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 14px; align-content: start; }
  .pack { display: flex; flex-direction: column; gap: 8px; background: var(--raised); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
  .pack:hover { background: var(--btn-bg); border-color: var(--line2); }
  .pack .pn { font-weight: 600; font-size: 14px; }
  .pack .pd { font-size: 12px; color: var(--t2); line-height: 17px; flex: 1; }
  .pack .pf { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
  /* Neutral is the base: light border + faint fill, like the tinted variants. */
  .pill { font-size: 10px; font-weight: 500; border-radius: 6px; padding: 2px 8px; border: 1px solid color-mix(in srgb, var(--t1) 12%, transparent); background: var(--btn-bg); color: var(--t2); }
  /* Status tags: light tint fill + light border, toned ink. */
  .pill.inst { color: var(--ok-ink); border: 1px solid color-mix(in srgb, var(--ok) 35%, transparent); background: color-mix(in srgb, var(--ok) 10%, transparent); }
  .pill.upd { color: var(--warn-ink); border: 1px solid color-mix(in srgb, var(--warn) 35%, transparent); background: color-mix(in srgb, var(--warn) 10%, transparent); }
  /* Get = standard secondary small. */
  .pill.get { font-family: var(--font-ui); font-size: 11px; font-weight: 500; color: var(--t1); background: var(--btn-bg); border: 1px solid transparent; border-radius: 6px; padding: 3px 10px; cursor: pointer; transition: border-color 0.12s; }
  .pill.get:hover { border-color: var(--line2); }
  .pill.get:active { border-color: var(--border-active); }

  /* ═══════════ Sync ═══════════ */
  .syncview { flex: 1; padding: 20px; display: flex; flex-direction: column; gap: 12px; overflow: auto; }
  .sync-card { display: flex; flex-direction: column; gap: 10px; background: var(--raised); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
  .sync-line { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--t2); }
  .v2[data-theme='dark'] .sync-line { color: #c6c6cc; }
  .sync-line.strong { font-weight: 500; color: var(--t1); }
  .sync-line .m { margin-left: auto; font-size: 10px; color: var(--t3); }
  .sync-line .ver { font-size: 11px; color: var(--t2); }
  .sync-line .okc { font-size: 10px; color: var(--ok-ink); }
  .push-right { margin-left: auto; }
  .conflict { display: flex; align-items: center; gap: 10px; background: color-mix(in srgb, var(--warn) 8%, transparent); border: 1px solid color-mix(in srgb, var(--warn) 30%, transparent); border-radius: 10px; padding: 10px 14px; transition: opacity 0.2s; }
  .conflict.resolved { opacity: 0.4; pointer-events: none; }
  .conflict-path { font-size: 12px; color: var(--warn-ink); flex: 1; }

  /* ═══════════ Settings ═══════════ */
  .settings { flex: 1; padding: 20px; display: flex; flex-direction: column; gap: 10px; overflow: auto; }
  .set-row { display: flex; align-items: center; gap: 12px; background: var(--raised); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .set-row .sn { font-weight: 500; font-size: 13px; }
  .set-row .sd { font-size: 11px; color: var(--t3); margin-top: 2px; }
  /* Settings controls beyond toggles: opacity slider, platform chips,
     inline "Up to date" status. */
  /* macOS-style slider: thin filled track, small floating knob. */
  .range-wrap { display: flex; align-items: center; gap: 10px; }
  .range-wrap input[type='range'] {
    appearance: none;
    -webkit-appearance: none;
    width: 140px;
    height: 4px;
    border-radius: 999px;
    background: linear-gradient(to right, var(--ice-ink) var(--fill, 60%), var(--line2) var(--fill, 60%));
    outline: none;
  }
  .range-wrap input[type='range']::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    border: none;
    border-radius: 50%;
    background: #ffffff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
    cursor: pointer;
  }
  .range-wrap input[type='range']::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border: none;
    border-radius: 50%;
    background: #ffffff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
    cursor: pointer;
  }
  .range-val { font-size: 10px; color: var(--t3); min-width: 32px; text-align: right; }
  .plat-row { display: flex; gap: 6px; }
  .okc { font-size: 10px; color: var(--ok-ink); }
  .set-row .sd.mono { font-size: 11px; }

  /* ── Story detail (right side panel; board stays visible) ── */
  .board-wrap { flex: 1; display: flex; min-height: 0; overflow: hidden; }
  .board-wrap > .board { flex: 1; min-width: 0; }
  /* A real pane, styled exactly like the daybook sidebar: side tint, one
     hairline edge, no shadow — it takes space rather than floating over. */
  .story-panel {
    flex: 0 0 auto;
    width: 340px;
    display: flex;
    flex-direction: column;
    padding: 16px 20px 20px;
    overflow: auto;
    background: var(--side-bg);
    border-left: 1px solid var(--line);
  }
  .sd-head { display: flex; align-items: center; gap: 10px; }
  .sd-id { font-size: 11px; color: var(--t3); }
  .sd-close { display: grid; place-items: center; width: 24px; height: 24px; margin-left: auto; border-radius: 6px; color: var(--t3); transition: color 0.12s, background 0.12s; }
  .sd-close:hover { color: var(--t1); background: var(--hover); }
  .sd-title { margin-top: 6px; font-size: 15px; font-weight: 600; line-height: 1.3; color: var(--t1); }
  .sd-status { margin-top: 8px; }
  .sd-desc { margin: 14px 0 0; font-size: 13px; line-height: 20px; color: var(--t2); }
  /* Meta reads as a quiet key/value strip, not another card stack. */
  .sd-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 16px; margin-top: 16px; padding: 14px 16px; border-radius: 10px; background: var(--raised); }
  .sd-kv { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .sd-k { font-size: 9px; letter-spacing: 0.1em; color: var(--t3); text-transform: uppercase; }
  .sd-v { font-size: 12px; color: var(--t1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .story-panel .grp { padding: 18px 2px 6px; }
  /* Mark sits on the first text line, not centered on a wrapped block. */
  .ac-row { display: flex; align-items: flex-start; gap: 10px; padding: 3px 2px; }
  .ac-mark { display: flex; align-items: center; height: 20px; flex-shrink: 0; color: var(--t3); }
  .ac-row.done .ac-mark { color: var(--ok-ink); }
  .ac-text { font-size: 13px; line-height: 20px; color: var(--t2); }
  .ac-row.done .ac-text { color: var(--t3); text-decoration: line-through; }
  .sd-event { margin: 0; padding: 3px 0; gap: 10px; }
  .sd-event .fe-ic { width: 15px; }
  .sd-actions { display: flex; gap: 8px; margin-top: 22px; }
  /* Pack contents list — mirrors the criteria rhythm. */
  .pk-row { display: flex; align-items: center; gap: 10px; padding: 4px 2px; }
  .pk-ic { display: flex; align-items: center; flex-shrink: 0; color: var(--t3); }
  .pk-name { flex: 1; min-width: 0; font-size: 13px; color: var(--t2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pk-kind { flex-shrink: 0; font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--t3); }
  .pack.sel { border-color: var(--ice-ink); }

  /* ── Notifications ── */
  /* Naked icon button for the title bar; a dot marks unread. */
  .bar-ic { position: relative; display: grid; place-items: center; width: 28px; height: 28px; margin-left: auto; border-radius: 8px; color: var(--t2); transition: color 0.12s, background 0.12s; }
  .bar-ic:hover { color: var(--t1); background: var(--hover); }
  /* ::before, not ::after — ::after belongs to the shared tooltip. */
  .bar-ic.has-unread::before { content: ''; position: absolute; top: 5px; right: 5px; width: 6px; height: 6px; border-radius: 50%; background: var(--ice-ink); z-index: 1; }
  /* The bell takes over auto-margin duty from Core; 12px flex gap + 4px = 16. */
  .titlebar .bar-ic + .core-btn { margin-left: 4px; }

  .notif-list { flex: 1; padding: 12px 20px 20px; display: flex; flex-direction: column; overflow: auto; }
  .notif-list .grp { padding: 14px 2px 4px; }
  .notif { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px 12px; border-radius: 10px; border: 1px solid transparent; transition: background 0.12s, border-color 0.12s; }
  .notif:hover { background: var(--btn-bg); border-color: var(--line2); }
  .n-ava { display: flex; align-items: center; justify-content: center; width: 30px; height: 30px; flex-shrink: 0; border-radius: 50%; background: var(--line2); font: 600 11px var(--font-ui); color: var(--t1); }
  .n-ava.ai { background: var(--ice-tile); color: var(--ice-ink); }
  .n-body { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; text-align: left; }
  .n-line { font-size: 13px; color: var(--t2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .n-who { font-weight: 600; color: var(--t1); }
  .n-ctx { font-size: 12px; color: var(--t3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .n-kind { display: flex; align-items: center; flex-shrink: 0; color: var(--t3); opacity: 0.7; }
  .n-when { flex-shrink: 0; font-size: 10px; color: var(--t3); }
  /* Unread: brighter copy plus an accent dot in a reserved column. */
  .n-dot { width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%; background: transparent; }
  .notif.unread .n-line { color: var(--t1); }
  .notif.unread .n-dot { background: var(--ice-ink); }
  /* Standard tertiary button — matches the segmented control's height. */
  .btn-tertiary { display: inline-flex; align-items: center; height: 31px; padding: 0 12px; border: 1px solid var(--line2); border-radius: 8px; background: transparent; font-size: 12px; font-weight: 500; color: var(--t2); transition: background 0.12s, color 0.12s; }
  .btn-tertiary:hover:not(:disabled) { background: var(--hover); color: var(--t1); }
  .btn-tertiary:disabled { opacity: 0.45; cursor: default; }

  .chip:disabled { opacity: 0.45; cursor: default; }
  .chip:disabled:hover { background: transparent; border-color: var(--line2); color: var(--t2); }

  /* ── Profile ── */
  .prof-card { display: flex; align-items: center; gap: 14px; background: var(--raised); border-radius: 10px; padding: 16px; }
  .prof-ava { display: flex; align-items: center; justify-content: center; width: 52px; height: 52px; flex-shrink: 0; border-radius: 14px; background: var(--line2); font: 600 20px var(--font-ui); color: var(--t1); }
  .prof-id { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .prof-name { font-size: 15px; font-weight: 600; color: var(--t1); }
  .prof-mail { font-size: 12px; color: var(--t3); }
  .prof-tags { display: flex; gap: 6px; margin-top: 4px; }
  .prof-sec { font-size: 9px; font-weight: 600; letter-spacing: 0.1em; color: var(--t3); padding: 10px 2px 0; }
  .prof-input { width: 280px; background: var(--btn-bg); border: 1px solid transparent; border-radius: 8px; padding: 8px 12px; color: var(--t1); font: 500 13px var(--font-ui); outline: none; transition: border-color 0.12s; }
  .prof-input:hover { border-color: var(--line2); }
  .prof-input:focus { border-color: var(--border-active); }
  .prof-static { font-size: 12px; color: var(--t2); }
  .co-row-id { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .co-row-ava { display: flex; align-items: center; justify-content: center; width: 26px; height: 26px; flex-shrink: 0; border-radius: 7px; background: var(--line2); font: 600 9px var(--font-ui); color: var(--t2); }
  .pill.role { border: 1px solid color-mix(in srgb, var(--t1) 12%, transparent); background: transparent; color: var(--t3); }
  /* Sync state reads as a word next to its switch. */
  .co-row-sync { display: flex; align-items: center; gap: 10px; }
  .sync-label { font-size: 12px; color: var(--t3); min-width: 44px; text-align: right; }
  .sync-label.on { color: var(--ok-ink); }

  .toggle { margin-left: auto; width: 28px; height: 16px; border-radius: 999px; background: var(--line2); position: relative; flex-shrink: 0; transition: background 0.15s; }
  .toggle::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #ffffff; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25); transition: left 0.15s; }
  .toggle.on { background: var(--ok); }
  .toggle.on::after { left: 14px; }

  /* ═══════════ Panels ═══════════ */
  /* Dropdowns float as frosted glass: translucent white over a backdrop blur. */
  .panel { position: absolute; background: var(--panel-bg); border: 1px solid var(--panel-border); border-radius: 12px; padding: 6px; box-shadow: var(--panel-shadow); backdrop-filter: blur(40px) saturate(1.5); -webkit-backdrop-filter: blur(40px) saturate(1.5); display: none; flex-direction: column; gap: 0; z-index: 50; min-width: 270px; }
  .panel.open { display: flex; }
  /* Stays inside the 280px side pane. */
  /* Sidebar dropdowns span the pane's content width. */
  .scope-panel { top: 86px; left: 10px; right: auto; width: 260px; min-width: 0; }
  .filter-panel { top: 86px; left: 10px; right: auto; width: 260px; min-width: 0; }
  .scope-panel .p-item.co-row { gap: 9px; padding: 6px 8px; }
  .scope-panel .co-tile { width: 20px; height: 20px; border-radius: 6px; font-size: 8px; }
  .scope-panel .p-item.co-row.current { background: var(--hover); }
  .co-row-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
  .co-key { flex-shrink: 0; font-size: 10px; color: var(--t3); }
  .core-panel { top: 52px; right: 16px; width: 300px; }
  .status-panel { top: 104px; right: 20px; width: 300px; }
  /* Member / agent list marks — thread-avatar shape at menu scale. */
  .m-ava { display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; flex-shrink: 0; border-radius: 50%; background: var(--line2); font: 600 9px var(--font-ui); color: var(--t1); }
  .m-ava.ai { background: var(--ice-tile); color: var(--ice-ink); }
  /* Condensed key-value rows: Branch / Repo / Preview. */
  .status-panel .p-item.kv { padding: 5px 10px; }
  .status-panel .p-item.static { cursor: default; }
  /* Filter dropdown: sort segmented control + type scope + people. */
  .fp-head { display: flex; align-items: center; justify-content: space-between; }
  .fp-head:not(:first-child) { margin-top: 6px; }
  .fp-reset { padding: 5px 8px; font-size: 10px; font-weight: 500; color: var(--t3); }
  .fp-reset:hover { color: var(--t1); }
  /* Same segmented control as the channel tabs. */
  .fp-seg { display: flex; gap: 2px; margin: 2px 8px 6px; padding: 2px; border-radius: 8px; background: var(--raised); }
  .fp-seg-btn { display: inline-flex; align-items: center; justify-content: center; gap: 5px; flex: 1; padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 500; color: var(--t2); transition: color 0.12s; }
  .fp-seg-btn:hover { color: var(--t1); }
  .fp-seg-btn.on { background: var(--sel); color: var(--t1); }
  .p-item .you { margin-left: -4px; font-size: 10px; color: var(--t3); }
  .m-ava.sm { width: 18px; height: 18px; font-size: 8px; }
  .p-check { display: inline-flex; align-items: center; justify-content: flex-end; width: 13px; margin-left: auto; flex-shrink: 0; color: var(--t2); }
  /* Stays inside the side pane; condensed like the filter menu. */
  .user-panel { bottom: 56px; left: 10px; width: 260px; min-width: 0; padding: 6px; gap: 0; }
  .user-panel .p-item { padding: 6px 8px; gap: 8px; font-size: 12px; }
  .user-panel .p-item .pi { width: 14px; }
  /* One condensed row standard across every dropdown. */
  .p-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; font-size: 12px; color: var(--t1); width: 100%; }
  .p-item:hover { background: var(--hover); }
  .p-item.static { cursor: default; }
  .p-item.static:hover { background: none; }
  .p-item .pi { display: inline-flex; align-items: center; justify-content: center; width: 14px; flex-shrink: 0; color: var(--t2); }
  .p-item.kv { font-size: 11px; }
  .p-item .k { color: var(--t2); width: 52px; flex-shrink: 0; }
  .p-item .val { font-size: 11px; color: var(--t1); }
  .p-dim { color: var(--t2); font-size: 12px; }
  .p-meta { margin-left: auto; font-size: 10px; color: var(--t3); }
  .p-meta.new { color: var(--ice-ink); }
  /* Header sits apart from the detail rows; the detail rows sit tight. */
  .p-card { display: flex; flex-direction: column; gap: 4px; background: var(--raised); border: none; border-radius: 10px; padding: 10px 12px; margin-bottom: 6px; }
  .p-card .p-line.head { margin-bottom: 4px; }
  .p-line { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--t2); }
  .p-line.head { font-size: 13px; color: var(--t1); font-weight: 500; }
  .p-line .v { font-size: 10px; color: var(--t1); }
  .p-line .okc { font-size: 10px; color: var(--ok-ink); }
  .upd-btn { margin-left: auto; font-size: 11px; font-weight: 500; color: var(--badge-fg); background: var(--ice-ink); border: none; border-radius: 6px; padding: 3px 10px; }
  .upd-btn:hover { opacity: 0.88; }
  .p-sec { font-size: 9px; font-weight: 600; letter-spacing: 0.1em; color: var(--t3); padding: 12px 8px 3px; }
  .p-sec:first-child, .p-card + .p-sec { padding-top: 5px; }
  /* No horizontal padding on the box — the toggle's own 10px inset lines its
     icon/text up with the plain p-item rows above. */
  /* Collapsed, Packs is a plain menu row; expanding gives it the boxed
     sub-list chrome. Hovering the open box brightens the whole box. */
  .packs-box { border: none; border-radius: 10px; transition: background 0.12s; }
  .packs-box.open { background: var(--raised); padding: 4px 0; margin-top: 4px; }
  .packs-box.open .packs-toggle { padding: 8px; }
  .packs-box.open .packs-toggle:hover { background: transparent; }
  .packs-box.open:has(.packs-toggle:hover) { background: var(--btn-bg); }
  .packs-title { font-weight: 500; color: var(--t1); }
  /* Side gutter keeps the sub-row hover pill inset from the box edges. */
  .sub-item { display: flex; align-items: center; gap: 8px; margin: 0 6px; padding: 4px 8px 4px 24px; font-size: 12px; color: var(--t1); width: calc(100% - 12px); border-radius: 6px; }
  .sub-item:hover { background: var(--hover); }
  .sub-item.muted { color: color-mix(in srgb, var(--t1) 55%, transparent); }
  .sub-item.muted:hover { color: var(--t1); }
  .accent { color: var(--ice-ink); }
  .strong { font-weight: 500; }
  .progress { flex: 1; height: 4px; border-radius: 2px; background: var(--line2); overflow: hidden; display: flex; }
  .progress-fill { background: var(--ice-ink); }
  .avstack { display: flex; }
  /* Same fills as the thread avatars (line2 for humans, ice tile for AI). */
  .avstack span { width: 22px; height: 22px; border-radius: 50%; background: var(--line2); border: none; display: flex; align-items: center; justify-content: center; font: 600 9px var(--font-ui); color: var(--t1); }
  .avstack span + span { margin-left: -5px; }
  .avstack .ai { background: var(--ice-tile); color: var(--ice-ink); font-size: 7px; font-weight: 600; }

  /* House tooltip: replaces native title bubbles on hover targets. */
  .v2 :global([data-tip]) { position: relative; }
  .v2 :global([data-tip]::after) {
    content: attr(data-tip);
    position: absolute;
    top: calc(100% + 5px);
    left: 50%;
    transform: translateX(-50%);
    padding: 3px 7px;
    border-radius: 6px;
    border: 1px solid var(--panel-border);
    background: var(--panel-bg);
    backdrop-filter: blur(40px) saturate(1.5);
    -webkit-backdrop-filter: blur(40px) saturate(1.5);
    color: var(--t1);
    font-size: 11px;
    font-weight: 400;
    line-height: 1.4;
    white-space: nowrap;
    box-shadow: var(--panel-shadow);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.12s ease 0s;
    z-index: 80;
  }
  .v2 :global([data-tip]:hover::after) { opacity: 1; transition-delay: 0.35s; }

  .toast { position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%); background: var(--panel-bg); border: 1px solid var(--panel-border); border-radius: 10px; padding: 9px 16px; font-size: 12px; color: var(--t1); backdrop-filter: blur(40px) saturate(1.5); -webkit-backdrop-filter: blur(40px) saturate(1.5); opacity: 0; transition: opacity 0.2s; pointer-events: none; z-index: 99; white-space: nowrap; }
  .toast.show { opacity: 1; }
  .empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--t3); font-size: 13px; }
</style>

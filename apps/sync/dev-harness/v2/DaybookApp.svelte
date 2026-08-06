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
    CaretUp,
    ChatCircle,
    Check,
    FileText,
    FunnelSimple,
    GearSix,
    Hash,
    Image,
    Lightning,
    MagnifyingGlass,
    Note,
    Package,
    ShieldCheck,
    SignOut,
    UserCircle,
    VideoCamera,
    Warning,
  } from 'phosphor-svelte';

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
  };
  type Channel = {
    type: 'project' | 'channel' | 'dm';
    title: string;
    sub: string;
    unread?: number;
    live?: boolean;
    av?: string;
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
          type: 'project', title: '# hq-desktop', sub: 'Indigo · project channel', unread: 4,
          status: { dot: 'ok', label: 'Agent running' },
          feed: [
            { sep: 'TODAY · 9:12 AM' },
            { who: 'Bryan', av: 'B', when: '9:12 AM', text: 'Sidebar concepts look right — can we see the day groups collapse after a week?' },
            { who: 'Desktop Agent', ai: true, when: 'RUN COMPLETE · 9:31 AM', card: { t: 'Story US-004 shipped — day-group collapse behavior', s: 'Groups older than 7 days fold into a single "Last week" row. 12 tests added, preview deployed.', actions: ['Open preview', 'View diff'] } },
            { who: 'Corey', av: 'C', when: '9:34 AM', text: "Perfect. Let's fold marketplace into the Core menu next." },
            { who: 'Sofia', av: 'S', when: '10:02 AM', text: 'Dropped the updated library IA in Files — company knowledge now lives one tab away instead of three menus deep.', file: { n: 'library-ia-v2.md', m: 'FILES · 4 KB' } },
          ],
          board: {
            inprog: [['US-002 · sidebar day-grouping', 'AGENT RUNNING · 62%', 'ok'], ['US-005 · Core dropdown', 'Corey · design review', ''], ['US-007 · library overlay', 'Sofia · spec', '']],
            review: [['US-004 · day-group collapse', 'PR OPEN · CI GREEN', 'warn'], ['US-001 · unified shell frame', 'Marcus reviewing', '']],
            done: [['US-003 · remove messages app', 'SHIPPED', 'ok'], ['US-006 · title bar', 'SHIPPED', 'ok']],
          },
          files: [['file', 'library-ia-v2.md', 'SOFIA · TODAY'], ['file', 'daybook-interaction-notes.md', 'COREY · TODAY'], ['image', 'concept-a-daybook.png', 'AGENT · YESTERDAY'], ['file', 'prd-draft.json', 'AGENT · AUG 1']],
        },
        'hq-sync': {
          type: 'project', title: '# hq-sync', sub: 'Indigo · project channel',
          status: { dot: 'ok', label: 'Idle' },
          feed: [{ sep: 'YESTERDAY' }, { who: 'Build Agent', ai: true, when: '5:02 PM', card: { t: 'v0.10.43 released', s: 'Menubar popover drift detection shipped to prod.', actions: ['Release notes'] } }],
          board: { inprog: [], review: [], done: [['US-011 · drift detect', 'SHIPPED', 'ok'], ['US-012 · rescue flow', 'SHIPPED', 'ok']] },
          files: [['file', 'release-checklist.md', 'AGENT · AUG 3']],
        },
        'agent-orchestrator': {
          type: 'project', title: '# agent-orchestrator', sub: 'Indigo · project channel', live: true,
          status: { dot: 'ok', label: 'Agent running' },
          feed: [{ sep: 'TODAY' }, { who: 'Fleet Agent', ai: true, when: 'RUNNING · 10:14 AM', card: { t: 'Nightly triage sweep', s: '12 boxes checked, 1 flagged for storage autoscale.', actions: ['View report'] } }],
          board: { inprog: [['US-020 · box telemetry', 'AGENT · 30%', 'ok']], review: [], done: [] },
          files: [['file', 'triage-report-aug4.md', 'AGENT · TODAY']],
        },
        'gtm-standup': {
          type: 'channel', title: '# gtm-standup', sub: 'Indigo · channel',
          feed: [
            { sep: 'TODAY · 8:30 AM' },
            { who: 'Standup Agent', ai: true, when: '8:30 AM', card: { t: 'Standup recap — Aug 4', s: '4 deliverables in motion, 1 blocker on the pricing page copy.', actions: ['Open brief'] } },
            { who: 'Bryan', av: 'B', when: '8:41 AM', text: 'Pricing blocker is on me — copy review by noon.' },
          ],
        },
        bryan: {
          type: 'dm', title: 'Bryan', sub: 'direct message', unread: 2, av: 'B',
          feed: [
            { sep: 'TODAY · 9:12 AM' },
            { who: 'Bryan', av: 'B', when: '9:12 AM', text: 'Sidebar concepts look right — can we see the day groups collapse after a week?' },
            { who: 'Bryan', av: 'B', when: '9:13 AM', text: 'Also — demo with the Nestlé team moved to Thursday.' },
          ],
        },
        'sofia-marcus': {
          type: 'dm', title: 'Sofia, Marcus', sub: 'group message', av: 'S',
          feed: [
            { sep: 'YESTERDAY' },
            { who: 'Sofia', av: 'S', when: '2:14 PM', text: 'Library IA thread resolved — doc saved to Knowledge.' },
            { who: 'Marcus', av: 'M', when: '2:20 PM', text: 'Nice. Linking it from the project channel.' },
          ],
        },
        'standup-brief': {
          type: 'project', title: '# standup-brief', sub: 'Indigo · project channel',
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
          type: 'project', title: '# enterprise-pricing', sub: 'Indigo · project channel',
          status: { dot: 'w', label: 'Review waiting' },
          feed: [
            { sep: 'SATURDAY' },
            { who: 'Corey', av: 'C', when: '11:02 AM', text: 'Enterprise tier features aligned across console and marketing.' },
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
          type: 'project', title: '# creative-pipeline', sub: 'Sender Agency · project channel',
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
          type: 'project', title: '# email-os', sub: 'Sender Agency · project channel',
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
          type: 'project', title: '# book-tracker', sub: 'Personal · project channel',
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
    ['accounting', 'Books, categorization, and monthly close helpers.', 'get', 'GET'],
    ['secure-sidecar', 'Scoped secret access for untrusted workloads.', 'get', 'GET'],
  ];

  /* ═══════════ State ═══════════ */
  /** Company scope for the daybook list: 'all' aggregates every company. */
  let coFilter = $state<'all' | string>('all');
  /** Company owning the open channel (rows carry their company). */
  let activeCo = $state('indigo');
  let view = $state<'channel' | 'library' | 'marketplace' | 'sync' | 'settings' | 'history'>('channel');
  let channelId = $state('hq-desktop');
  let tab = $state<'chat' | 'board' | 'files'>('chat');
  let libCat = $state('files');
  let openPanel = $state<string | null>(null);
  let packsOpen = $state(false);
  let sortMode = $state<'chrono' | 'type'>('chrono');
  let filterTypes = $state<Record<string, boolean>>({ project: true, channel: true, dm: true });
  let search = $state('');
  let moreCompanies = $state(false);
  const EXTRA_COMPANIES: [string, string][] = [
    ['LR', 'LiveRecover'],
    ['KW', 'Keptwork'],
    ['HM', 'Holler Mgmt'],
  ];
  let composerText = $state('');
  let settingsToggles = $state([true, true, true, false, false]);
  let resolvedConflict = $state(false);
  let feedEl = $state<HTMLElement | null>(null);

  let toastMsg = $state('');
  let toastShown = $state(false);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function toast(msg: string) {
    toastMsg = msg;
    toastShown = true;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastShown = false), 2200);
  }

  const company = $derived(DATA[activeCo]);
  const chan = $derived(company.channels[channelId] as Channel | undefined);
  const filterActive = $derived(Object.values(filterTypes).some((v) => !v));
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

  function toggleCompany(key: string) {
    coFilter = coFilter === key ? 'all' : key;
  }
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
    if (!filterTypes[c.type]) return false;
    if (search && !c.title.toLowerCase().includes(search.toLowerCase())) return false;
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
      document.getElementById('v2-search')?.focus();
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
    <button class="core-btn" data-panel-trigger onclick={(e) => { e.stopPropagation(); togglePanel('core'); }}>
      <span class="dot"></span>Core <span class="caret"><CaretDown size={10} weight="bold" /></span>
    </button>
  </div>

  <div class="body">
    <!-- Daybook sidebar -->
    <div class="sidebar">
      <div class="search-row">
        <div class="search">
          <span class="lead"><MagnifyingGlass size={13} /></span>
          <input id="v2-search" placeholder="Search or jump to…" bind:value={search} />
          <span class="kbd mono">⌘K</span>
        </div>
        <button
          class="filter-btn"
          class:on={filterActive}
          aria-label="Filter conversations"
          title="Filter"
          data-panel-trigger
          onclick={(e) => { e.stopPropagation(); togglePanel('filter'); }}
        >
          <FunnelSimple size={14} />
        </button>
      </div>

      <!-- Company scope strip: everything by default, click a circle to
           filter, hover stretches the pill to the full name. -->
      <div class="co-strip" role="group" aria-label="Filter by company">
        {#each Object.entries(DATA) as [key, c] (key)}
          <button
            class="co-chip"
            class:active={coFilter === key}
            aria-pressed={coFilter === key}
            title={c.label}
            onclick={() => toggleCompany(key)}
          >
            <span class="co-ava">{c.short}</span>
          </button>
        {/each}
        {#if moreCompanies}
          {#each EXTRA_COMPANIES as [short, label] (short)}
            <button class="co-chip" title={label} onclick={() => toast(`${label} would load (not in prototype data)`)}>
              <span class="co-ava">{short}</span>
            </button>
          {/each}
        {/if}
        <button
          class="co-chip more"
          aria-expanded={moreCompanies}
          title={moreCompanies ? 'Show less' : 'All companies'}
          onclick={() => (moreCompanies = !moreCompanies)}
        >
          <span class="co-ava">{#if moreCompanies}<CaretUp size={12} weight="bold" />{:else}+{EXTRA_COMPANIES.length}{/if}</span>
        </button>
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
              {#if c.type === 'dm'}<span class="av">{c.av ?? c.title[0]}</span>{:else}<span class="ico"><Hash size={13} /></span>{/if}
              <span class="name">{c.title.replace('# ', '')}</span>
              {#if coFilter === 'all'}<span class="row-co mono">{DATA[r.co].short}</span>{/if}
              {#if c.unread}<span class="badge mono">{c.unread}</span>{:else if c.live}<span class="pulse"></span>{/if}
            </button>
          {/if}
        {/snippet}
        <div class="grp"><span class="t mono">PINNED</span></div>
        {#each sidePinned as r (`${r.co}:${r.id}`)}
          {@render sideRow(r)}
        {/each}
        {#each sideDays as d (d.date)}
          <div class="grp"><span class="t mono">{d.label}</span><span class="d mono">{d.date}</span></div>
          {#each d.items as r (`${r.co}:${r.id}`)}
            {@render sideRow(r)}
          {/each}
        {/each}
        <button class="grp fold" onclick={() => toast('Last week would expand — 6 quiet conversations')}>
          <span class="t mono dim">LAST WEEK <CaretRight size={8} weight="bold" /></span><span class="d mono">6 QUIET</span>
        </button>
        <button class="hist" onclick={() => nav('history')}><MagnifyingGlass size={14} /><span>Show all history…</span></button>
      </div>
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
                  {#each ['chat', 'board', 'files'] as t (t)}
                    <button class="tab" class:on={tab === t} onclick={() => (tab = t as typeof tab)}>{t[0].toUpperCase() + t.slice(1)}</button>
                  {/each}
                </div>
                {#if chan.status}
                  <button class="status-btn" data-panel-trigger onclick={(e) => { e.stopPropagation(); togglePanel('status'); }}>
                    <span class="dot" class:w={chan.status.dot === 'w'}></span>{chan.status.label} <span class="caret"><CaretDown size={10} weight="bold" /></span>
                  </button>
                {/if}
              </div>
            {/if}
          </div>
          <div class="content">
            {#if tab === 'board'}
              {#if chan.board}
                <div class="board">
                  {#each [['IN PROGRESS', chan.board.inprog], ['REVIEW', chan.board.review], ['DONE', chan.board.done]] as [name, items] (name)}
                    <div class="col">
                      <span class="colh mono">{name} · {(items as string[][]).length}</span>
                      {#each items as [t, s, cls] (t)}
                        <button class="story" class:dim={name === 'DONE'} onclick={() => toast('Story detail would open')}>
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
                  {:else}
                    <div class="msg">
                      {#if m.ai}<div class="pav ai mono">AI</div>{:else}<div class="pav">{m.av}</div>{/if}
                      <div class="msg-body">
                        <span class="who" class:ai={m.ai}>{m.who}</span>
                        <span class="when" class:mono={m.ai}>{m.when}</span>
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
                <button class="send" onclick={sendMessage}>Send</button>
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
            <div class="lib-head"><input placeholder={`Search ${company.label}'s library — files, skills, workers…`} /></div>
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
        <div class="market">
          {#each MARKET as [n, d, cls, label] (n)}
            <button class="pack" onclick={() => toast(`${n} pack detail would open`)}>
              <span class="pn">{n}</span><span class="pd">{d}</span>
              <div class="pf"><span class="pill mono {cls}">{label}</span></div>
            </button>
          {/each}
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
        <div class="settings">
          {#each [
            ['Launch at login', 'Start HQ when you sign in to your Mac'],
            ['Menubar quick access', 'Keep the compact popover in the menu bar'],
            ['Notify on agent completion', 'Ping when a run finishes or needs review'],
            ['Quiet hours', 'Mute non-urgent notifications 6 PM – 8 AM'],
            ['Sound effects', 'Subtle sends & completion sounds'],
          ] as [n, d], i (n)}
            <div class="set-row">
              <div><div class="sn">{n}</div><div class="sd">{d}</div></div>
              <button
                class="toggle"
                class:on={settingsToggles[i]}
                role="switch"
                aria-checked={settingsToggles[i]}
                aria-label={n}
                onclick={() => (settingsToggles[i] = !settingsToggles[i])}
              ></button>
            </div>
          {/each}
          <div class="set-row">
            <div><div class="sn">Default company</div><div class="sd">Which company loads on launch</div></div>
            <span class="mono accent push-right co-picker">INDIGO <CaretDown size={9} weight="bold" /></span>
          </div>
        </div>
      {:else if view === 'history'}
        {@const histLabel = coFilter === 'all' ? 'All companies' : DATA[coFilter].label}
        <div class="chan-head">
          <button class="back-btn" onclick={() => nav('channel')}><ArrowLeft size={12} weight="bold" /> Back</button>
          <span class="chan-title">All history</span>
          <span class="chan-sub">{histLabel} · every conversation, ever</span>
        </div>
        <div class="lib-head hist-head"><input placeholder={`Search all of ${histLabel}'s history…`} /></div>
        <div class="listview">
          {#each scopeKeys as k (k)}
            {#each Object.entries(DATA[k].channels) as [id, c] (`${k}:${id}`)}
              <button class="lrow" onclick={() => selectChannel(k, id)}>
                <span class="lrow-ic">{#if c.type === 'dm'}<ChatCircle size={15} />{:else}<Hash size={15} />{/if}</span><span class="fn">{c.title.replace('# ', '')}</span><span class="fm mono">{coFilter === 'all' ? `${DATA[k].short} · ` : ''}{c.type.toUpperCase()}</span>
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
    <div class="packs-box">
      <button class="p-item packs-toggle" onclick={(e) => { e.stopPropagation(); packsOpen = !packsOpen; }}>
        <span class="pi"><Package size={14} /></span><span class="packs-title">Packs</span>
        <span class="p-meta mono">4 INSTALLED {#if packsOpen}<CaretDown size={8} weight="bold" />{:else}<CaretRight size={8} weight="bold" />{/if}</span>
      </button>
      {#if packsOpen}
        <button class="sub-item" onclick={() => nav('marketplace')}>engineering<span class="p-meta mono">v2.1</span></button>
        <button class="sub-item" onclick={() => nav('marketplace')}>design-styles<span class="p-meta mono new">v3.0 · NEW</span></button>
        <button class="sub-item" onclick={() => nav('marketplace')}>parker<span class="p-meta mono">v1.4</span></button>
        <button class="sub-item accent strong" onclick={() => nav('marketplace')}>Open marketplace <ArrowRight size={11} weight="bold" /></button>
      {/if}
    </div>
  </div>

  <!-- Project status dropdown -->
  <div class="panel status-panel" class:open={openPanel === 'status'}>
    <div class="p-card">
      <div class="p-line head"><span class="dot"></span> Agent running <span class="p-meta mono">US-002 · 62%</span></div>
      <div class="p-line"><span class="progress"><span class="progress-fill" style="width:62%"></span></span><span class="p-meta mono">7/12 STORIES</span></div>
    </div>
    <div class="p-sec mono">MEMBERS &amp; AGENTS</div>
    <div class="p-item static">
      <span class="avstack"><span>C</span><span>B</span><span>S</span><span class="ai mono">AI</span></span>
      <span class="p-dim">5 members · 2 agents</span>
    </div>
    <div class="p-sec mono">PROJECT</div>
    <div class="p-item static kv"><span class="k">Branch</span><span class="mono val">feat/unified-shell</span></div>
    <div class="p-item static kv"><span class="k">Repo</span><span class="mono val">hq-desktop</span></div>
    <button class="p-item kv" onclick={() => toast('Preview would open')}><span class="k">Preview</span><span class="accent strong preview-link">hq-desktop-preview <ArrowUpRight size={11} weight="bold" /></span></button>
  </div>

  <!-- Filter dropdown -->
  <div class="panel filter-panel" class:open={openPanel === 'filter'}>
    <div class="p-sec mono">SORT</div>
    {#each [['chrono', 'Chronological'], ['type', 'By type']] as [k, label] (k)}
      <button class="p-item" onclick={(e) => { e.stopPropagation(); sortMode = k as typeof sortMode; toast(k === 'type' ? 'Sorted by type' : 'Sorted chronologically'); }}>
        <span class="pi">{#if sortMode === k}<Check size={12} weight="bold" />{/if}</span>{label}
      </button>
    {/each}
    <div class="p-sec mono">SHOW</div>
    {#each [['project', 'Projects'], ['channel', 'Channels'], ['dm', 'DMs & groups']] as [k, label] (k)}
      <button class="p-item" onclick={(e) => { e.stopPropagation(); filterTypes[k] = !filterTypes[k]; }}>
        <span class="pi">{#if filterTypes[k]}<Check size={12} weight="bold" />{/if}</span>{label}
      </button>
    {/each}
  </div>

  <!-- User menu -->
  <div class="panel user-panel" class:open={openPanel === 'user'}>
    <button class="p-item" onclick={() => toast('Profile would open')}><span class="pi"><UserCircle size={14} /></span>Profile</button>
    <button class="p-item" onclick={() => nav('settings')}><span class="pi"><GearSix size={14} /></span>Settings</button>
    <button class="p-item" onclick={() => toast('Notification preferences would open')}><span class="pi"><Bell size={14} /></span>Notifications</button>
    <button class="p-item" onclick={() => toast('Sign out')}><span class="pi"><SignOut size={14} /></span>Sign out</button>
  </div>

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
    --panel-bg: rgba(255, 255, 255, 0.1);
    --panel-border: rgba(255, 255, 255, 0.09);
    --border-active: rgba(255, 255, 255, 0.3);
    --line: rgba(255, 255, 255, 0.07);
    --line2: rgba(255, 255, 255, 0.11);
    --t1: #f4f4f6;
    --t2: #9a9aa2;
    --t3: #64646c;
    --ice: #c9d6e4;
    --ice-ink: #c9d6e4;
    --ice-tile: #1e2a3a;
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
    --panel-bg: rgba(255, 255, 255, 0.78);
    --panel-border: rgba(0, 0, 0, 0.06);
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
  .grp .t, .p-meta, .accent, .co-picker { display: inline-flex; align-items: center; gap: 4px; }
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

  /* ═══════════ Company strip (under the search bar) ═══════════ */
  .co-strip { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 6px; }
  /* Chips follow the secondary-button states: fill at rest, border on hover,
     brighter border + primary ink when selected. */
  .co-chip { display: inline-flex; border-radius: 999px; }
  .co-ava { display: flex; align-items: center; justify-content: center; width: 30px; height: 30px; flex-shrink: 0; border-radius: 50%; background: var(--btn-bg); border: 1px solid transparent; font: 600 10px var(--font-ui); color: var(--t2); box-sizing: border-box; transition: border-color 0.12s; }
  .co-chip:hover .co-ava { border-color: var(--line2); color: var(--t1); }
  .co-chip.active .co-ava { background: var(--ice-tile); border-color: var(--ice-ink); color: var(--ice-ink); }
  .co-chip.more .co-ava { border: 1px dashed var(--line2); background: transparent; color: var(--t3); font-size: 9px; }
  .co-chip.more:hover .co-ava { color: var(--t1); border-color: var(--border-active); }

  /* ═══════════ Sidebar ═══════════ */
  .sidebar { width: 280px; flex-shrink: 0; background: var(--side-bg); border-right: 1px solid var(--line); display: flex; flex-direction: column; padding: 14px 10px 10px; min-height: 0; }
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
  .side-scroll { flex: 1; overflow-y: auto; min-height: 0; scrollbar-width: thin; scrollbar-color: var(--line2) transparent; }
  .grp { display: flex; align-items: center; justify-content: space-between; padding: 12px 8px 4px; width: 100%; }
  .grp .t { font-size: 10px; font-weight: 600; letter-spacing: 0.1em; color: var(--t2); }
  .grp .t.dim { color: var(--t3); }
  .grp .d { font-size: 10px; color: var(--t3); }
  .grp.fold:hover .t { color: var(--t1); }
  .row { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; width: 100%; }
  .row:hover { background: var(--hover); }
  .row.sel { background: var(--sel); }
  .row .ico { display: inline-flex; align-items: center; justify-content: center; width: 16px; flex-shrink: 0; color: var(--t3); }
  .row .av { width: 16px; height: 16px; flex-shrink: 0; border-radius: 50%; background: var(--line2); font: 600 9px var(--font-ui); color: var(--t2); display: flex; align-items: center; justify-content: center; }
  .row .name { flex: 1; min-width: 0; font-size: 13px; color: var(--t2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: left; }
  .row.unread .name { font-weight: 500; color: var(--t1); }
  /* Company tag on rows while the daybook aggregates all companies —
     a muted circle sized to match the unread badge. */
  .row-co { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; min-width: 16px; height: 16px; padding: 0 3px; flex-shrink: 0; border-radius: 999px; background: var(--btn-bg); font-size: 8px; letter-spacing: 0.04em; color: var(--t3); }
  /* Single digits render as a perfect 16px circle; longer counts grow into a pill. */
  .badge { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; min-width: 16px; height: 16px; margin-left: auto; flex-shrink: 0; font-size: 10px; font-weight: 500; line-height: 1; color: var(--badge-fg); background: var(--ice-ink); border-radius: 999px; padding: 0 5px; }
  .pulse { margin-left: auto; flex-shrink: 0; width: 7px; height: 7px; border-radius: 50%; background: var(--ice-ink); }
  .hist { display: flex; align-items: center; gap: 8px; padding: 8px; margin-top: 8px; color: var(--t2); font-weight: 500; font-size: 12px; border-radius: 8px; width: 100%; }
  .hist:hover { background: var(--hover); }
  .footer { display: flex; align-items: center; gap: 8px; padding: 10px 8px 4px; border-top: 1px solid var(--line); margin-top: 8px; width: 100%; }
  .footer:hover { background: var(--hover); border-radius: 8px; }
  .footer .fav { width: 22px; height: 22px; border-radius: 50%; background: var(--line2); font: 600 10px var(--font-ui); color: var(--t1); display: flex; align-items: center; justify-content: center; }
  .footer-name { font-weight: 500; font-size: 12px; color: var(--t2); }
  .synced { margin-left: auto; font-size: 10px; color: var(--ok-ink); }

  /* ═══════════ Main ═══════════ */
  .main { flex: 1; background: var(--ground); display: flex; flex-direction: column; min-width: 0; position: relative; }
  .chan-head { display: flex; align-items: center; gap: 10px; height: 52px; padding: 0 20px; border-bottom: 1px solid var(--line); flex-shrink: 0; }
  .chan-title { font-weight: 600; font-size: 15px; white-space: nowrap; }
  .chan-sub { font-size: 12px; color: var(--t3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .head-right { display: flex; align-items: center; gap: 12px; margin-left: auto; }
  .tabs { display: flex; gap: 2px; background: var(--raised); border: 1px solid var(--line); border-radius: 8px; padding: 2px; }
  .tab { font-weight: 500; font-size: 12px; color: var(--t2); padding: 4px 12px; border-radius: 6px; transition: color 0.12s; }
  .tab:hover { color: var(--t1); }
  .tab.on { color: var(--t1); background: var(--sel); }
  .status-btn { display: flex; align-items: center; gap: 6px; background: var(--btn-bg); border: 1px solid transparent; border-radius: 8px; padding: 5px 12px; font-weight: 500; font-size: 12px; color: var(--t2); white-space: nowrap; }
  .status-btn:hover { border-color: var(--line2); color: var(--t1); }
  .back-btn { display: flex; align-items: center; gap: 6px; font-weight: 500; font-size: 12px; color: var(--t2); border: 1px solid var(--line2); border-radius: 8px; padding: 5px 10px; }
  .back-btn:hover { background: var(--hover); color: var(--t1); }

  .content { flex: 1; display: flex; flex-direction: column; min-height: 0; }

  /* ═══════════ Feed ═══════════ */
  .feed { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 18px; padding: 24px 24px 12px; min-height: 0; scrollbar-width: thin; scrollbar-color: var(--line2) transparent; }
  .daysep { display: flex; align-items: center; gap: 12px; }
  .daysep hr { flex: 1; border: none; height: 1px; background: var(--line); margin: 0; }
  .daysep span { font-size: 10px; font-weight: 500; letter-spacing: 0.08em; color: var(--t3); }
  .msg { display: flex; gap: 12px; }
  .msg-body { min-width: 0; flex: 1; }
  .pav { width: 32px; height: 32px; flex-shrink: 0; border-radius: 8px; background: var(--line2); display: flex; align-items: center; justify-content: center; font: 600 12px var(--font-ui); }
  /* Agent avatar: blue tint distinguishes it from humans; no ring, so it
     doesn't read as a selected control. */
  .pav.ai { background: var(--ice-tile); border: none; font-size: 10px; font-weight: 600; color: var(--ice-ink); }
  .who { font-weight: 600; font-size: 13px; }
  .who.ai { color: var(--ice-ink); }
  .when { font-size: 11px; color: var(--t3); margin-left: 8px; }
  .when.mono { font-size: 10px; }
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
  /* Tight gutter: the Send button sets the height, 6px of air around it. */
  .composer { flex-shrink: 0; margin: 12px 24px 20px; display: flex; align-items: center; gap: 10px; background: var(--raised); border: 1px solid var(--line2); border-radius: 10px; padding: 6px 6px 6px 14px; }
  .composer input { flex: 1; min-width: 0; background: none; border: none; outline: none; color: var(--t1); font: 400 13px var(--font-ui); }
  .composer input::placeholder { color: var(--t3); }
  /* Standard-size primary button; text matches the secondary buttons. */
  .send { flex-shrink: 0; font-size: 12px; font-weight: 500; color: var(--badge-fg); background: var(--ice-ink); border-radius: 8px; padding: 5px 12px; }
  .send:hover { opacity: 0.88; }

  /* ═══════════ Board ═══════════ */
  .board { flex: 1; display: flex; gap: 14px; padding: 20px; overflow: auto; }
  .col { flex: 1; min-width: 200px; display: flex; flex-direction: column; gap: 10px; align-items: stretch; }
  .colh { font-size: 10px; font-weight: 600; letter-spacing: 0.1em; color: var(--t2); }
  .story { display: flex; flex-direction: column; gap: 6px; background: var(--raised); border: 1px solid var(--line); border-radius: 10px; padding: 12px; width: 100%; }
  .story:hover { border-color: var(--ice-ink); }
  .story .st { font-weight: 500; font-size: 13px; }
  .story .ss { font-size: 11px; color: var(--t2); }
  .story .ss.ok { color: var(--ok-ink); }
  .story .ss.warn { color: var(--warn-ink); }
  .story.dim { opacity: 0.65; }

  /* ═══════════ Lists / library / market ═══════════ */
  .listview { flex: 1; padding: 20px; display: flex; flex-direction: column; gap: 8px; overflow: auto; }
  .lrow { display: flex; align-items: center; gap: 10px; background: var(--raised); border: 1px solid var(--line); border-radius: 10px; padding: 10px 14px; width: 100%; }
  .lrow:hover { border-color: var(--ice-ink); }
  .lrow .fn { font-weight: 500; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lrow .fm { margin-left: auto; flex-shrink: 0; font-size: 10px; color: var(--t3); }

  .library { flex: 1; display: flex; min-height: 0; }
  .lib-nav { width: 210px; flex-shrink: 0; border-right: 1px solid var(--line); padding: 16px 10px; display: flex; flex-direction: column; gap: 2px; overflow: auto; }
  .lib-cat { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 8px; font-size: 13px; color: var(--t2); width: 100%; }
  .lib-cat:hover { background: var(--hover); }
  .lib-cat.on { background: var(--sel); color: var(--t1); font-weight: 500; }
  .lib-cat .c { margin-left: auto; font-size: 10px; color: var(--t3); }
  .lib-main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .lib-head { display: flex; align-items: center; gap: 10px; padding: 16px 20px 8px; }
  .lib-head.hist-head { padding: 16px 20px 0; }
  .lib-head input { flex: 1; background: var(--raised); border: 1px solid var(--line2); border-radius: 8px; padding: 8px 12px; color: var(--t1); font: 400 12px var(--font-ui); outline: none; }
  .lib-head input::placeholder { color: var(--t3); }

  .market { flex: 1; padding: 20px; overflow: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; align-content: start; }
  .pack { display: flex; flex-direction: column; gap: 8px; background: var(--raised); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
  .pack:hover { border-color: var(--ice-ink); }
  .pack .pn { font-weight: 600; font-size: 14px; }
  .pack .pd { font-size: 12px; color: var(--t2); line-height: 17px; flex: 1; }
  .pack .pf { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
  .pill { font-size: 10px; font-weight: 500; border-radius: 6px; padding: 2px 8px; }
  .pill.inst { color: var(--ok-ink); border: 1px solid var(--ok-ink); }
  .pill.get { color: var(--badge-fg); background: var(--ice-ink); }
  .pill.upd { color: var(--warn-ink); border: 1px solid var(--warn-ink); }

  /* ═══════════ Sync ═══════════ */
  .syncview { flex: 1; padding: 20px; display: flex; flex-direction: column; gap: 12px; overflow: auto; max-width: 760px; }
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
  .conflict-path { font-size: 12px; color: var(--t2); flex: 1; }

  /* ═══════════ Settings ═══════════ */
  .settings { flex: 1; padding: 20px; display: flex; flex-direction: column; gap: 10px; overflow: auto; max-width: 640px; }
  .set-row { display: flex; align-items: center; gap: 12px; background: var(--raised); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .set-row .sn { font-weight: 500; font-size: 13px; }
  .set-row .sd { font-size: 11px; color: var(--t3); margin-top: 2px; }
  .toggle { margin-left: auto; width: 28px; height: 16px; border-radius: 999px; background: var(--line2); position: relative; flex-shrink: 0; transition: background 0.15s; }
  .toggle::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #ffffff; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25); transition: left 0.15s; }
  .toggle.on { background: var(--ok); }
  .toggle.on::after { left: 14px; }

  /* ═══════════ Panels ═══════════ */
  /* Dropdowns float as frosted glass: translucent white over a backdrop blur. */
  .panel { position: absolute; background: var(--panel-bg); border: 1px solid var(--panel-border); border-radius: 12px; padding: 10px; box-shadow: var(--panel-shadow); backdrop-filter: blur(40px) saturate(1.5); -webkit-backdrop-filter: blur(40px) saturate(1.5); display: none; flex-direction: column; gap: 2px; z-index: 50; min-width: 270px; }
  .panel.open { display: flex; }
  .core-panel { top: 52px; right: 16px; width: 300px; }
  .status-panel { top: 104px; right: 20px; width: 300px; }
  .filter-panel { top: 96px; left: 250px; width: 230px; }
  .user-panel { bottom: 56px; left: 14px; width: 220px; }
  .p-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; font-size: 13px; color: var(--t1); width: 100%; }
  .p-item:hover { background: var(--hover); }
  .p-item.static { cursor: default; }
  .p-item.static:hover { background: none; }
  .p-item .pi { display: inline-flex; align-items: center; justify-content: center; width: 16px; flex-shrink: 0; color: var(--t2); }
  .p-item.kv { font-size: 11px; }
  .p-item .k { color: var(--t2); width: 52px; flex-shrink: 0; }
  .p-item .val { font-size: 11px; color: var(--t1); }
  .p-dim { color: var(--t2); font-size: 12px; }
  .p-meta { margin-left: auto; font-size: 10px; color: var(--t3); }
  .p-meta.new { color: var(--ice-ink); }
  .p-card { display: flex; flex-direction: column; gap: 6px; background: var(--raised); border: none; border-radius: 10px; padding: 10px 12px; margin-bottom: 6px; }
  .p-line { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--t2); }
  .p-line.head { font-size: 13px; color: var(--t1); font-weight: 500; }
  .p-line .v { font-size: 10px; color: var(--t1); }
  .p-line .okc { font-size: 10px; color: var(--ok-ink); }
  .upd-btn { margin-left: auto; font-size: 11px; font-weight: 500; color: var(--badge-fg); background: var(--ice-ink); border: none; border-radius: 6px; padding: 3px 10px; }
  .upd-btn:hover { opacity: 0.88; }
  .p-sec { font-size: 9px; font-weight: 600; letter-spacing: 0.1em; color: var(--t3); padding: 6px 10px 2px; }
  /* No horizontal padding on the box — the toggle's own 10px inset lines its
     icon/text up with the plain p-item rows above. */
  .packs-box { background: var(--raised); border: none; border-radius: 10px; padding: 4px 0; margin-top: 4px; transition: background 0.12s; }
  /* Hovering the toggle brightens the box itself — no nested hover pill. */
  .packs-box:has(.packs-toggle:hover) { background: var(--btn-bg); }
  .packs-toggle { padding: 8px 10px; }
  .packs-toggle:hover { background: transparent; }
  .packs-title { font-weight: 500; color: var(--t1); }
  .sub-item { display: flex; align-items: center; gap: 8px; padding: 4px 8px 4px 34px; font-size: 12px; color: var(--t1); width: 100%; border-radius: 6px; }
  .sub-item:hover { background: var(--hover); }
  .accent { color: var(--ice-ink); }
  .strong { font-weight: 500; }
  .progress { flex: 1; height: 4px; border-radius: 2px; background: var(--line2); overflow: hidden; display: flex; }
  .progress-fill { background: var(--ice-ink); }
  .avstack { display: flex; }
  .avstack span { width: 22px; height: 22px; border-radius: 50%; background: var(--line2); border: 2px solid var(--elevated); display: flex; align-items: center; justify-content: center; font: 600 9px var(--font-ui); color: var(--t1); }
  .avstack span + span { margin-left: -7px; }
  .avstack .ai { background: var(--ice-tile); color: var(--ice-ink); font-size: 7px; font-weight: 600; }

  .toast { position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%); background: var(--panel-bg); border: 1px solid var(--panel-border); border-radius: 10px; padding: 9px 16px; font-size: 12px; color: var(--t1); backdrop-filter: blur(40px) saturate(1.5); -webkit-backdrop-filter: blur(40px) saturate(1.5); opacity: 0; transition: opacity 0.2s; pointer-events: none; z-index: 99; white-space: nowrap; }
  .toast.show { opacity: 1; }
  .empty { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--t3); font-size: 13px; }
</style>

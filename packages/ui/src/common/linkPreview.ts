// Readable labels and hovercard data for links in chat messages.
//
// Everything here is parsed from the URL itself; no network. Generic links can
// be upgraded to the page's real title through the `link_page_title` Tauri
// command, see linkTitles.ts.

export type LinkProvider =
  | 'calendar'
  | 'github'
  | 'deploy'
  | 'linear'
  | 'notion'
  | 'google-docs'
  | 'slack'
  | 'figma'
  | 'loom'
  | 'youtube'
  | 'generic';

export interface LinkField {
  label: string;
  value: string;
}

export interface LinkPreview {
  provider: LinkProvider;
  /** Short readable label shown in place of the raw URL. */
  title: string;
  /** Kind line shown above the title in the hovercard. */
  kind: string;
  host: string;
  fields: LinkField[];
  /** Extra hovercard action, e.g. calendar "Add to calendar". */
  action?: { label: string; href: string };
  /** True when a fetched page title would read better than the parsed label. */
  wantsPageTitle: boolean;
}

const MAX_LABEL = 72;

function truncate(text: string, max = MAX_LABEL): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch {
    return part;
  }
}

function bareHost(url: URL): string {
  return url.hostname.replace(/^www\./i, '').toLowerCase();
}

function segments(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean).map(safeDecode);
}

/** Humanize a URL slug such as `q3-launch-plan-8f2a91c0d1e2f3a4b5c6` to `Q3 launch plan`. */
function humanizeSlug(slug: string): string {
  const withoutId = slug.replace(/[-_]?[0-9a-f]{20,}$/i, '');
  const words = withoutId.replace(/[-_]+/g, ' ').trim();
  if (!words) return '';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `domain › short path` fallback label. */
export function fallbackLabel(url: URL): string {
  const host = bareHost(url);
  const parts = segments(url).filter((part) => !/^[0-9a-f-]{16,}$/i.test(part));
  if (parts.length === 0) return host;
  return truncate(`${host} › ${parts.slice(-2).join('/')}`);
}

// ---------------------------------------------------------------- calendar

interface CalendarStamp {
  date: Date;
  allDay: boolean;
  utc: boolean;
}

/** One side of a Google Calendar `dates` value: `20261009T170000Z`, `20261009T170000` or `20261009`. */
function parseCalendarStamp(stamp: string): CalendarStamp | null {
  const match = stamp.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, z] = match;
  if (h === undefined) {
    return { date: new Date(Date.UTC(+y, +mo - 1, +d)), allDay: true, utc: false };
  }
  return {
    date: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s ?? 0))),
    allDay: false,
    utc: z === 'Z',
  };
}

function validTimeZone(zone: string | null): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

function formatCalendarRange(
  raw: string,
  zone: string | undefined,
): { date: string; time: string } | null {
  const [startRaw, endRaw] = raw.split('/');
  const start = parseCalendarStamp(startRaw ?? '');
  if (!start) return null;
  const end = endRaw ? parseCalendarStamp(endRaw) : null;
  // UTC stamps render in the event's zone; floating stamps are already wall time.
  const displayZone = start.utc ? (zone ?? 'UTC') : 'UTC';
  const dateFmt = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: displayZone,
  });
  if (start.allDay) return { date: dateFmt.format(start.date), time: 'All day' };
  const timeFmt = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: displayZone,
  });
  const time =
    end && !end.allDay
      ? `${timeFmt.format(start.date)} – ${timeFmt.format(end.date)}`
      : timeFmt.format(start.date);
  return { date: dateFmt.format(start.date), time };
}

function describeRecurrence(recur: string | null): string | undefined {
  if (!recur) return undefined;
  const labels: Record<string, string> = {
    DAILY: 'Daily',
    WEEKLY: 'Weekly',
    MONTHLY: 'Monthly',
    YEARLY: 'Yearly',
  };
  const freq = recur.match(/FREQ=([A-Z]+)/)?.[1];
  return (freq && labels[freq]) || 'Repeats';
}

function parseCalendar(url: URL): LinkPreview | null {
  const host = bareHost(url);
  if (host !== 'calendar.google.com') return null;
  const params = url.searchParams;
  const text = params.get('text');
  const isTemplate =
    params.get('action') === 'TEMPLATE' || /\/(render|eventedit)$/.test(url.pathname);
  if (!isTemplate || !text) {
    return {
      provider: 'calendar',
      title: 'Google Calendar',
      kind: 'Google Calendar',
      host,
      fields: [],
      wantsPageTitle: false,
    };
  }
  const zone = validTimeZone(params.get('ctz'));
  const dates = params.get('dates');
  const range = dates ? formatCalendarRange(dates, zone) : null;
  const fields: LinkField[] = [];
  if (range) {
    fields.push({ label: 'Date', value: range.date });
    fields.push({ label: 'Time', value: range.time });
  }
  if (zone) fields.push({ label: 'Time zone', value: zone.replace(/_/g, ' ') });
  const recurrence = describeRecurrence(params.get('recur'));
  if (recurrence) fields.push({ label: 'Repeats', value: recurrence });
  const location = params.get('location');
  if (location) fields.push({ label: 'Location', value: truncate(location, 120) });
  const shortDate = range?.date.replace(/, \d{4}$/, '');
  return {
    provider: 'calendar',
    title: truncate(shortDate ? `${text} · ${shortDate}` : text),
    kind: 'Calendar event',
    host,
    fields,
    action: { label: 'Add to calendar', href: url.href },
    wantsPageTitle: false,
  };
}

// ------------------------------------------------------------------ github

function parseGithub(url: URL): LinkPreview | null {
  const host = bareHost(url);
  if (host !== 'github.com') return null;
  const [owner, repo, kind, id, ...rest] = segments(url);
  const base = { provider: 'github' as const, host, wantsPageTitle: false };
  if (!owner) return { ...base, title: 'GitHub', kind: 'GitHub', fields: [] };
  if (!repo) return { ...base, title: owner, kind: 'GitHub profile', fields: [] };
  const slug = `${owner}/${repo}`;
  const repoField = { label: 'Repository', value: slug };
  if ((kind === 'pull' || kind === 'issues') && id && /^\d+$/.test(id)) {
    const isPr = kind === 'pull';
    const fields = [repoField, { label: isPr ? 'Pull request' : 'Issue', value: `#${id}` }];
    if (isPr && rest[0] === 'files') fields.push({ label: 'View', value: 'Files changed' });
    return { ...base, title: `${slug}#${id}`, kind: isPr ? 'Pull request' : 'Issue', fields };
  }
  if (kind === 'commit' && id) {
    const short = id.slice(0, 7);
    return {
      ...base,
      title: `${slug}@${short}`,
      kind: 'Commit',
      fields: [repoField, { label: 'Commit', value: short }],
    };
  }
  if ((kind === 'blob' || kind === 'tree') && id) {
    const path = rest.join('/');
    const fields = [repoField, { label: 'Branch', value: id }];
    if (path) fields.push({ label: kind === 'blob' ? 'File' : 'Folder', value: path });
    const lines = url.hash.match(/^#L(\d+)(?:-L(\d+))?$/);
    if (lines) {
      fields.push({ label: 'Lines', value: lines[2] ? `${lines[1]}–${lines[2]}` : lines[1] });
    }
    const leaf = rest[rest.length - 1];
    const shownPath = path.length > 40 && leaf ? `…/${leaf}` : path;
    return {
      ...base,
      title: truncate(path ? `${repo}/${shownPath}` : `${slug} (${id})`),
      kind: kind === 'blob' ? 'File' : 'Folder',
      fields,
    };
  }
  if (kind === 'releases' && id === 'tag' && rest[0]) {
    return {
      ...base,
      title: `${slug} ${rest[0]}`,
      kind: 'Release',
      fields: [repoField, { label: 'Tag', value: rest[0] }],
    };
  }
  if (kind === 'actions' && id === 'runs' && rest[0]) {
    return {
      ...base,
      title: `${slug} run ${rest[0]}`,
      kind: 'Workflow run',
      fields: [repoField, { label: 'Run', value: rest[0] }],
    };
  }
  if (kind) {
    return { ...base, title: `${slug} › ${kind}`, kind: 'Repository', fields: [repoField] };
  }
  return { ...base, title: slug, kind: 'Repository', fields: [repoField] };
}

// ------------------------------------------------------------------ deploy

const HQ_DEPLOY_ROOTS = ['hq.computer', 'indigo-hq.com'];

function parseDeploy(url: URL): LinkPreview | null {
  const host = bareHost(url);
  const parts = segments(url);
  if (host.endsWith('.vercel.app')) {
    const sub = host.slice(0, -'.vercel.app'.length);
    const [appPart, branch] = sub.split('-git-');
    // Unique deploy URLs look like `app-abc123xyz-team.vercel.app`.
    const app = branch ? appPart : appPart.replace(/-[a-z0-9]{9}-[a-z0-9-]+$/, '');
    const fields = [
      { label: 'App', value: app },
      { label: 'Host', value: host },
    ];
    if (branch) fields.push({ label: 'Branch preview', value: branch });
    const path = parts.join('/');
    return {
      provider: 'deploy',
      title: truncate(path ? `${app} › ${path}` : app),
      kind: 'Vercel deploy',
      host,
      fields,
      wantsPageTitle: true,
    };
  }
  if (host === 'vercel.com' && parts.length >= 2) {
    const [team, project, ...rest] = parts;
    return {
      provider: 'deploy',
      title: truncate(rest.length ? `${project} › ${rest.join('/')}` : project),
      kind: 'Vercel',
      host,
      fields: [
        { label: 'Team', value: team },
        { label: 'Project', value: project },
      ],
      wantsPageTitle: false,
    };
  }
  const root = HQ_DEPLOY_ROOTS.find((r) => host === r || host.endsWith(`.${r}`));
  if (root) {
    const sub = host === root ? '' : host.slice(0, -(root.length + 1));
    const app = sub || parts[0] || root;
    const path = (sub ? parts : parts.slice(1)).join('/');
    const fields = [
      { label: 'App', value: app },
      { label: 'Host', value: host },
    ];
    if (path) fields.push({ label: 'Path', value: path });
    return {
      provider: 'deploy',
      title: truncate(path ? `${app} › ${path}` : app),
      kind: 'HQ deploy',
      host,
      fields,
      wantsPageTitle: true,
    };
  }
  return null;
}

// ---------------------------------------------------------- other providers

function parseOtherProviders(url: URL): LinkPreview | null {
  const host = bareHost(url);
  const parts = segments(url);
  const make = (
    provider: LinkProvider,
    kind: string,
    title: string,
    fields: LinkField[] = [],
    wantsPageTitle = false,
  ): LinkPreview => ({ provider, kind, title: truncate(title), host, fields, wantsPageTitle });

  if (host === 'linear.app') {
    const [workspace, kind, id, slug] = parts;
    if (kind === 'issue' && id) {
      const name = slug ? humanizeSlug(slug) : '';
      return make('linear', 'Linear issue', name ? `${id} ${name}` : id, [
        { label: 'Workspace', value: workspace },
        { label: 'Issue', value: id },
      ]);
    }
    if (kind === 'project' && id) {
      return make('linear', 'Linear project', humanizeSlug(id) || id, [
        { label: 'Workspace', value: workspace },
      ]);
    }
    return make('linear', 'Linear', workspace ? `Linear › ${workspace}` : 'Linear');
  }
  if (host === 'notion.so' || host === 'notion.site' || host.endsWith('.notion.site')) {
    const name = humanizeSlug(parts[parts.length - 1] ?? '');
    return make('notion', 'Notion page', name || 'Notion page', [], !name);
  }
  if (host === 'docs.google.com' || host === 'drive.google.com') {
    const kinds: Record<string, string> = {
      document: 'Google Doc',
      spreadsheets: 'Google Sheet',
      presentation: 'Google Slides',
      forms: 'Google Form',
      file: 'Google Drive file',
      drive: 'Google Drive folder',
    };
    const kind =
      kinds[parts[0] ?? ''] ?? (host === 'drive.google.com' ? 'Google Drive' : 'Google Docs');
    return make('google-docs', kind, kind, [], true);
  }
  if (host === 'slack.com' || host.endsWith('.slack.com')) {
    const workspace = host.endsWith('.slack.com') ? host.slice(0, -'.slack.com'.length) : '';
    const fields: LinkField[] = [];
    if (workspace) fields.push({ label: 'Workspace', value: workspace });
    if (parts[0] === 'archives' && parts[1]) fields.push({ label: 'Channel', value: parts[1] });
    const isMessage = parts[0] === 'archives' && Boolean(parts[2]?.startsWith('p'));
    const where = workspace ? ` in ${workspace}` : '';
    return make(
      'slack',
      isMessage ? 'Slack message' : 'Slack',
      isMessage ? `Slack message${where}` : `Slack${where}`,
      fields,
    );
  }
  if (host === 'figma.com') {
    const [kind, , slug] = parts;
    const name = slug ? humanizeSlug(slug) : '';
    const label =
      kind === 'proto' ? 'Figma prototype' : kind === 'board' ? 'FigJam board' : 'Figma file';
    return make('figma', label, name || label, [], !name);
  }
  if (host === 'loom.com') return make('loom', 'Loom video', 'Loom video', [], true);
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be') {
    return make('youtube', 'YouTube video', 'YouTube video', [], true);
  }
  return null;
}

/** Parse an http(s) URL into a readable label plus hovercard data. */
export function linkPreview(href: string): LinkPreview | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return (
    parseCalendar(url) ??
    parseGithub(url) ??
    parseDeploy(url) ??
    parseOtherProviders(url) ?? {
      provider: 'generic',
      title: fallbackLabel(url),
      kind: bareHost(url),
      host: bareHost(url),
      fields: [],
      wantsPageTitle: true,
    }
  );
}

// ------------------------------------------------------- rendered-HTML pass

/** Fetched page title for a generic link, when one is known. */
export type PageTitleLookup = (href: string) => string | undefined;

function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Readable label for a bare URL: provider-parsed title, else a fetched page
 * title (when the provider wants one), else the domain and path. Escaped HTML.
 */
function readableLinkLabel(href: string, pageTitle?: PageTitleLookup): string | null {
  const preview = linkPreview(href);
  if (!preview) return null;
  const fetched = preview.wantsPageTitle ? pageTitle?.(href) : undefined;
  return escapeText(fetched && fetched.length > 0 ? fetched : preview.title);
}

const RENDERED_LINK =
  /<a href="([^"]+)" target="_blank" rel="noopener noreferrer">([^<]*)<\/a>/g;

/**
 * Post-process rendered message HTML: replace raw-URL link text with a
 * readable label and mark every http(s) anchor for the hovercard. Links whose
 * text differs from their URL (Markdown [text](url)) keep their text. Input is
 * the escaped output of renderMarkdown; nothing is decoded into the output.
 */
export function relabelRawUrlLinks(html: string, pageTitle?: PageTitleLookup): string {
  return html.replace(RENDERED_LINK, (whole, hrefAttr: string, inner: string) => {
    const href = decodeAttribute(hrefAttr);
    if (!/^https?:/i.test(href)) return whole;
    const isRaw = decodeAttribute(inner).trim() === href;
    const label = isRaw ? readableLinkLabel(href, pageTitle) : null;
    const attrs = `href="${hrefAttr}" target="_blank" rel="noopener noreferrer" class="message-link" data-link-preview="${isRaw ? 'auto' : 'text'}"`;
    if (label === null) return `<a ${attrs}>${inner}</a>`;
    return `<a ${attrs} title="${hrefAttr}">${label}</a>`;
  });
}

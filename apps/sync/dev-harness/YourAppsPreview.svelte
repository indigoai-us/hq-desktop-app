<script lang="ts">
  /**
   * Preview of the first-run "Your apps" step (?view=your-apps), the takeover
   * opened on that step with in-page answers (no network, no credentials).
   * ?state=
   *   auto        an owner; the no-sign-in catalog app connects by itself (Undo)
   *   connect     an owner; only sign-in apps were found, nothing pressed yet
   *   connecting  Connect presses wait in the browser forever (press one)
   *   failed      Connect fails with a retry (press one)
   *   docs        Set up with HQ reads a guide forever (press Zoom)
   *   member      not an owner or admin: every tile says an admin can connect it
   *   empty       nothing found: the catalog's note takers and project tools
   *   many        a full Mac: groups truncate, "Find an app" shows
   */
  import type { FoundWorkApps } from '@hq/platform';
  import FirstRunTakeover from '../../../packages/ui/src/chat/first-run/FirstRunTakeover.svelte';
  import type { YourAppsHost, YourAppsLoad, YourAppsResult } from '../../../packages/ui/src/chat/first-run/your-apps-host.js';
  import type { CatalogMatch } from '../../../packages/ui/src/chat/first-run/found-apps.js';

  const state = new URLSearchParams(window.location.search).get('state') ?? 'auto';
  const ACME = { companyUid: 'cmp_preview', slug: 'acme', name: 'Acme' };

  const app = (bundleId: string, name: string) => ({ bundleId, name });
  const server = (tool: 'claude_code' | 'codex', name: string, host: string, hasCredentialFields = false) => ({
    tool, name, transport: 'http', host, local: false, hasCredentialFields, enabled: true,
  });

  const BASE_APPS = [
    app('com.linear', 'Linear'),
    app('com.granola.app', 'Granola'),
    app('us.zoom.xos', 'zoom.us'),
    app('com.tinyspeck.slackmacgap', 'Slack'),
    app('notion.id', 'Notion'),
    app('com.1password.1password', '1Password'),
    app('com.docker.docker', 'Docker'),
    app('com.anthropic.claudefordesktop', 'Claude'),
  ];
  const BASE_SERVERS = [
    server('codex', 'aws-knowledge', 'knowledge-mcp.global.api.aws'),
    server('claude_code', 'posthog', 'mcp.posthog.com', true),
    server('claude_code', 'linear', 'mcp.linear.app'),
  ];
  const MANY_APPS = [
    ...BASE_APPS,
    app('com.loom.desktop', 'Loom'),
    app('com.microsoft.teams2', 'Microsoft Teams'),
    app('com.clickup.desktop-app', 'ClickUp'),
    app('com.todoist.mac.Todoist', 'Todoist'),
    app('md.obsidian', 'Obsidian'),
    app('com.figma.Desktop', 'Figma'),
    app('com.electron.realtimeboard', 'Miro'),
    app('com.google.drivefs', 'Google Drive'),
    app('com.hnc.Discord', 'Discord'),
    app('com.github.GitHubClient', 'GitHub Desktop'),
    app('io.tailscale.ipn.macos', 'Tailscale'),
    app('com.openai.chat', 'ChatGPT'),
    app('com.todesktop.230313mzl4w4u92', 'Cursor'),
    app('com.example.internal-tool', 'Internal Tool'),
    app('com.example.timesheet', 'Timesheet'),
  ];
  const MANY_SERVERS = [
    ...BASE_SERVERS,
    server('claude_code', 'asana', 'mcp.asana.com'),
    server('claude_code', 'atlassian', 'mcp.atlassian.com'),
    server('codex', 'supabase', 'mcp.supabase.com', true),
    server('codex', 'sentry', 'mcp.sentry.dev'),
    server('claude_code', 'stripe', 'mcp.stripe.com', true),
    server('claude_code', 'hubspot', 'mcp.hubspot.com'),
    server('codex', 'vercel', 'mcp.vercel.com'),
    server('claude_code', 'airtable', 'mcp.airtable.com', true),
  ];

  const scan = (apps: { bundleId: string; name: string }[], servers: typeof BASE_SERVERS): FoundWorkApps =>
    ({ platform: 'macos', scannedAtMs: 1, apps, mcpServers: servers, sources: [], truncated: false }) as unknown as FoundWorkApps;

  const m = (entryId: string, name: string, authClass: CatalogMatch['authClass']): CatalogMatch => ({ entryId, name, authClass });
  const CATALOG: Record<string, CatalogMatch | null> = {
    'linear.app': m('e-linear', 'Linear', 'oauth'),
    'granola.ai': m('e-granola', 'Granola', 'oauth'),
    'notion.com': m('e-notion', 'Notion', 'oauth'),
    'api.aws': m('e-aws', 'AWS Knowledge', 'none'),
    'posthog.com': m('e-posthog', 'PostHog', 'key'),
    'fireflies.ai': m('e-fireflies', 'Fireflies', 'oauth'),
    'asana.com': m('e-asana', 'Asana', 'oauth'),
    'atlassian.com': m('e-atlassian', 'Jira and Confluence', 'oauth'),
    'clickup.com': m('e-clickup', 'ClickUp', 'oauth'),
    'figma.com': m('e-figma', 'Figma', 'oauth'),
    'miro.com': m('e-miro', 'Miro', 'oauth'),
    'github.com': m('e-github', 'GitHub', 'oauth'),
    'supabase.com': m('e-supabase', 'Supabase', 'key'),
    'sentry.io': m('e-sentry', 'Sentry', 'oauth'),
    'stripe.com': m('e-stripe', 'Stripe', 'key'),
    'hubspot.com': m('e-hubspot', 'HubSpot', 'oauth'),
    'airtable.com': m('e-airtable', 'Airtable', 'key'),
    'zoom.us': null,
  };

  const never = <T,>() => new Promise<T>(() => undefined);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const workScan =
    state === 'empty' ? null
    : state === 'many' ? scan(MANY_APPS, MANY_SERVERS)
    : state === 'connect' ? scan(BASE_APPS, BASE_SERVERS.filter((s) => s.name !== 'aws-knowledge'))
    : scan(BASE_APPS, BASE_SERVERS);

  const load: YourAppsLoad = {
    catalog: CATALOG,
    connections: state === 'empty' ? [] : [{ id: 'c-slack', domain: 'slack.com', provider: 'slack' }],
    installations: {},
    canManage: state !== 'member',
    problem: null,
  };

  const host: YourAppsHost = {
    detect: async () => workScan,
    load: async () => { await wait(150); return load; },
    autoConnect: async (): Promise<YourAppsResult> => { await wait(400); return { ok: true, connectionId: 'c-auto', installationId: 'inst-auto' }; },
    connect: async (): Promise<YourAppsResult> => {
      if (state === 'failed') { await wait(300); return { ok: false, reason: 'Linear did not finish connecting. Try again.', retry: true }; }
      return never();
    },
    setup: async (): Promise<YourAppsResult> => never(),
    undo: async (): Promise<YourAppsResult> => { await wait(300); return { ok: true, connectionId: null, installationId: 'inst-auto' }; },
  };

  const noop = () => undefined;
</script>

<FirstRunTakeover
  initialName="Atlas"
  initialStep="apps"
  creation={{ state: 'ready', name: 'Atlas', bot: { agentUid: 'agt_preview', handle: 'setup' } }}
  runtimeReady={{ claude: true, codex: false, grok: false }}
  teamOptions={{ invites: [], companies: [ACME] }}
  teamHost={{ join: async () => ({ ok: false }), create: async () => ({ ok: false }) } as never}
  appsHost={{ catalog: async () => ({ ok: true, apps: [], connected: [] }), connect: async () => ({ ok: true }) } as never}
  yourAppsHost={host}
  onopenintegrations={noop}
  initialWorkScan={workScan}
  onsettled={noop}
  onconfirmname={noop}
  onretry={noop}
  ontalk={noop}
  oncontinueinchat={noop}
/>

<script lang="ts">
  /**
   * Preview of the welcome report (?view=welcome-report) with "Connect your
   * AI apps" and the suggested integrations, from in-page answers (no network,
   * no credentials). The scan is fake: Claude, ChatGPT and Claude Code, plus
   * Linear, Granola and Notion installed and a Linear server in Claude Code.
   * ?state=
   *   ready   the report is ready: the card sits in the brief body, after the
   *           action cards (Shift+A shows "Not shown today" under it)
   *   held    the job is held back (no model): the card sits under that card
   * ?company=
   *   acme    the apps connect to Acme
   *   none    no company: the suggestions still show, Connect opens a new company first
   */
  import type { FoundWorkApps } from '@hq/platform';
  import WelcomeReport from '../../../packages/ui/src/brief/WelcomeReport.svelte';
  import DailyBrief from '../../../packages/ui/src/brief/DailyBrief.svelte';
  import { octoberEightBrief } from '../../../packages/ui/src/brief/brief-fixture';
  import type { YourAppsHost, YourAppsLoad, YourAppsResult } from '../../../packages/ui/src/chat/first-run/your-apps-host';
  import type { CatalogMatch } from '../../../packages/ui/src/chat/first-run/found-apps';

  const params = new URLSearchParams(window.location.search);
  const ready = params.get('state') !== 'held';
  const company = params.get('company') === 'none' ? null : { uid: 'cmp_preview', name: 'Acme' };

  const app = (bundleId: string, name: string) => ({ bundleId, name });
  const SCAN = {
    platform: 'macos',
    scannedAtMs: 1,
    apps: [
      app('com.anthropic.claudefordesktop', 'Claude'),
      app('com.openai.chat', 'ChatGPT'),
      app('com.linear', 'Linear'),
      app('com.granola.app', 'Granola'),
      app('notion.id', 'Notion'),
    ],
    mcpServers: [
      { tool: 'claude_code', name: 'linear', transport: 'http', host: 'mcp.linear.app', local: false, hasCredentialFields: false, enabled: true },
    ],
    sources: [],
    truncated: false,
  } as unknown as FoundWorkApps;

  const m = (entryId: string, name: string, authClass: CatalogMatch['authClass']): CatalogMatch => ({ entryId, name, authClass });
  const load: YourAppsLoad = {
    catalog: {
      'linear.app': m('e-linear', 'Linear', 'oauth'),
      'granola.ai': m('e-granola', 'Granola', 'oauth'),
      'notion.com': m('e-notion', 'Notion', 'oauth'),
    },
    connections: [],
    installations: {},
    canManage: true,
    problem: null,
  };

  const never = <T,>() => new Promise<T>(() => undefined);
  const host: YourAppsHost = {
    detect: async () => SCAN,
    load: async () => load,
    autoConnect: async (): Promise<YourAppsResult> => ({ ok: false, reason: '', retry: false }),
    connect: async (): Promise<YourAppsResult> => never(),
    setup: async (): Promise<YourAppsResult> => never(),
    undo: async (): Promise<YourAppsResult> => ({ ok: true, connectionId: null, installationId: null }),
  };

  const NOW = new Date('2026-10-08T09:00:00');
</script>

<div style="height:100vh;overflow:auto">
  <WelcomeReport
    {ready}
    aiApps={{ detect: async () => SCAN, cli: { claudeCode: true, codex: false } }}
    connect={{ host, company, onnewcompany: async () => never() }}
    blocked={ready ? null : { message: 'Atlas has no model connected on this computer.', label: 'Connect a model', onfix: () => undefined }}
  >
    <DailyBrief
      input={{ ...octoberEightBrief(NOW), today: '2026-10-08' }}
      actions={{ destinations: { assistantName: 'Atlas', claudeCode: true, codex: false }, onassistant: async () => null }}
      onlaunch={async () => null}
    />
  </WelcomeReport>
</div>

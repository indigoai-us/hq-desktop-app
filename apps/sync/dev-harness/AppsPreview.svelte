<script lang="ts">
  import BotAppsPanel from '../../../packages/ui/src/shell/profile-panes/BotAppsPanel.svelte';
  import type { BotApp, ConnectResult, SupportedApp } from '../../../packages/ui/src/shell/profile-panes/bot-apps';
  let { fail = false } = $props<{ fail?: boolean }>();
  let rows = $state<BotApp[]>([
    { id: 'linear', name: 'Linear', domain: 'linear.app', description: 'Issues, projects, and team planning', status: 'ready', detail: 'This connection is available to this bot.', tools: 24, canToggle: true, enabled: true, onBot: true },
    { id: 'notion', name: 'Notion', domain: 'notion.so', description: 'Your team’s shared knowledge', status: 'available', detail: 'Connected to the company. Add access to let this bot use it.', tools: null, canToggle: true, enabled: false, onBot: false },
    { id: 'github', name: 'GitHub', domain: 'github.com', description: 'Code and pull requests', status: 'ready', detail: 'Shared with everyone in the company. Company sharing controls this access.', tools: 18, canToggle: false, enabled: true, onBot: true },
    { id: 'figma', name: 'Figma', domain: 'figma.com', description: 'Design files and components', status: 'attention', detail: 'The bot reported an expired connection. Reconnect from company integrations.', tools: null, canToggle: false, enabled: false, onBot: true },
  ]);
  const all: SupportedApp[] = [
    { id: 'google', name: 'Google Drive', domain: 'drive.google.com', description: 'Find documents and work with shared files.', authClass: 'oauth', entryId: 'google' },
    { id: 'search', name: 'Brave Search', domain: 'brave.com', description: 'Search the web from your bot.', authClass: 'key', entryId: 'search' },
    { id: 'docs', name: 'Context7', domain: 'context7.com', description: 'Look up library documentation.', authClass: 'none', entryId: 'docs' },
  ];
  let catalog = $state<SupportedApp[]>([]);
  let notice = $state('');
  async function search(query: string) { catalog = all.filter(app => `${app.name} ${app.description}`.toLowerCase().includes(query.toLowerCase())); }
  async function connect(app: SupportedApp): Promise<ConnectResult> {
    if (fail) throw new Error('Demo refusal');
    if (!rows.some(row => row.id === app.id)) rows = [...rows, { id: app.id, name: app.name, domain: app.domain, description: app.description, status: 'available', detail: 'Demo company connection. Add access for this bot.', tools: null, enabled: false, onBot: false, canToggle: true }];
    return { kind: 'connected', id: app.id };
  }
  async function toggle(id: string, enabled: boolean) {
    if (fail) throw new Error('Demo refusal');
    rows = rows.map(row => row.id === id ? { ...row, enabled, onBot: enabled, status: enabled ? 'ready' : 'available', detail: enabled ? 'This connection is available to this bot.' : 'Connected to the company. Add access to let this bot use it.' } : row);
  }
</script>
<p class="preview-note">Preview · Demo MCP connections and catalog</p>
<BotAppsPanel {rows} {catalog} {notice} canConnect={true} onsearch={search} onconnect={connect} ontoggle={toggle} onrefresh={async () => {}} />
<style>.preview-note { font-size:11px; color:var(--v4-text-3); margin:0 0 12px; }</style>

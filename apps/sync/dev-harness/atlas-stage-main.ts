import { mount } from 'svelte';
import AtlasView from '../../../packages/ui/src/atlas/AtlasView.svelte';
import { createAtlasCache } from '../../../packages/ui/src/atlas/atlas-cache';
import { ATLAS_SMOKE_DETAIL, smokeAtlasGraph } from '../../../packages/ui/src/atlas/atlas-model';
import { agentAvatarFor } from '../../../packages/ui/src/chat/messaging/agent-avatars';
import '../src/styles/design-system.css';
import '../src/styles/popover.css';
import '../src/desktop-alt/styles/desktop-alt.css';

// Standalone stage for e2e/browser/atlas-today-dock.spec.ts. Mounts the real
// Atlas view with the smoke graph plus the output set of one /brainstorm run
// (five files a project's PRD cites, the shape the local build produces: knowledge
// nodes under the project's folder, no parentId) and a Not on the map dock of
// people and bots, so the spec measures the Today panel and the dock in a real
// engine. ?theme=dark|light.
const NOW = Date.UTC(2026, 8, 30, 12);
const graph = smokeAtlasGraph('Indigo');
const explorer = graph.nodes.find((n) => n.id === 'project:projects/hq-explorer/')!;
explorer.touched = NOW - 2 * 3_600_000;
for (const file of ['brainstorm.md', 'hq-landscape.md', 'market-landscape.md', 'opportunity-sizing.md', 'references.md']) {
  graph.nodes.push({
    id: `knowledge:projects/hq-explorer/${file}`,
    type: 'knowledge',
    label: file.replace(/-/g, ' ').replace(/\.md$/, ''),
    path: `projects/hq-explorer/${file}`,
    folder: false,
    count: 1,
    touched: NOW - 34 * 60_000,
  });
  graph.edges!.push({ source: explorer.id, target: `knowledge:projects/hq-explorer/${file}`, kind: 'cites' });
}
graph.nodes.find((n) => n.id === 'knowledge:knowledge/pricing.md')!.touched = NOW - 5 * 60_000;
graph.nodes.find((n) => n.id === 'policy:policies/tenancy.md')!.touched = NOW - 50 * 60_000;

const people = [
  { actorUid: 'u_hs', name: 'Hana Stone', bot: false, idle: true },
  { actorUid: 'u_sm', name: 'Sam Moss', bot: false },
  { actorUid: 'u_sj', name: 'Sara Jones', bot: false, idle: true },
  { actorUid: 'u_um', name: 'Uma Mills', bot: false, idle: true },
  { actorUid: 'u_un', name: 'Ugo Marsh', bot: false, idle: true },
];
const bots = Array.from({ length: 30 }, (_, i) => {
  const actorUid = `agt_stage_${i}`;
  return { actorUid, name: `bot ${i + 1}`, bot: true, idle: i % 3 !== 0, avatarUrl: agentAvatarFor(actorUid) ?? undefined };
});

const theme = new URLSearchParams(location.search).get('theme') ?? 'dark';
document.documentElement.setAttribute('data-window', 'desktop-alt');
document.documentElement.setAttribute('data-force-theme', theme);
document.documentElement.style.colorScheme = theme;
const target = document.getElementById('atlas-stage')!;
target.style.width = '1440px';
target.style.height = '900px';
target.style.display = 'flex';
target.style.background = 'var(--v4-ground)';
mount(AtlasView, {
  target,
  props: {
    companyUid: 'cmp_stage',
    companyName: 'Indigo',
    cache: createAtlasCache({ fetcher: async () => graph }),
    nowMs: NOW,
    actors: [...people, ...bots],
    motion: false,
    loadDetail: async () => ATLAS_SMOKE_DETAIL,
  },
});

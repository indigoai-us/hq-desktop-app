<script lang="ts">
  import ProjectRow from '../../../packages/ui/src/projects/ProjectRow.svelte';
  import TaskViewPane from '../../../packages/ui/src/projects/TaskViewPane.svelte';
  import MoreCompaniesPopover from '../../../packages/ui/src/shell/MoreCompaniesPopover.svelte';
  import type { Project, Story } from '../../../packages/ui/src/projects/projects-model';

  const now = Date.now();
  const ago = (min: number) => new Date(now - min * 60_000).toISOString();
  const people = (owner: string, assignee?: string) =>
    ({ owner: { label: owner }, ...(assignee ? { assignee: { label: assignee } } : {}) }) as never;

  const projects: Project[] = [
    {
      id: 'self-improving-handoff', title: 'HQ core: self-improving handoff',
      description: 'Handoffs learn from the last session and repair missing context before the next agent starts.',
      company: 'indigo', status: 'in_progress', prdPath: 'p1', storiesTotal: 6, storiesComplete: 5,
      updatedAt: ago(600), repos: ['hq-core-staging', 'hq-desktop-app', 'hq-cli', 'hq-pro', 'hq-cloud'],
      branchName: 'feature/self-improving-handoff-repair-loop',
      provenance: people('Corey Epstein', 'Hassaan Saleem'),
    },
    {
      id: 'board-env', title: 'Environment deficiency sweep for fleet boxes',
      description: 'Collect environment deficiencies from every agent box and file one fix per gap.',
      company: 'indigo', status: 'in_progress', prdPath: 'p2', storiesTotal: 6, storiesComplete: 1,
      updatedAt: ago(6), repos: ['hq-pro'], branchName: 'feature/env-deficiency-sweep',
      provenance: people('Hassaan Saleem', 'Corey Epstein'),
    },
    {
      id: 'short', title: 'Quiet chat callouts',
      description: '', company: 'indigo', status: 'in_progress', prdPath: 'p3',
      storiesTotal: 3, storiesComplete: 3, updatedAt: ago(90),
      provenance: people('Corey Epstein'),
    },
  ];

  const stories: Story[] = [
    ['US-001', 'Collect environment deficiencies from every fleet agent box into one report', true],
    ['US-002', 'Classify each deficiency by owner and severity', false],
    ['US-003', 'File one fix PR per gap with a regression check', false],
    ['US-004', 'Re-run the census and confirm zero open gaps', false],
    ['US-005', 'Post the summary to the team thread', false],
    ['US-006', 'Retire the manual checklist', false],
  ].map(([id, title, passes]) => ({
    id: id as string, title: title as string, passes: passes as boolean,
    description: 'As an operator, I want every box environment gap collected in one place so that fixes are filed once and nothing is missed between boxes.',
    acceptanceCriteria: [
      'A single command collects deficiencies from every box listed in the fleet registry and writes one JSON report.',
      'Each entry names the box, the missing tool or setting, and the command that detected it.',
      'Boxes that cannot be reached are listed separately with the reason, never silently skipped.',
    ],
    labels: [], dependsOn: id === 'US-002' ? ['US-001'] : [],
  }));

  let selectedStory = $state(true);
</script>

<div class="stage">
  <section class="column" aria-label="Active">
    <header class="col-head"><span class="dot"></span>Active <span class="n">5</span></header>
    <div class="cards">
      <ProjectRow project={projects[0]} column="active" showCompany={false} activityLabel={null} {now} />
      <ProjectRow project={projects[1]} column="active" showCompany={false}
        activityLabel="active · Hassaan Saleem, 6 min ago" {now} />
      <ProjectRow project={projects[2]} column="complete" showCompany={false} {now} />
    </div>
  </section>

  {#if selectedStory}
    <TaskViewPane
      project={projects[1]}
      {stories}
      sessions={[]}
      branch="feature/env-deficiency-sweep-collect-and-classify"
      lead="hassaan@getindigo.ai"
      onclose={() => (selectedStory = false)}
      onopenproject={() => {}}
      onmarkdone={() => {}}
    />
  {/if}
</div>

<MoreCompaniesPopover
  companies={[
    { uid: 'a', name: 'Indigo', slug: 'indigo', liveCount: 2 },
    { uid: 'b', name: 'Personal', slug: 'personal', liveCount: 0 },
    { uid: 'c', name: 'Sender Agency', slug: 'sender-agency', liveCount: 0 },
    { uid: 'd', name: 'LiveRecover', slug: 'liverecover', liveCount: 1 },
    { uid: 'e', name: 'Keptwork', slug: 'keptwork', liveCount: 0 },
    { uid: 'f', name: 'Amass', slug: 'amass', liveCount: 0 },
    { uid: 'g', name: 'Golden Thread', slug: 'golden-thread', liveCount: 0 },
  ]}
  pinnedIds={['a', 'b']}
  recentIds={['d']}
  anchorTop={24}
  anchorLeft={1060}
/>

<style>
  .stage {
    display: flex;
    gap: 24px;
    height: 760px;
    padding: 24px;
    background: var(--v4-window, var(--v4-secondary-sidebar));
    color: var(--v4-text-1);
    font-family: var(--font-ui);
  }
  .column { width: 280px; flex: none; }
  .col-head { display: flex; align-items: center; gap: 8px; padding: 0 4px 12px; font-size: 13px; color: var(--v4-text-2); }
  .col-head .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--v4-ok); }
  .col-head .n { color: var(--v4-text-3); }
  .cards { display: flex; flex-direction: column; gap: 8px; }
</style>

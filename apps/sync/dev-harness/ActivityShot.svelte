<!--
  Activity preview for screenshots: ?view=activity-shot. Fixed team telemetry
  with per-model tokens and sessions; click a row to open the person panel.
-->
<script lang="ts">
  import ActivityView from '../../../packages/ui/src/activity/ActivityView.svelte';

  const counts = (input: number) => ({ input, output: 0, cacheCreation: 0, cacheRead: 0 });
  const trend = (seed: number) => Array.from({ length: 30 }, (_, i) => ((i * seed) % 7 > 2 ? ((i * seed) % 11) * 1000 : 0));
  const member = (
    personUid: string,
    label: string,
    email: string,
    models: Record<string, [number, number]>,
    seed: number,
    stories: number,
  ) => ({
    personUid,
    label,
    email,
    tokensByModel: Object.fromEntries(Object.entries(models).map(([m, [t]]) => [m, counts(t)])),
    sessionsByModel: Object.fromEntries(Object.entries(models).map(([m, [, s]]) => [m, s])),
    distinctSessions: Object.values(models).reduce((n, [, s]) => n + s, 0),
    events: 40,
    trend: trend(seed),
    skills: { 'run-project': 12, handoff: 7, review: 4 },
    services: { github: 22, linear: 6 },
    outcomes: { byType: { storyCompleted: stories, prMerged: Math.round(stories / 2), deploySucceeded: 2 }, total: stories + 4 },
  });
  const telemetry = {
    members: [
      member('prs_corey', 'Ada Park', 'ada@example.com', { 'claude-opus-5-5': [8_400_000, 42], 'gpt-5.6-sol': [1_600_000, 9], 'grok-4.5': [300_000, 3] }, 3, 14),
      member('prs_hassaan', 'Ben Ortiz', 'ben@example.com', { 'claude-opus-5-5': [3_100_000, 18] }, 5, 9),
      member('prs_stefan', 'Cleo Ward', 'cleo@example.com', { 'gpt-5.6-sol': [2_200_000, 15], 'claude-sonnet-5-5': [900_000, 4] }, 4, 6),
      member('prs_archit', 'Dev Shah', 'dev@example.com', { 'claude-fable-5-1': [1_200_000, 11], 'claude-haiku-5-5': [200_000, 6] }, 6, 4),
      { personUid: 'prs_jacob', label: 'Eli Brooks', email: 'eli@example.com', tokensByModel: {}, distinctSessions: 3, events: 5, trend: trend(2) },
    ],
  };
  const adapter = { company: { getTeamTelemetry: async () => ({ ok: true, value: telemetry }) } };
</script>

<div style="height: 100vh">
  <ActivityView slug="indigo-shot" companyLabel="Indigo" adapter={adapter as never} />
</div>

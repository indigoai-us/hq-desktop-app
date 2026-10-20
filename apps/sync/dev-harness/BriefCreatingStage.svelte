<script lang="ts">
  // The Create brief scene on the design stage: the real BriefRunsPage driving a
  // simulated ~20 s run (brief-demo.ts), then handing off to the stage's fixture
  // day, so the creating animation and the swap to the finished brief can be
  // reviewed in light and dark with no bot.
  //   &state=creating            first brief: the full-page scene, then the brief
  //   &state=creating&over=brief a new run over today's brief: the band under the run controls
  //   &state=failed              the run stops at 45% (Try again / Dismiss)
  //   &state=waiting             the first-visit empty state; Create brief starts the simulated run
  //   &briefDemoAt=0..1          a frozen frame at that progress (with &state=creating)
  import { onDestroy } from 'svelte';
  import BriefRunsPage from '../../../packages/ui/src/brief/BriefRunsPage.svelte';
  import { BriefCreateRun } from '../../../packages/ui/src/brief/brief-create.svelte';
  import { briefDemoFromUrl } from '../../../packages/ui/src/brief/brief-demo';
  import { configureBriefSeed } from '../../../packages/ui/src/brief/brief-seed';
  import type { BriefSweepSource } from '../../../packages/ui/src/brief/brief-data';
  import type { BriefInput } from '../../../packages/ui/src/brief/brief-types';

  interface Props {
    input: BriefInput;
    companies: { uid: string; slug?: string | null; label: string; iconUrl?: string | null }[];
    mode: 'creating' | 'failed' | 'waiting';
    /** A brief already shows; the new run plays as the band over it. */
    over: boolean;
    /** Bumped by the stage's Replay button. */
    replay: number;
  }
  let { input, companies, mode, over, replay }: Props = $props();

  // The finished brief is the stage's fixture day.
  $effect(() => {
    const day = input;
    configureBriefSeed(() => day);
  });
  onDestroy(() => configureBriefSeed(null));

  const PRIOR = 'brief-20261014-071500';
  function make() {
    const demo = briefDemoFromUrl(mode === 'failed' ? '?briefDemo=fail' : '?briefDemo=1')!;
    let ready: string | null = null;
    // The demo serves status.json; the index lists the prior brief (for the band)
    // and the new run once it reports ready, so the page hands off to it.
    const source: BriefSweepSource = {
      async readHqFile(path) {
        const text = await demo.source.readHqFile(path);
        const m = /workspace\/brief\/(brief-[\d-]+)\/status\.json$/.exec(path);
        if (m && text && JSON.parse(text).state === 'ready') ready = m[1]!;
        if (path === 'workspace/brief/index.jsonl') {
          const line = (id: string, at: string) => JSON.stringify({ run_id: id, created_at: at, state: 'ready', lead: 'decisions', headline: 'Four decisions before sunrise', counts: { decisions: 4, shipped: 9, incidents: 1 } });
          const lines = [];
          if (ready) lines.push(line(ready, new Date().toISOString()));
          if (over) lines.push(line(PRIOR, new Date(Date.now() - 3600_000).toISOString()));
          return lines.join('\n') || null;
        }
        return text;
      },
    };
    const run = new BriefCreateRun({ creator: demo.creator, read: (p) => source.readHqFile(p), storage: null });
    return { run, source };
  }
  const frozen = new URLSearchParams(location.search).has('briefDemoAt');
  let stage = $state(make());
  let first = true;
  $effect(() => {
    void replay;
    if (first) {
      first = false;
      if (!frozen && mode !== 'waiting') setTimeout(() => void stage.run.start(), over ? 1200 : 600);
      return;
    }
    stage.run.stop();
    stage = make();
    if (mode !== 'waiting') setTimeout(() => void stage.run.start(), 400);
  });
  onDestroy(() => stage.run.stop());
</script>

{#key stage}
  <BriefRunsPage adapter={{}} {companies} source={stage.source} run={stage.run} />
{/key}

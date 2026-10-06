<!--
  Frozen-clock Meetings preview for screenshots: ?view=meetings-shot&at=midday|evening
  (list) and &pane=recap (HQ GTM Sync recap). Fixed dates, local clock.
-->
<script lang="ts">
  import MeetingsSidepane from '../../../packages/ui/src/meetings/MeetingsSidepane.svelte';
  import MeetingsStatesBody from '../../../packages/ui/src/meetings/MeetingsStatesBody.svelte';
  import { meetingsRailSections, EMPTY_MEETINGS_FILTER } from '../../../packages/ui/src/meetings/meetings-rail-model';
  import type { MeetingEvent, ScheduledBot } from '../../../packages/ui/src/meetings/meetings-model';

  const params = new URLSearchParams(window.location.search);
  const pane = params.get('pane') ?? 'list';
  const now = params.get('at') === 'evening' ? new Date(2026, 9, 6, 20, 5) : new Date(2026, 9, 6, 10, 0);
  const t = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();
  const ev = (id: string, title: string, d: number, h: number, m: number, mins: number, co?: string): MeetingEvent => ({
    id,
    summary: title,
    status: 'confirmed',
    start: { dateTime: t(d, h, m) },
    end: { dateTime: new Date(new Date(t(d, h, m)).getTime() + mins * 60_000).toISOString() },
    meetingUrl: `https://zoom.us/j/${id}`,
    sourceCompanyUid: co,
  });
  const events: MeetingEvent[] = [
    ev('vyg', 'VYG Standup', 6, 7, 30, 30, 'cmp_vyg'),
    ev('dev', 'HQ Dev Standup', 6, 9, 0, 30, 'cmp_in'),
    ev('lr', 'LR | VYG Sync', 6, 12, 30, 30, 'cmp_lr'),
    ev('cut30', 'Cut30 Live Session', 6, 19, 0, 60),
    ev('t1', 'HQ Dev Standup', 7, 9, 0, 30, 'cmp_in'),
    ev('t2', 'Pricing review', 7, 10, 0, 30, 'cmp_in'),
    ev('t3', 'LR weekly', 7, 11, 0, 30, 'cmp_lr'),
    ev('t4', 'Design crit', 7, 14, 0, 45, 'cmp_in'),
    ev('t5', 'Investor call', 7, 16, 0, 30),
    ev('y1', 'HQ GTM Sync', 5, 10, 30, 30, 'cmp_in'),
    ev('y2', 'VYG Standup', 5, 7, 30, 30, 'cmp_vyg'),
    ev('f1', 'Weekly creative review', 2, 11, 0, 45, 'cmp_in'),
  ];
  const landed = (id: string): [string, ScheduledBot] => [id, { botId: `b-${id}`, meetingUrl: '', platform: 'zoom', status: 'completed', calendarEventId: id, autoScheduled: false, sourceLanded: true }];
  const bots = new Map<string, ScheduledBot>([landed('vyg'), landed('dev'), landed('y1'), landed('y2')]);
  const names = new Map([['cmp_in', 'Indigo'], ['cmp_lr', 'LiveRecover'], ['cmp_vyg', 'Voyage']]);
  const sections = meetingsRailSections({ events, botsByEventId: bots, companyNamesByUid: names, now });

  const SUMMARY = `## Summary

**Meeting:** HQ GTM Sync — 2026-10-05
**Participants:** Corey Epstein, Jacob Posel, Caitlin Hutchinson, Cherie Ueno, Jonathan Bach, Amir Torabi

### Key Topics

1. **Google Ads Update** — Caitlin reported ~$400 spent, 3 sign-ups at $104 cost-per-signup. Branded search and display retargeting first.
2. **Attribution / CDP** — Contact tagging and attribution tracking using Voyage CDP.
3. **HQ AI Super User Course & Certification** — A paid course with an official HQ Pro certification badge.
4. **Referral Program** — Referral tracking is live; Stripe payouts still to be completed.
5. **UGC / Micro-Creator Affiliate Program** — Test UGC via a service like Tribe (3–5 videos to start).
6. **LinkedIn Plagiarism Issue** — Jacob to send the agency response to Cherie to reply.

### Next Steps
- Jacob to close loop on Stripe payouts for referrals.
- Cherie to remind Stefan about automation connections needed.
- Team to launch next bot/feature on Wednesday.
- Jacob to put together backlog of upcoming launches.
- Meta Ads moving to $50/day with Cherie this week.
- Corey/Cherie/Jonathan to explore UGC sourcing via Tribe.`;
  // "Before" reproduces the old reader, which joined the body onto one line.
  const flat = SUMMARY.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).filter(Boolean).join(' ');
  const body = params.get('flat') === '1' ? flat : SUMMARY.replace(/^## Summary\n+/, '');
  const recapEvent = {
    id: 'recorded:gtm',
    summary: 'HQ GTM Sync',
    status: 'confirmed',
    start: { dateTime: t(5, 10, 30) },
    end: { dateTime: t(5, 11, 0) },
    sourceCompanyUid: 'cmp_in',
    recorded: { meetingId: 'gtm', durationLabel: '30m', hasSignals: true },
    signals: { summary: body },
  } as unknown as MeetingEvent;
</script>

{#if pane === 'recap'}
  <div style="width:1180px;height:760px;">
    <MeetingsStatesBody {...({ mode: 'recap', event: recapEvent, now } as any)} />
  </div>
{:else}
  <div style="width:300px;height:760px;">
    <MeetingsSidepane {sections} {events} companyNamesByUid={names} selectedId={null} filter={EMPTY_MEETINGS_FILTER} />
  </div>
{/if}

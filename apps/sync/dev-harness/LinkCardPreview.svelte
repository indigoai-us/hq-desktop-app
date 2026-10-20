<script lang="ts">
  /**
   * Preview of chat link hovercards for GitHub PRs and issues (?view=link-card).
   * Hover a link to open its card. Live details come from a fixture fetcher in
   * place of the link_github_summary Tauri command; #3 has no details, the
   * way a private repo looks without a GitHub sign-in. Zero network.
   */
  import { ChannelConversation, setGithubSummaryFetcher, type ConversationMessageWire } from '@hq/ui';

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
  const summaries: Record<string, unknown> = {
    'https://github.com/acme/desktop/pull/1699': {
      kind: 'pull',
      title: 'Desktop usage meter and Settings > Usage (usage-only-pricing US-018)',
      state: 'open',
      review: 'changes_requested',
      author: 'maya-chen',
      updatedAt: hoursAgo(16),
      additions: 2340,
      deletions: 161,
      changedFiles: 28,
    },
    'https://github.com/acme/hq-pro/pull/5020': {
      kind: 'pull',
      title: 'Booking: hold the slot while checkout finishes',
      state: 'merged',
      author: 'sam-ortiz',
      updatedAt: hoursAgo(2),
      additions: 412,
      deletions: 37,
      changedFiles: 9,
    },
    'https://github.com/acme/desktop/pull/1710': {
      kind: 'pull',
      title: 'Show Not connected for brain providers that are not signed in',
      state: 'open',
      review: 'approved',
      author: 'li-wei',
      updatedAt: hoursAgo(0.3),
      additions: 58,
      deletions: 12,
      changedFiles: 1,
    },
    'https://github.com/acme/desktop/issues/830': {
      kind: 'issue',
      title: '"Finish setting up HQ" card is rendered nowhere in the live shell',
      state: 'open',
      author: 'maya-chen',
      updatedAt: hoursAgo(72),
      comments: 6,
    },
  };
  setGithubSummaryFetcher(async (url) => (summaries[url] as never) ?? null);

  const from = { fromPersonUid: 'prs_maya', fromDisplayName: 'Maya Chen', direction: 'in' };
  const at = (min: number) => new Date(Date.UTC(2026, 9, 19, 15, min, 0)).toISOString();
  const messages: ConversationMessageWire[] = [
    {
      ...from,
      eventId: 'm1',
      body: 'Review status: https://github.com/acme/desktop/pull/1699 needs another pass, https://github.com/acme/hq-pro/pull/5020 landed this morning.',
      createdAt: at(1),
    },
    {
      ...from,
      eventId: 'm2',
      body: 'Approved: https://github.com/acme/desktop/pull/1710 and the open bug https://github.com/acme/desktop/issues/830. No details for https://github.com/acme/private/pull/3.',
      createdAt: at(2),
    },
  ];
</script>

<div class="link-card-stage" data-window="messages">
  <ChannelConversation {messages} channelId="dm_preview" onsend={() => {}} />
</div>

<style>
  .link-card-stage {
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--bg, #141416);
    color: var(--t1, #eee);
  }
</style>

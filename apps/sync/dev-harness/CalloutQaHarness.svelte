<script lang="ts">
  import RichMessageContent from '../../../packages/ui/src/chat/messaging/RichMessageContent.svelte';

  const content = {
    v: 1,
    blocks: [
      {
        kind: 'callout',
        tone: 'warning',
        title: 'Could not check Sol in',
        body: 'Needs your rec login. Nov 4:30 is still 3/6. Sign in on Dash or call the desk.',
      },
      { kind: 'callout', tone: 'danger', title: 'Sync failed', body: 'The vault rejected the upload. Try again in a minute.' },
      { kind: 'callout', tone: 'info', title: 'New in this build', body: 'Threads now keep their scroll position.' },
      { kind: 'callout', tone: 'success', title: 'Booked', body: 'Court 2 is yours on Tuesday at 6pm.' },
    ],
  } as any;
</script>

<div class="chat-shell" style="padding: 24px; width: 560px; min-height: 100vh; background: var(--bg, var(--pop-bg));">
  <RichMessageContent {content} />
</div>

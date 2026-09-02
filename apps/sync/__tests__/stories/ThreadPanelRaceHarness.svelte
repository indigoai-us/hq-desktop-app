<script lang="ts">
  import ThreadPanel from '../../src/components/messaging/ThreadPanel.svelte';

  let rootEventId = $state('root-a');
  let withPersonUid = $state('person-a');

  function selectRoot(root: 'a' | 'b'): void {
    rootEventId = `root-${root}`;
    withPersonUid = `person-${root}`;
  }
</script>

<button type="button" data-testid="root-a" onclick={() => selectRoot('a')}>Root A</button>
<button type="button" data-testid="root-b" onclick={() => selectRoot('b')}>Root B</button>

<ThreadPanel
  {rootEventId}
  scope="dm"
  channelId={null}
  {withPersonUid}
  title={`Thread ${rootEventId}`}
  showAuthors={false}
  onclose={() => {}}
/>

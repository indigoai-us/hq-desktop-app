<script lang="ts">
  import DmThreadPane, {
    type DmEvent,
  } from '../../src/components/DmThreadPane.svelte';

  const alice: DmEvent = {
    eventId: 'alice-opening',
    fromPersonUid: 'person-alice',
    fromEmail: 'alice@example.com',
    fromDisplayName: 'Alice',
    body: 'Alice opening',
    createdAt: '2026-07-28T12:01:00.000Z',
  };
  const bob: DmEvent = {
    eventId: 'bob-opening',
    fromPersonUid: 'person-bob',
    fromEmail: 'bob@example.com',
    fromDisplayName: 'Bob',
    body: 'Bob opening',
    createdAt: '2026-07-28T12:02:00.000Z',
  };

  let selected = $state(alice);
</script>

<button data-testid="select-bob" onclick={() => (selected = bob)}>Bob</button>
<DmThreadPane event={selected} />

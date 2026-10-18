<script lang="ts">
  import LazyDoor from '../LazyDoor.svelte';
  import ProfilePaneHost from './ProfilePaneHost.svelte';
  let revision = $state(0);
  let uid = $state('agt_a');
  const agents = {
    getStatus: async () => ({ ok: true, value: {} }),
    listJobs: async () => ({ ok: true, value: { jobs: [] } }),
    getCompanyTelemetry: async () => ({ ok: false }),
    getProfile: async () => ({ ok: true, value: { agent: { uid: 'agt_a', displayName: 'Scout', title: 'Researcher', description: 'Find answers.' }, editable: { title: true, description: true } } }),
    updateProfile: async () => ({ ok: true, value: {} }),
  };
  const door = { peek: () => ProfilePaneHost, load: async () => ProfilePaneHost, preload: () => {} };
</script>
<button onclick={() => revision++}>Refresh shell</button>
<button onclick={() => uid = 'agt_b'}>Switch bot</button>
<LazyDoor {door} props={{ kind: 'bot', runtimeKind: 'cloud', agents, name: 'Local bot', agentUid: uid, companyUid: 'cmp_a', live: revision % 2 === 0 }} />

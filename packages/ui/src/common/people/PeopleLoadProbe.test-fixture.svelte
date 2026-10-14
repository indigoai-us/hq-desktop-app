<script lang="ts">
  // Test fixture: the pattern pages use (load in an effect, read reactively).
  import { loadPeople, peopleFor } from "./people-roster.svelte.js";
  import { resolvePerson } from "./people.js";
  let { slug }: { slug: string } = $props();
  $effect(() => {
    void loadPeople({ slug });
  });
  const roster = $derived(peopleFor(slug));
</script>{resolvePerson(roster.index, "prs_a").name}

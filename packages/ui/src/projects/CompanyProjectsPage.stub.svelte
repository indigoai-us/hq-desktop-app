<script lang="ts">
  let { slug, companyUid = null }: { slug: string; companyUid?: string | null } = $props();
</script>

<div data-testid="projects-stub" data-slug={slug} data-uid={companyUid}></div>

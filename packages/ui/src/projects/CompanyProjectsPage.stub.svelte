<script lang="ts">
  let {
    slug,
    companyUid = null,
    pickerCompanies = null,
  }: { slug: string; companyUid?: string | null; pickerCompanies?: readonly string[] | null } = $props();
</script>

<div
  data-testid="projects-stub"
  data-slug={slug}
  data-uid={companyUid}
  data-picker={pickerCompanies?.join(",") ?? ""}
></div>

<script lang="ts">
  /**
   * Finished fallback for an Indigo-only surface (RELEASE-001): the page
   * title and one plain sentence. Makes no data calls.
   */
  interface Props {
    title: string;
    body: string;
    testid?: string;
  }

  let { title, body, testid = "coming-soon" }: Props = $props();
</script>

<section class="soon" data-testid={testid}>
  <h1>{title}</h1>
  <p>Coming soon. {body}</p>
</section>

<style>
  .soon { padding: 24px; display: grid; gap: 8px; align-content: start; }
  h1 { margin: 0; font-size: 20px; line-height: 28px; font-weight: 500; color: var(--v4-text-1); }
  p { margin: 0; font-size: 13px; line-height: 18px; color: var(--v4-text-2); }
</style>

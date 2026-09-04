<script lang="ts">
  /**
   * Root layout — imports the global full-bleed foundation so every route
   * (the shell, the deep-link app routes, and the sign-in page) inherits the
   * zero-margin / no-page-scroll document reset. The shell itself owns the
   * viewport (100vh) from the root +page.
   */
  import "../app.css";

  let { children } = $props();
</script>

{@render children()}

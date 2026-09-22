<script lang="ts">
  // Stands in for a CinematicIntro that cannot run on this machine — no WebGL
  // context, a shader that will not compile, a driver that throws. The failure
  // happens during instantiation, which is what `<svelte:boundary>` catches.
  throw new Error('cinematic intro: simulated GPU failure');
</script>

<script lang="ts">
  function renderFailure(): string {
    throw new Error(
      'The desktop preview hit a recoverable rendering error while loading this surface.',
    );
  }
</script>

<p>{renderFailure()}</p>

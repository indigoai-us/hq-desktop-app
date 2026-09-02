<script lang="ts">
  /**
   * Sessions, as an `@hq/ui` `extraPages` destination.
   *
   * The HQ Work shell knows nothing about sessions: it hands this component an
   * opaque `param` and takes an opaque `param` back. This adapter is the only
   * place that says the param IS a session id — `SessionsPage` keeps its
   * classic-shell props, and `packages/ui` keeps its Tauri-free boundary.
   */
  import { dispatchEmbeddedNavigation } from '@hq/ui';
  import SessionsPage from './SessionsPage.svelte';

  interface Props {
    /** The shell's opaque selection — here, the routed session id. */
    param?: string | null;
    /** Report the session the user opened back to the shell. */
    onnavigate?: (param: string | null) => void;
  }

  let { param = null, onnavigate }: Props = $props();
</script>

<!--
  "open channel" after a share goes through the shell's own channel target —
  the same `{ kind: 'channel' }` an `hqwork://open?channel=<id>` deep link
  resolves to in hq-work-host's `routeTarget`.
-->
<SessionsPage
  sessionId={param ?? undefined}
  onopensession={(id) => onnavigate?.(id || null)}
  onopenchannel={(channelId) => dispatchEmbeddedNavigation({ kind: 'channel', channelId })}
/>

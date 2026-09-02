<script lang="ts">
  /**
   * Sessions, as an `@hq/ui` `extraPages` destination.
   *
   * The HQ Work shell knows nothing about sessions: it hands this component an
   * opaque `param` and takes an opaque `param` back. This adapter is the only
   * place that says what the param IS — a session id, or `new?company=…&project=…`
   * for a fresh chat pre-bound to a project (the sidebar's "New session" on a
   * project channel). `SessionsPage` keeps its classic-shell props, and
   * `packages/ui` keeps its Tauri-free boundary.
   */
  import { dispatchEmbeddedNavigation } from '@hq/ui';
  import SessionsPage from './SessionsPage.svelte';
  import { parseSessionsParam } from './sessions-route-param';

  interface Props {
    /** The shell's opaque selection — here, the routed session id. */
    param?: string | null;
    /** Report the session the user opened back to the shell. */
    onnavigate?: (param: string | null) => void;
  }

  let { param = null, onnavigate }: Props = $props();

  const route = $derived(parseSessionsParam(param));
</script>

<!--
  "open channel" after a share goes through the shell's own channel target —
  the same `{ kind: 'channel' }` an `hqwork://open?channel=<id>` deep link
  resolves to in hq-work-host's `routeTarget`.
-->
<SessionsPage
  sessionId={route.kind === 'session' ? route.sessionId : undefined}
  initialCompany={route.kind === 'new' ? route.company : null}
  initialProject={route.kind === 'new' ? route.project : null}
  onopensession={(id) => onnavigate?.(id || null)}
  onopenchannel={(channelId) => dispatchEmbeddedNavigation({ kind: 'channel', channelId })}
/>

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
  import SharedSessionPage from './SharedSessionPage.svelte';
  import { parseSessionsParam } from './sessions-route-param';
  import type { AgentSession } from '../lib/sessions';

  interface Props {
    /** The shell's opaque selection — here, the routed session id. */
    param?: string | null;
    /** Report the session the user opened back to the shell. */
    onnavigate?: (param: string | null) => void;
  }

  let { param = null, onnavigate }: Props = $props();

  const route = $derived(parseSessionsParam(param));
  const historySession = $derived<AgentSession | null>(
    route.kind === 'history'
      ? {
          id: route.sessionId,
          tool: route.tool,
          origin: 'local',
          title: route.title || undefined,
          cwd: '',
          project: route.project,
          company: route.company,
          model: '',
          status: 'ended',
          startedAt: route.startedAt,
          lastActivityAt: route.startedAt,
          source: 'project-session-link',
        }
      : null,
  );
</script>

<!--
  "open channel" after a share goes through the shell's own channel target —
  the same `{ kind: 'channel' }` an `hqwork://open?channel=<id>` deep link
  resolves to in hq-work-host's `routeTarget`.
-->
{#if route.kind === 'shared'}
  <SharedSessionPage channelId={route.channelId} sessionId={route.sessionId} />
{:else}
<SessionsPage
  sessionId={route.kind === 'session' || route.kind === 'history' ? route.sessionId : undefined}
  initialHistorySession={historySession}
  initialCompany={route.kind === 'new' ? route.company : null}
  initialProject={route.kind === 'new' ? route.project : null}
  initialChannelId={route.kind === 'new' ? route.channelId : undefined}
  initialPrompt={route.kind === 'new' ? (route.prompt ?? null) : null}
  initialPrefill={route.kind === 'new' ? (route.prefill ?? null) : null}
  onopensession={(id) => onnavigate?.(id || null)}
  onopenchannel={(channelId) => dispatchEmbeddedNavigation({ kind: 'channel', channelId })}
/>
{/if}

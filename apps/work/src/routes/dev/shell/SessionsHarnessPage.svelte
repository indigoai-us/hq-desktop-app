<script lang="ts">
  /**
   * The Sessions page, wired to fixtures.
   *
   * The desktop injects its own Sessions page from `apps/sync`, which this
   * harness cannot mount — but the panel it renders lives in `@hq/ui`, so the
   * surface itself is reviewable here. Without this the page was a placeholder
   * and two icons (the empty-state broadcast mark, the outpost row mark) had
   * no way to appear on screen at all.
   *
   * `?sessions=empty` returns an empty snapshot so the empty state can be
   * judged too; anything else returns a small fleet plus an outpost.
   */
  import { sessions as sessionsArea } from "@hq/ui";

  const LiveSessionsPanel = sessionsArea.LiveSessionsPanel;
  import { ok } from "@hq/platform";

  // The extra-page contract passes these; this surface needs none of them.
  let _props: {
    param?: string | null;
    restoreScroll?: unknown;
    onnavigate?: (param: string | null) => void;
  } = $props();

  const empty =
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).get("sessions") === "empty";

  const minutesAgo = (n: number) =>
    new Date(Date.now() - n * 60_000).toISOString();

  const snapshot = empty
    ? { sessions: [], history: [], outpost: null }
    : {
        sessions: [
          {
            id: "ses_local_claude",
            tool: "claude",
            origin: "local",
            cwd: "~/Desktop/hq/repos/private/hq-desktop-app",
            project: "hq-desktop-app",
            company: "indigo",
            model: "claude-opus-5",
            status: "running",
            startedAt: minutesAgo(42),
            lastActivityAt: minutesAgo(1),
            source: "claude-jsonl",
          },
          {
            id: "ses_local_codex",
            tool: "codex",
            origin: "local",
            cwd: "~/Desktop/hq/repos/public/knowledge-hq",
            project: "knowledge-hq",
            company: "indigo",
            model: "gpt-5-codex",
            status: "awaiting_input",
            startedAt: minutesAgo(18),
            lastActivityAt: minutesAgo(4),
            source: "codex-rollout",
          },
          {
            id: "ses_outpost_claude",
            tool: "claude",
            origin: "outpost",
            cwd: "/srv/hq/liverecover",
            project: "liverecover",
            company: "liverecover",
            model: "claude-sonnet-5",
            status: "running",
            startedAt: minutesAgo(96),
            lastActivityAt: minutesAgo(2),
            source: "outpost-heartbeat",
          },
        ],
        history: [],
        outpost: {
          up: true,
          runtime: "4d 6h",
          relayConnected: true,
          ip: "10.0.4.18",
          region: "sfo3",
          lastSeenAt: minutesAgo(1),
          stale: false,
        },
      };

  const api = { listAgentSessions: async () => ok(snapshot) };
</script>

<div class="sessions-harness">
  <LiveSessionsPanel {api} />
</div>

<style>
  .sessions-harness {
    height: 100%;
    overflow: auto;
    padding: 16px 20px 24px;
  }
</style>

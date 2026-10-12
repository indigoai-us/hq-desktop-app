<script lang="ts">
  /**
   * Preview stage for the per-bot integration section
   * (packages/ui/src/chat/messaging/BotIntegrationsSection.svelte). The section
   * is a shared child of AgentDetailPanel + LocalBotDetailPanel; this stage
   * mounts it twice (one card labeled Agent profile, one labeled Local bot) so
   * screenshots document both surfaces without the full panel plumbing.
   */
  // Direct path into the ui package since the component is not exported from
  // the package root (keeping it internal). Vite resolves this via workspace
  // path; the preview is harness-only.
  import BotIntegrationsSection from "../../../packages/ui/src/chat/messaging/BotIntegrationsSection.svelte";

  type OkResult<T> = { ok: true; value: T };
  type FailResult = { ok: false; reason: string };
  type Result<T> = OkResult<T> | FailResult;

  const CONNECTIONS_ENVELOPE = {
    viewer: { personUid: "usr_me", canManageIntegrations: true },
    connections: [
      {
        id: "acct_linear",
        provider: "linear",
        status: "connected",
        createdBy: "usr_me",
        createdAt: "2026-10-10T00:00:00Z",
        installation: { displayName: "Linear" },
        access: { mode: "shared" },
      },
      {
        id: "acct_notion",
        provider: "notion",
        status: "connected",
        createdBy: "usr_me",
        createdAt: "2026-10-09T00:00:00Z",
        installation: { displayName: "Notion" },
        access: { mode: "shared" },
      },
      {
        id: "acct_gmail",
        provider: "gmail",
        status: "connected",
        createdBy: "usr_other",
        createdAt: "2026-10-08T00:00:00Z",
        installation: { displayName: "Gmail (Alex)" },
        access: { mode: "private" },
      },
      {
        id: "acct_github",
        provider: "github",
        status: "connected",
        createdBy: "usr_me",
        createdAt: "2026-10-07T00:00:00Z",
        installation: { displayName: "GitHub" },
        access: { mode: "everyone" },
      },
    ],
    audit: [],
  };

  function makeAdapter() {
    const stateByConnection = new Map<string, string>([
      ["acct_linear", "shared-on"],
      ["acct_notion", "shared-off"],
      ["acct_gmail", "private"],
      ["acct_github", "everyone"],
    ]);
    return {
      identity: {
        async hasFeature(): Promise<Result<boolean>> {
          return { ok: true, value: true };
        },
      },
      integrations: {
        async listConnections(): Promise<Result<unknown>> {
          return { ok: true, value: CONNECTIONS_ENVELOPE };
        },
        async getConnectionAccess(input: {
          companyUid: string;
          connectionId: string;
        }): Promise<Result<unknown>> {
          const kind = stateByConnection.get(input.connectionId) ?? "shared-off";
          if (kind === "everyone") {
            return {
              ok: true,
              value: {
                access: { mode: "everyone" },
                canManage: true,
                entries: [],
              },
            };
          }
          if (kind === "private") {
            return {
              ok: true,
              value: {
                access: { mode: "private" },
                canManage: false,
                entries: [],
              },
            };
          }
          const entries =
            kind === "shared-on"
              ? [
                  { granteeType: "agent", granteeId: "agt_nova", permission: "use" },
                ]
              : [];
          return {
            ok: true,
            value: {
              access: { mode: "shared" },
              canManage: true,
              entries,
            },
          };
        },
        async grantConnectionAccess(input: {
          companyUid: string;
          connectionId: string;
          granteeUid: string;
        }): Promise<Result<null>> {
          stateByConnection.set(input.connectionId, "shared-on");
          return { ok: true, value: null };
        },
        async revokeConnectionAccess(input: {
          companyUid: string;
          connectionId: string;
          granteeUid: string;
        }): Promise<Result<null>> {
          stateByConnection.set(input.connectionId, "shared-off");
          return { ok: true, value: null };
        },
      },
    };
  }

  const adapterAgent = makeAdapter();
  const adapterLocal = makeAdapter();
</script>

<div class="stage">
  <section class="card">
    <header>
      <h2>Agent profile</h2>
      <p class="muted">AgentDetailPanel · desktop.bot-integration-control-v1 on</p>
    </header>
    <div class="panel">
      <h3 class="ad-kicker">Apps</h3>
      <p class="ad-muted small">Company apps the agent can use.</p>
      <BotIntegrationsSection
        companyUid="cmp_acme"
        botUid="agt_nova"
        botRole="member"
        adapter={adapterAgent as unknown as never}
        flagEnabled={true}
      />
    </div>
  </section>

  <section class="card">
    <header>
      <h2>Local bot</h2>
      <p class="muted">LocalBotDetailPanel · desktop.bot-integration-control-v1 on</p>
    </header>
    <div class="panel">
      <h3 class="ad-kicker">Model</h3>
      <p class="ad-muted small">Claude Sonnet 4.6</p>
      <BotIntegrationsSection
        companyUid="cmp_acme"
        botUid="bot_atlas"
        botRole="member"
        adapter={adapterLocal as unknown as never}
        flagEnabled={true}
      />
    </div>
  </section>
</div>

<style>
  .stage {
    min-height: 100vh;
    padding: 24px;
    display: grid;
    gap: 24px;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    box-sizing: border-box;
    background: #171717;
    color: #e8e8e8;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .card {
    display: flex;
    flex-direction: column;
    background: #1f1f1f;
    border: 1px solid #2a2a2a;
    border-radius: 10px;
    overflow: hidden;
  }
  header {
    padding: 14px 18px 10px;
    border-bottom: 1px solid #2a2a2a;
  }
  h2 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    color: #d7d7d7;
  }
  .muted {
    margin: 2px 0 0;
    font-size: 11px;
    color: #8f8f8f;
  }
  .panel {
    padding: 16px 18px 20px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .panel :global(.ad-section) {
    padding-top: 6px;
    border-top: 1px solid #2a2a2a;
  }
  .panel :global(h3.ad-kicker) {
    margin: 0 0 4px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #a0a0a0;
  }
  .panel :global(.ad-muted) {
    color: #9a9a9a;
    font-size: 12px;
    margin: 0;
  }
  .panel :global(.small) {
    font-size: 11px;
  }
  .panel :global(.ad-rows) {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .panel :global(.ad-rows li) {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    column-gap: 12px;
    row-gap: 4px;
    padding: 8px 0;
    border-bottom: 1px solid #262626;
  }
  .panel :global(.ad-rows li:last-child) {
    border-bottom: 0;
  }
  .panel :global(.ad-row-title) {
    color: #e8e8e8;
    font-size: 13px;
  }
  .panel :global(.ad-row-meta) {
    color: #8f8f8f;
    font-size: 11px;
  }
</style>

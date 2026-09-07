<script lang="ts">
  /**
   * DEV-ONLY visual harness for the chat UI (reactions, reply threads,
   * attachments, paste/drop). Renders ChannelConversation + ReplyPanel with
   * injected mock data and a stub api — zero network. Guarded by `dev` so it
   * never ships: in production builds this route renders nothing.
   */
  import { dev } from "$app/environment";
  import {
    ArtifactPanel,
    ChannelConversation,
    ReplyPanel,
    type ChatArtifact,
  } from "@hq/ui";

  const now = Date.now();
  const iso = (minsAgo: number) =>
    new Date(now - minsAgo * 60_000).toISOString();

  const messages = [
    {
      eventId: "evt-1",
      fromDisplayName: "Yousuf Kalim",
      fromPersonUid: "prs_yousuf",
      body: "Hi — shipping the new build today.",
      createdAt: iso(60),
      direction: "in",
      replyCount: 2,
    },
    {
      eventId: "evt-2",
      fromDisplayName: "Jacob Posel",
      fromPersonUid: "prs_jacob",
      body: "Nice. Screenshot of the dashboard attached.",
      createdAt: iso(45),
      direction: "in",
      attachments: [
        {
          id: "att-1",
          vaultPath: "chat/attachments/chan/demo/pic.png",
          companyUid: "cmp_demo",
          name: "dashboard.png",
          contentType: "image/png",
          sizeBytes: 12345,
          kind: "image",
          previewUrl:
            "data:image/svg+xml;utf8," +
            encodeURIComponent(
              '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="280"><rect width="480" height="280" fill="%23272733"/><text x="24" y="150" fill="%23aab" font-family="sans-serif" font-size="22">mock dashboard.png</text></svg>',
            ),
        },
      ],
    },
    {
      eventId: "evt-3",
      fromDisplayName: "Corey Epstein",
      fromPersonUid: "prs_corey",
      body: "Looks great — reacting below 👇",
      createdAt: iso(5),
      direction: "out",
    },
    {
      eventId: "evt-4",
      fromDisplayName: "Corey Epstein",
      fromPersonUid: "prs_corey",
      body: "burst line two",
      createdAt: iso(4),
      direction: "out",
    },
    {
      eventId: "evt-5",
      fromDisplayName: "Corey Epstein",
      fromPersonUid: "prs_corey",
      body: "para one\n\npara two\n\n\npara three",
      createdAt: iso(3),
      direction: "out",
    },
    {
      eventId: "evt-6",
      fromDisplayName: "Yousuf Kalim",
      fromPersonUid: "prs_yousuf",
      body:
        "Backend fixes are landing in production now. Live so far: the durable scheduled-jobs fix, the Slack upgrade flow (the console's Migrate to Agents v2 card works again), and the presence-daemon install fix. Next deploy brings the rest of the restored settings, the disk alarm, and the v3 worker infra.",
      createdAt: iso(2),
      direction: "in",
    },
    {
      eventId: "evt-7",
      fromDisplayName: "Izzy",
      fromPersonUid: "agt_izzy",
      body:
        "Work Mesh Live: handoff attached. Two gaps are blocking signals — fixes are small. Full report in the details below.",
      createdAt: iso(1),
      direction: "in",
      details: [
        "# Work Mesh Live — engineering handoff (2026-09-07, 17:15 UTC)",
        "",
        "This document hands the Work Mesh Live project over for the next stretch of work. It covers what is deployed, what changed since the rollout, the current health, and an evidence-backed list of why work signals are still not showing up, with the fix for each gap. Everything referenced here is on `main` in its repo unless stated otherwise.",
        "",
        "## 1. Where things stand",
        "",
        "Rollout is complete on every surface and the presence layer is healthy:",
        "",
        "- **hq-pro production**: work-mesh routes, presence ingest, credential vend and alarms deployed and quiet (zero Lambda errors, hourly checks since 5 Sep).",
        "- **hq-cli 5.108.20** on 97 of 97 fleet daemons (5 boxes have no daemon unit because toolset delivery to them fails; see section 5).",
        "- Fleet daemons idle under 1 percent CPU; Indigo live view shows 26 to 29 agents online at every check.",
        "",
        "## 2. The two gaps",
        "",
        "1. The hq-pro register handler requires a `harness` field that the hq-cli outbox deliverer never sends, so every registration returns 400.",
        "2. On agent boxes the identity file is only consulted when `HQ_AGENT_IDENTITY_FILE` is set, so Codex sessions get no company and about 22,000 events sit held as NEEDS_COMPANY.",
        "",
        "> Suggested order: gap 1, gap 2, then the product decisions on person attribution.",
        "",
        "| Check | Command | Expected |",
        "| --- | --- | --- |",
        "| Session status | `hq mesh session status --company indigo` | bound |",
        "| Route health | CloudWatch Logs Insights on the prod vault-api log group | 2xx only |",
      ].join("\n"),
      prompt:
        "Read the Work Mesh Live handoff (2026-09-07) in HQ. Start with Gap 1 (add 'harness' to the hq-cli outbox register body or make hq-pro accept its absence; add a contract test posting the exact client body) and Gap 2 (default the agent identity path to /var/lib/hq-agent/identity.json when present and route the transcript watcher through the same company resolver as reconcile). Verify with: hq mesh session status --company indigo, and CloudWatch Logs Insights on the prod vault-api log group filtering routeKey like /work-mesh/ by status.",
    },
  ] as never[];

  let artifactOpen = $state<ChatArtifact | null>(null);

  const reactions = {
    "evt-1": [
      { emoji: "✅", count: 2, reactedByMe: true },
      { emoji: "🔥", count: 1, reactedByMe: false },
    ],
  };

  let replyOpenRoot = $state<string | null>("evt-1");

  const stubApi = {
    fetchReplyThread: async () => ({
      root: messages[0],
      replies: [
        {
          eventId: "evt-r1",
          fromDisplayName: "Izzy",
          fromPersonUid: "agt_izzy",
          body: "On it — build is green.",
          createdAt: iso(30),
          direction: "in",
          rootEventId: "evt-1",
        },
        {
          eventId: "evt-r2",
          fromDisplayName: "Corey Epstein",
          fromPersonUid: "prs_corey",
          body: "Perfect, thank you!",
          createdAt: iso(20),
          direction: "out",
          rootEventId: "evt-1",
        },
      ],
      replyCount: 2,
    }),
    sendReply: async () => ({}),
  } as never;
</script>

{#if dev}
  <div class="demo">
    <div class="demo-main">
      <ChannelConversation
        {messages}
        {reactions}
        placeholder="Message # demo — paste or drop an image here…"
        onsend={async () => {}}
        ontogglereaction={() => {}}
        onreply={(id) => {
          artifactOpen = null;
          replyOpenRoot = id;
        }}
        onopenartifact={(a) => {
          replyOpenRoot = null;
          artifactOpen = a;
        }}
      />
    </div>
    {#if artifactOpen}
      <div class="demo-side chat-shell">
        <ArtifactPanel artifact={artifactOpen} onclose={() => (artifactOpen = null)} />
      </div>
    {:else if replyOpenRoot}
      <div class="demo-side">
        <ReplyPanel
          api={stubApi}
          rootEventId={replyOpenRoot}
          scope="channel"
          channelId="chan-demo"
          seedRoot={messages[0]}
          selfDisplayName="Corey Epstein"
          onuploadfiles={async (files) =>
            files.map((file, i) => ({
              id: `demo-up-${i}`,
              vaultPath: `chat/attachments/chan/demo/${file.name}`,
              companyUid: "cmp_demo",
              name: file.name,
              contentType: file.type,
              sizeBytes: file.size,
              kind: file.type.startsWith("image/") ? "image" : "file",
              previewUrl: file.type.startsWith("image/")
                ? URL.createObjectURL(file)
                : null,
            }))}
          onclose={() => (replyOpenRoot = null)}
        />
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Dev harness only: load the same Geist faces the desktop window ships so
     the browser preview matches shipped rendering. */
  @font-face {
    font-family: "Geist";
    src: url("../../../../../sync/src/assets/fonts/geist-sans-400.woff2") format("woff2");
    font-weight: 400;
  }
  @font-face {
    font-family: "Geist";
    src: url("../../../../../sync/src/assets/fonts/geist-sans-500.woff2") format("woff2");
    font-weight: 500;
  }
  @font-face {
    font-family: "Geist";
    src: url("../../../../../sync/src/assets/fonts/geist-sans-600.woff2") format("woff2");
    font-weight: 600;
  }
  :global(body) {
    margin: 0;
    background: #101014;
    -webkit-font-smoothing: antialiased;
  }
  .demo {
    display: flex;
    height: 100vh;
  }
  .demo-main {
    flex: 1;
    display: flex;
    min-width: 0;
  }
  .demo-side {
    flex: 0 0 420px;
    border-left: 1px solid rgba(255, 255, 255, 0.08);
    display: flex;
    min-width: 0;
  }
</style>

<script lang="ts">
  /**
   * DEV-ONLY visual harness for the chat UI (reactions, reply threads,
   * attachments, paste/drop). Renders ChannelConversation + ReplyPanel with
   * injected mock data and a stub api — zero network. Guarded by `dev` so it
   * never ships: in production builds this route renders nothing.
   */
  import { dev } from "$app/environment";
  import { ChannelConversation, ReplyPanel } from "@hq/ui";

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
  ] as never[];

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
        onreply={(id) => (replyOpenRoot = id)}
      />
    </div>
    {#if replyOpenRoot}
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
  :global(body) {
    margin: 0;
    background: #101014;
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
    flex: 0 0 360px;
    display: flex;
    min-width: 0;
  }
</style>

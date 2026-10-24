<script lang="ts">
  // Test support for ChatSidebar.filter-popover.test.ts: the rail and an open
  // conversation reading the shared message-types store, the way DesktopApp
  // wires them, so a switch in the popover re-filters the timeline live.
  import ChatSidebar from "./ChatSidebar.svelte";
  import ConversationView from "./ConversationView.svelte";
  import type { ChatSidebarApi, ConversationApi } from "./chat-api";
  import type { ChannelDirectoryRow } from "./channel-directory-reconciler";
  import type { ConversationRow } from "./sidebar-model";
  import { messageTypesStore } from "./message-types.svelte.js";

  interface Props {
    api: ChatSidebarApi;
    seedDirectory: ChannelDirectoryRow[];
    conversationApi: ConversationApi;
    row: ConversationRow;
  }

  let { api, seedDirectory, conversationApi, row }: Props = $props();
</script>

<ChatSidebar {api} {seedDirectory} />
<ConversationView api={conversationApi} {row} messageTypes={messageTypesStore.value} />

<script lang="ts">
  import ChannelFilesTab from "./ChannelFilesTab.svelte";
  import type { ChannelFileItemModel, ChannelFilePreview } from "./channelTabModels";

  interface Props {
    onloadpreview: (item: ChannelFileItemModel) => Promise<ChannelFilePreview>;
  }

  let { onloadpreview }: Props = $props();
  let files = $state<ChannelFileItemModel[]>([]);
  let previewContext = $state<string | null>(null);

  export function replaceFiles(next: ChannelFileItemModel[]): void {
    files = next;
  }

  export function replacePreviewContext(next: string | null): void {
    previewContext = next;
  }
</script>

<ChannelFilesTab {files} {previewContext} {onloadpreview} />

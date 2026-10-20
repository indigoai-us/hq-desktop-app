<script lang="ts">
  /**
   * Preview of a DM thread where one person shares several folders in a row
   * (?view=share-stack). The shares fold into one stacked card; the handoff
   * prompt between them starts a new stack. Fictional names, zero network.
   */
  import { ChannelConversation, type ConversationMessageWire } from '@hq/ui';

  const from = { fromPersonUid: 'prs_maya', fromDisplayName: 'Maya Chen', direction: 'in' };
  const at = (min: number, sec: number) => new Date(Date.UTC(2026, 9, 14, 15, min, sec)).toISOString();
  const share = (id: string, path: string, createdAt: string): ConversationMessageWire => ({
    ...from,
    eventId: id,
    body: 'Shared a folder with you.',
    createdAt,
    attachments: [{ name: path.split('/').filter(Boolean).pop() ?? path, kind: 'folder', vaultPath: path }],
  });

  const messages: ConversationMessageWire[] = [
    { ...from, eventId: 'p0', body: 'Morning! Sending over the storage projects now.', createdAt: at(10, 0) },
    share('s1', 'projects/asset-library/', at(11, 50)),
    share('s2', 'projects/asset-library/research/', at(12, 3)),
    share('s3', 'projects/cold-storage-placeholders/', at(12, 16)),
    {
      ...from,
      eventId: 'h1',
      body: 'Maya handed you the asset library project.',
      prompt: 'TITLE: Project handoff: asset-library\nPick up the asset library project from its README.',
      createdAt: at(14, 5),
    },
    share('s4', 'projects/box-size-billing-tiers/', at(18, 17)),
    share('s5', 'projects/tier-upgrades/', at(18, 30)),
    share('s6', 'projects/billing-outpost-compute/', at(18, 43)),
    share('s7', 'projects/outpost-autoscale/', at(18, 56)),
    share('s8', 'projects/outpost-box-resizing/', at(19, 7)),
    share('s9', 'projects/outpost-storage-autoscale/', at(19, 18)),
    share('s10', 'projects/onboarding-checklist/', at(40, 0)),
  ];
</script>

<div class="share-stack-stage" data-window="messages">
  <ChannelConversation {messages} channelId="dm_preview" onsend={() => {}} />
</div>

<style>
  .share-stack-stage {
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--bg, #141416);
    color: var(--t1, #eee);
  }
</style>

<script lang="ts">
  /**
   * Design-harness fixture for the Forward dialog (?view=forward). Fictional
   * people and companies; nothing here reaches the network. The chat tokens
   * ship with the picker's own stylesheet, so the backdrop only needs the
   * `chat-shell` scope class for --t1/--line/--font-ui.
   */
  import ForwardPicker from '../../../packages/ui/src/chat/messaging/ForwardPicker.svelte';
  import '../../../packages/ui/src/chat/chat-tokens.css';
  import type { ForwardRequest, ForwardResult, ForwardSource } from '../../../packages/ui/src/chat/messaging/forward-model';

  const now = Date.now();
  const source: ForwardSource = {
    conversationId: 'ch_welcome',
    eventId: 'evt_1',
    companyUid: 'cmp_acme',
    senderName: 'Priya Natarajan',
    senderUid: 'prs_priya',
    createdAt: new Date(now - 42 * 60_000).toISOString(),
    origin: { kind: 'channel', label: 'welcome' },
    body: 'Can someone add rowan@example.com to TestFlight for the iOS build? They start Monday.',
    attachmentCount: 1,
    attachmentNames: ['onboarding-checklist.pdf'],
  };
  const rows = [
    { id: 'ch:ch_welcome', kind: 'channel', title: 'welcome', channelId: 'ch_welcome', companyUid: 'cmp_acme', lastActivityAt: now - 40 * 60_000 },
    { id: 'dm:prs_sam', kind: 'dm', title: 'Sam Okafor', personUid: 'prs_sam', companyUid: 'cmp_acme', lastActivityAt: now - 2 * 3_600_000 },
    { id: 'dm:agt_scout', kind: 'dm', title: 'Scout', personUid: 'agt_scout', companyUid: 'cmp_acme', lastActivityAt: now - 5 * 3_600_000 },
    { id: 'ch:ch_eng', kind: 'channel', title: 'engineering', channelId: 'ch_eng', companyUid: 'cmp_acme', lastActivityAt: now - 26 * 3_600_000 },
    { id: 'ch:ch_design', kind: 'channel', title: 'design', channelId: 'ch_design', companyUid: 'cmp_acme', lastActivityAt: 0 },
    { id: 'dm:prs_lena', kind: 'dm', title: 'Lena Fischer', personUid: 'prs_lena', companyUid: 'cmp_acme', lastActivityAt: now - 3 * 86_400_000 },
  ].map((r) => ({ unreadDot: false, pinned: false, ...r })) as never;
  const contacts = [
    { participantUid: 'prs_mateo', participantType: 'human', displayName: 'Mateo Ruiz', email: 'mateo@example.com', companyUid: 'cmp_acme' },
    { participantUid: 'prs_yuki', participantType: 'human', displayName: 'Yuki Tanaka', email: 'yuki@example.com', companyUid: 'cmp_acme' },
    { participantUid: 'agt_ledger', participantType: 'agent', displayName: 'Ledger', companyUid: 'cmp_acme' },
  ] as never;
  const adminCompanies = [
    { uid: 'cmp_acme', name: 'Acme' },
    { uid: 'cmp_beta', name: 'Beta Labs' },
  ];
  async function onsend(_req: ForwardRequest): Promise<ForwardResult> {
    await new Promise((r) => setTimeout(r, 400));
    return { ok: true, omittedAttachments: 0 };
  }
</script>

<div class="chat-shell forward-preview-ground">
  <ForwardPicker
    {source}
    {rows}
    {contacts}
    {adminCompanies}
    {onsend}
    onclose={() => {}}
    ondone={(name) => console.log('[harness] forwarded to', name)}
  />
</div>

<style>
  .forward-preview-ground {
    min-height: 100vh;
    background: #151519;
    font-family: var(--font-ui);
  }
</style>

<script lang="ts">
  // Rooms (hq-rooms) — shared human+agent channels as a first-class desktop
  // destination. Hosts the full MessagesShell (rail + conversation + thread
  // panel): the shell owns its own data plumbing (channel list, DMs, realtime
  // listeners, unread state), so this page is intentionally a thin mount —
  // the same posture InboxPage takes over NotificationFeed.
  //
  // History note: MessagesShell previously mounted only in the retired
  // standalone `messages` window (deleted in US-008) and the browser design
  // harness — the entire rooms surface was unreachable in the shipped app.
  // This page is its production mount point.
  import MessagesShell from '../../components/messaging/MessagesShell.svelte';
  import '../v4/tokens.css';
</script>

<div class="rooms-page">
  <MessagesShell />
</div>

<style>
  /* Full-bleed host: the shell manages its own rail/pane/thread columns and
     internal scrolling, so this container just hands it the whole content
     area (mirrors .files-main — no .page padding, no outer scroll). */
  .rooms-page {
    display: flex;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
  }
</style>
